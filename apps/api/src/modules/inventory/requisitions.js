import '../../lib/db-types.js';
// Internal requisitions: a store asks another (usually the main store) for stock.
//   requested → approved (the supplying store may cut quantities; never by the requester)
//             → issued   (FEFO batches leave the supplying store: 'issue_out')
//             → received (the requesting store counts what arrived: 'issue_in'; any shortfall
//                         needs a reason and stays recorded against the batch)
import { fromMilli, toMilli } from '@afyazuri/shared';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { nextDocNumber } from '../../lib/sequences.js';
import { recordAudit } from '../audit/service.js';
import { actorOf, facilityOf, storeFor } from './service.js';
import { allocateFefo, moveStock } from './stock.js';

/**
 * @typedef {import('../../middleware/auth.js').AuthContext} AuthContext
 * @typedef {{ip?: string|null, userAgent?: string|null, requestId?: string|null}} Meta
 * @typedef {{db: import('knex').Knex, bus: import('../../lib/events.js').EventBus}} Deps
 */

const q3 = (v) => (v === null || v === undefined ? null : fromMilli(toMilli(v)));

async function lockRequisition(trx, auth, id) {
  const r = await trx('requisitions')
    .where({ id, facility_id: facilityOf(auth) })
    .forUpdate()
    .first();
  if (!r) throw notFound('Requisition');
  return r;
}
const expect = (r, ...statuses) => {
  if (!statuses.includes(r.status)) throw conflict(`This requisition is ${r.status}`);
};

/** @param {Deps} deps @param {AuthContext} auth @param {any} input @param {Meta} meta */
export async function createRequisition({ db }, auth, input, meta) {
  const id = await db.transaction(async (trx) => {
    const from = await storeFor(trx, auth, input.fromStoreId, 'inventory.requisition.create');
    const to = await trx('stores').where({ id: input.toStoreId, facility_id: from.facility_id, active: true }).first();
    if (!to) throw badRequest('Choose an open store at this facility to request from');
    const items = await trx('items')
      .whereIn(
        'id',
        input.lines.map((l) => l.itemId),
      )
      .andWhere({ facility_id: from.facility_id, active: true });
    if (items.length !== input.lines.length) throw badRequest('Some items are not active items at this facility');
    const [r] = await trx('requisitions')
      .insert({
        facility_id: from.facility_id,
        req_number: await nextDocNumber(trx, from.facility_id, 'REQ'),
        from_store_id: from.id,
        to_store_id: to.id,
        notes: input.notes ?? null,
        requested_by: auth.userId,
        created_by: auth.userId,
        updated_by: auth.userId,
      })
      .returning('*');
    await trx('requisition_items').insert(
      input.lines.map((l) => ({ requisition_id: r.id, item_id: l.itemId, requested_qty: l.quantity })),
    );
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'create',
      entityType: 'requisition',
      entityId: r.id,
      after: { ...r, lines: input.lines },
    });
    return r.id;
  });
  return getRequisition({ db }, auth, id);
}

/**
 * Approve (optionally cutting quantities) or reject. Done by the supplying store; never by the requester.
 * @param {Deps} deps @param {AuthContext} auth @param {string} id @param {any} input @param {Meta} meta
 */
export async function decideRequisition({ db }, auth, id, input, meta) {
  await db.transaction(async (trx) => {
    const before = await lockRequisition(trx, auth, id);
    expect(before, 'requested');
    await storeFor(trx, auth, before.to_store_id, 'inventory.requisition.approve');
    if (before.requested_by === auth.userId)
      throw new AppError(403, 'SELF_APPROVAL', 'Someone else must approve this: you raised the requisition.');
    const lines = await trx('requisition_items').where({ requisition_id: id }).forUpdate();
    if (input.approve) {
      const cut = new Map(input.lines.map((l) => [l.itemId, l.approvedQty]));
      for (const itemId of cut.keys())
        if (!lines.some((l) => l.item_id === itemId)) throw badRequest('That item is not on this requisition');
      let any = false;
      for (const l of lines) {
        const qty = cut.has(l.item_id) ? cut.get(l.item_id) : Number(l.requested_qty);
        if (toMilli(qty) > toMilli(l.requested_qty))
          throw badRequest('You can approve less than was requested, not more');
        if (toMilli(qty) > 0) any = true;
        await trx('requisition_items').where({ id: l.id }).update({ approved_qty: qty });
      }
      if (!any) throw badRequest('Approve at least one item, or reject the requisition');
    }
    const [after] = await trx('requisitions')
      .where({ id })
      .update({
        status: input.approve ? 'approved' : 'rejected',
        decided_by: auth.userId,
        decided_at: trx.fn.now(),
        decision_note: input.note ?? null,
        updated_by: auth.userId,
      })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: input.approve ? 'approve' : 'reject',
      entityType: 'requisition',
      entityId: id,
      before,
      after,
      reason: input.note ?? undefined,
    });
  });
  return getRequisition({ db }, auth, id);
}

/**
 * Issue an approved requisition from the supplying store, first-expiry-first-out. Issues what is
 * in date up to the approved quantity (a short issue shows on the requisition).
 * @param {Deps} deps @param {AuthContext} auth @param {string} id @param {Meta} meta
 */
export async function issueRequisition({ db }, auth, id, meta) {
  await db.transaction(async (trx) => {
    const r = await lockRequisition(trx, auth, id);
    expect(r, 'approved');
    const store = await storeFor(trx, auth, r.to_store_id, 'inventory.issue');
    const lines = await trx('requisition_items').where({ requisition_id: id }).forUpdate();
    let issuedAny = false;
    for (const l of lines) {
      if (!l.approved_qty || toMilli(l.approved_qty) === 0) continue;
      let picks;
      try {
        picks = await allocateFefo(trx, { storeId: store.id, itemId: l.item_id, quantity: Number(l.approved_qty) });
      } catch (err) {
        if (err.code !== 'INSUFFICIENT_STOCK' || toMilli(err.details.available) === 0) {
          if (err.code === 'INSUFFICIENT_STOCK') continue; // nothing in date: issue none of this item
          throw err;
        }
        picks = await allocateFefo(trx, {
          storeId: store.id,
          itemId: l.item_id,
          quantity: Number(err.details.available),
        });
      }
      let issued = 0;
      for (const p of picks) {
        await moveStock(trx, {
          facilityId: r.facility_id,
          storeId: store.id,
          itemId: l.item_id,
          batchId: p.batchId,
          quantity: -p.quantity,
          type: 'issue_out',
          unitCost: p.unitCost,
          referenceType: 'requisition',
          referenceId: id,
          userId: auth.userId,
        });
        await trx('requisition_issue_lines').insert({
          requisition_id: id,
          requisition_item_id: l.id,
          item_id: l.item_id,
          batch_id: p.batchId,
          quantity: p.quantity,
          unit_cost: p.unitCost,
        });
        issued += toMilli(p.quantity);
      }
      if (issued > 0) issuedAny = true;
      await trx('requisition_items')
        .where({ id: l.id })
        .update({ issued_qty: fromMilli(issued) });
    }
    if (!issuedAny) throw new AppError(409, 'INSUFFICIENT_STOCK', `${store.name} has none of these items in date`);
    const [after] = await trx('requisitions')
      .where({ id })
      .update({ status: 'issued', issued_by: auth.userId, issued_at: trx.fn.now(), updated_by: auth.userId })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'requisition',
      entityId: id,
      before: r,
      after,
      metadata: { issued: true },
    });
  });
  return getRequisition({ db }, auth, id);
}

/**
 * The requesting store records what arrived, batch by batch. A shortfall needs a reason; the
 * missing stock has already left the supplying store, so the variance stays on record.
 * @param {Deps} deps @param {AuthContext} auth @param {string} id @param {any} input @param {Meta} meta
 */
export async function receiveRequisition({ db }, auth, id, input, meta) {
  await db.transaction(async (trx) => {
    const r = await lockRequisition(trx, auth, id);
    expect(r, 'issued');
    const store = await storeFor(trx, auth, r.from_store_id, 'inventory.receive');
    const issueLines = await trx('requisition_issue_lines').where({ requisition_id: id }).forUpdate();
    const given = new Map(input.lines.map((l) => [l.issueLineId, l]));
    const issues = [];
    if (given.size !== input.lines.length) issues.push({ path: 'lines', message: 'Each batch once' });
    for (const il of issueLines)
      if (!given.has(il.id)) issues.push({ path: 'lines', message: 'Record what arrived for every batch issued' });
    for (const [n, l] of input.lines.entries()) {
      const il = issueLines.find((x) => x.id === l.issueLineId);
      if (!il) issues.push({ path: `lines.${n}.issueLineId`, message: 'Not a batch issued on this requisition' });
      else if (toMilli(l.receivedQty) > toMilli(il.quantity))
        issues.push({ path: `lines.${n}.receivedQty`, message: `Only ${q3(il.quantity)} was issued` });
      else if (toMilli(l.receivedQty) < toMilli(il.quantity) && !l.varianceReason)
        issues.push({ path: `lines.${n}.varianceReason`, message: 'Say why less arrived than was issued' });
    }
    if (issues.length)
      throw new AppError(400, 'VALIDATION_FAILED', 'Check what arrived', { issues: issues.slice(0, 20) });

    const received = new Map();
    for (const il of issueLines) {
      const l = given.get(il.id);
      await trx('requisition_issue_lines')
        .where({ id: il.id })
        .update({
          received_qty: l.receivedQty,
          variance_reason: toMilli(l.receivedQty) < toMilli(il.quantity) ? l.varianceReason : null,
        });
      if (toMilli(l.receivedQty) > 0)
        await moveStock(trx, {
          facilityId: r.facility_id,
          storeId: store.id,
          itemId: il.item_id,
          batchId: il.batch_id,
          quantity: l.receivedQty,
          type: 'issue_in',
          unitCost: il.unit_cost,
          referenceType: 'requisition',
          referenceId: id,
          reason:
            toMilli(l.receivedQty) < toMilli(il.quantity)
              ? `Short by ${fromMilli(toMilli(il.quantity) - toMilli(l.receivedQty))}: ${l.varianceReason}`
              : null,
          userId: auth.userId,
        });
      received.set(il.requisition_item_id, (received.get(il.requisition_item_id) ?? 0) + toMilli(l.receivedQty));
    }
    for (const [itemLineId, m] of received)
      await trx('requisition_items')
        .where({ id: itemLineId })
        .update({ received_qty: fromMilli(m) });
    const [after] = await trx('requisitions')
      .where({ id })
      .update({ status: 'received', received_by: auth.userId, received_at: trx.fn.now(), updated_by: auth.userId })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'requisition',
      entityId: id,
      before: r,
      after,
      metadata: { variances: input.lines.filter((l) => l.varianceReason).length },
    });
  });
  return getRequisition({ db }, auth, id);
}

/** The requester (or anyone who can raise requisitions for that store) may cancel before issue. */
export async function cancelRequisition({ db }, auth, id, meta) {
  await db.transaction(async (trx) => {
    const r = await lockRequisition(trx, auth, id);
    expect(r, 'requested', 'approved');
    await storeFor(trx, auth, r.from_store_id, 'inventory.requisition.create');
    const [after] = await trx('requisitions')
      .where({ id })
      .update({ status: 'cancelled', updated_by: auth.userId })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'requisition',
      entityId: id,
      before: r,
      after,
    });
  });
  return getRequisition({ db }, auth, id);
}

const base = (db) =>
  db('requisitions as r')
    .join('stores as f', 'f.id', 'r.from_store_id')
    .join('stores as t', 't.id', 'r.to_store_id')
    .join('users as rq', 'rq.id', 'r.requested_by')
    .leftJoin('users as d', 'd.id', 'r.decided_by')
    .leftJoin('users as i', 'i.id', 'r.issued_by')
    .leftJoin('users as rc', 'rc.id', 'r.received_by')
    .select(
      'r.*',
      'f.name as from_store',
      't.name as to_store',
      'rq.full_name as requested_by_name',
      'd.full_name as decided_by_name',
      'i.full_name as issued_by_name',
      'rc.full_name as received_by_name',
    );

const toHeader = (r) => ({
  id: r.id,
  reqNumber: r.req_number,
  status: r.status,
  fromStoreId: r.from_store_id,
  fromStore: r.from_store,
  toStoreId: r.to_store_id,
  toStore: r.to_store,
  notes: r.notes,
  requestedBy: r.requested_by_name,
  requestedById: r.requested_by,
  requestedAt: r.requested_at,
  decidedBy: r.decided_by_name,
  decidedAt: r.decided_at,
  decisionNote: r.decision_note,
  issuedBy: r.issued_by_name,
  issuedAt: r.issued_at,
  receivedBy: r.received_by_name,
  receivedAt: r.received_at,
});

/** @param {Deps} deps @param {AuthContext} auth @param {string} id */
export async function getRequisition({ db }, auth, id) {
  const r = await base(db)
    .where({ 'r.id': id, 'r.facility_id': facilityOf(auth) })
    .first();
  if (!r) throw notFound('Requisition');
  const [lines, issued] = await Promise.all([
    db('requisition_items as l')
      .join('items as it', 'it.id', 'l.item_id')
      .where('l.requisition_id', id)
      .orderBy('it.name')
      .select('l.*', 'it.name', 'it.code', 'it.base_unit'),
    db('requisition_issue_lines as x')
      .join('item_batches as b', 'b.id', 'x.batch_id')
      .join('items as it', 'it.id', 'x.item_id')
      .where('x.requisition_id', id)
      .orderBy(['it.name', 'b.expiry_date'])
      .select('x.*', 'b.batch_number', 'b.expiry_date', 'it.name'),
  ]);
  return {
    ...toHeader(r),
    lines: lines.map((l) => ({
      id: l.id,
      itemId: l.item_id,
      code: l.code,
      name: l.name,
      baseUnit: l.base_unit,
      requestedQty: q3(l.requested_qty),
      approvedQty: q3(l.approved_qty),
      issuedQty: q3(l.issued_qty),
      receivedQty: q3(l.received_qty),
    })),
    issued: issued.map((x) => ({
      id: x.id,
      itemId: x.item_id,
      name: x.name,
      batchNumber: x.batch_number,
      expiryDate: x.expiry_date,
      quantity: q3(x.quantity),
      receivedQty: q3(x.received_qty),
      varianceReason: x.variance_reason,
    })),
  };
}

/** @param {Deps} deps @param {AuthContext} auth @param {{status?: string, storeId?: string}} q */
export async function listRequisitions({ db }, auth, q) {
  const rows = await base(db)
    .where('r.facility_id', facilityOf(auth))
    .modify((x) => {
      if (q.status) x.andWhere('r.status', q.status);
      if (q.storeId) x.andWhere((w) => w.where('r.from_store_id', q.storeId).orWhere('r.to_store_id', q.storeId));
    })
    .orderBy('r.requested_at', 'desc')
    .limit(200);
  return rows.map(toHeader);
}
