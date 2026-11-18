import '../../lib/db-types.js';
// Stock takes: snapshot what the system thinks is in a store, count it, submit, and have someone
// else approve. Approval posts each variance (counted − snapshot) to the ledger as a 'stocktake'
// movement, so stock that moved during the count is not double-counted.
// Also: writing off expired stock (it is already quarantined; this removes it from the shelf).
import { fromMilli, todayNairobi, toMilli } from '@afyazuri/shared';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { nextDocNumber } from '../../lib/sequences.js';
import { recordAudit } from '../audit/service.js';
import { actorOf, facilityOf, storeFor } from './service.js';
import { moveStock } from './stock.js';

/**
 * @typedef {import('../../middleware/auth.js').AuthContext} AuthContext
 * @typedef {{ip?: string|null, userAgent?: string|null, requestId?: string|null}} Meta
 * @typedef {{db: import('knex').Knex}} Deps
 */

const q3 = (v) => (v === null || v === undefined ? null : fromMilli(toMilli(v)));

async function lockTake(trx, auth, id) {
  const t = await trx('stock_takes')
    .where({ id, facility_id: facilityOf(auth) })
    .forUpdate()
    .first();
  if (!t) throw notFound('Stock take');
  return t;
}

/** Start a count: snapshot every batch with stock in the store. @param {Deps} deps @param {AuthContext} auth */
export async function startStockTake({ db }, auth, input, meta) {
  const id = await db.transaction(async (trx) => {
    const store = await storeFor(trx, auth, input.storeId, 'inventory.stocktake.perform');
    if (await trx('stock_takes').where({ store_id: store.id }).whereIn('status', ['counting', 'submitted']).first('id'))
      throw conflict(`${store.name} already has a count in progress`);
    const [t] = await trx('stock_takes')
      .insert({
        facility_id: store.facility_id,
        st_number: await nextDocNumber(trx, store.facility_id, 'ST'),
        store_id: store.id,
        notes: input.notes ?? null,
        started_by: auth.userId,
        created_by: auth.userId,
        updated_by: auth.userId,
      })
      .returning('*');
    await trx.raw(
      `INSERT INTO stock_take_lines (stock_take_id, item_id, batch_id, system_qty, unit_cost)
       SELECT ?, l.item_id, l.batch_id, l.quantity, i.average_cost
       FROM stock_levels l JOIN items i ON i.id = l.item_id
       WHERE l.store_id = ? AND l.quantity > 0`,
      [t.id, store.id],
    );
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'create',
      entityType: 'stock_take',
      entityId: t.id,
      after: t,
    });
    return t.id;
  });
  return getStockTake({ db }, auth, id);
}

/** Record counts (any number of times while counting). */
export async function recordCounts({ db }, auth, id, input, meta) {
  await db.transaction(async (trx) => {
    const t = await lockTake(trx, auth, id);
    if (t.status !== 'counting') throw conflict(`This count is ${t.status}`);
    await storeFor(trx, auth, t.store_id, 'inventory.stocktake.perform');
    const lines = await trx('stock_take_lines')
      .where({ stock_take_id: id })
      .whereIn(
        'id',
        input.lines.map((l) => l.lineId),
      );
    if (lines.length !== new Set(input.lines.map((l) => l.lineId)).size)
      throw badRequest('Some lines are not on this count');
    for (const l of input.lines)
      await trx('stock_take_lines')
        .where({ id: l.lineId })
        .update({
          counted_qty: l.countedQty,
          reason: l.reason ?? null,
          counted_by: auth.userId,
          counted_at: trx.fn.now(),
        });
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'stock_take',
      entityId: id,
      metadata: { counted: input.lines.length },
    });
  });
  return getStockTake({ db }, auth, id);
}

/** Submit for approval: every line counted, and every variance explained. */
export async function submitStockTake({ db }, auth, id, meta) {
  await db.transaction(async (trx) => {
    const t = await lockTake(trx, auth, id);
    if (t.status !== 'counting') throw conflict(`This count is ${t.status}`);
    await storeFor(trx, auth, t.store_id, 'inventory.stocktake.perform');
    const lines = await trx('stock_take_lines').where({ stock_take_id: id });
    const uncounted = lines.filter((l) => l.counted_qty === null).length;
    if (uncounted) throw new AppError(409, 'COUNT_INCOMPLETE', `${uncounted} line(s) are not counted yet`);
    const unexplained = lines.filter((l) => toMilli(l.counted_qty) !== toMilli(l.system_qty) && !l.reason).length;
    if (unexplained) throw new AppError(409, 'VARIANCE_UNEXPLAINED', `Give a reason for ${unexplained} variance(s)`);
    const [after] = await trx('stock_takes')
      .where({ id })
      .update({ status: 'submitted', submitted_by: auth.userId, submitted_at: trx.fn.now(), updated_by: auth.userId })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'stock_take',
      entityId: id,
      before: t,
      after,
    });
  });
  return getStockTake({ db }, auth, id);
}

/**
 * Approve (post the variances) or reject (discard the count). Never by anyone who started,
 * submitted or counted it.
 */
export async function decideStockTake({ db }, auth, id, input, meta) {
  await db.transaction(async (trx) => {
    const t = await lockTake(trx, auth, id);
    if (t.status !== 'submitted') throw conflict(`This count is ${t.status}`);
    await storeFor(trx, auth, t.store_id, 'inventory.stocktake.approve');
    const lines = await trx('stock_take_lines').where({ stock_take_id: id });
    const counters = new Set([t.started_by, t.submitted_by, ...lines.map((l) => l.counted_by)]);
    if (counters.has(auth.userId))
      throw new AppError(403, 'SELF_APPROVAL', 'Someone who did not take part in the count must approve it.');
    if (input.approve)
      for (const l of lines) {
        const delta = toMilli(l.counted_qty) - toMilli(l.system_qty);
        if (delta === 0) continue;
        try {
          await moveStock(trx, {
            facilityId: t.facility_id,
            storeId: t.store_id,
            itemId: l.item_id,
            batchId: l.batch_id,
            quantity: delta / 1000,
            type: 'stocktake',
            unitCost: l.unit_cost,
            referenceType: 'stock_take',
            referenceId: id,
            reason: l.reason,
            userId: auth.userId,
          });
        } catch (err) {
          if (err.code === 'INSUFFICIENT_STOCK')
            throw new AppError(409, 'STOCK_MOVED', 'Stock left the shelf since the count started; reject and recount.');
          throw err;
        }
      }
    const [after] = await trx('stock_takes')
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
      entityType: 'stock_take',
      entityId: id,
      before: t,
      after,
      reason: input.note ?? undefined,
    });
  });
  return getStockTake({ db }, auth, id);
}

/** Abandon a count before it is approved (by someone who may count in that store). */
export async function cancelStockTake({ db }, auth, id, meta) {
  await db.transaction(async (trx) => {
    const t = await lockTake(trx, auth, id);
    if (!['counting', 'submitted'].includes(t.status)) throw conflict(`This count is ${t.status}`);
    await storeFor(trx, auth, t.store_id, 'inventory.stocktake.perform');
    const [after] = await trx('stock_takes')
      .where({ id })
      .update({ status: 'cancelled', updated_by: auth.userId })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'stock_take',
      entityId: id,
      before: t,
      after,
    });
  });
  return getStockTake({ db }, auth, id);
}

const header = (t) => ({
  id: t.id,
  stNumber: t.st_number,
  storeId: t.store_id,
  store: t.store,
  status: t.status,
  notes: t.notes,
  startedBy: t.started_by_name,
  startedById: t.started_by,
  startedAt: t.started_at,
  submittedBy: t.submitted_by_name ?? null,
  submittedAt: t.submitted_at,
  decidedBy: t.decided_by_name ?? null,
  decidedAt: t.decided_at,
  decisionNote: t.decision_note,
});
const base = (db) =>
  db('stock_takes as t')
    .join('stores as s', 's.id', 't.store_id')
    .join('users as a', 'a.id', 't.started_by')
    .leftJoin('users as b', 'b.id', 't.submitted_by')
    .leftJoin('users as c', 'c.id', 't.decided_by')
    .select(
      't.*',
      's.name as store',
      'a.full_name as started_by_name',
      'b.full_name as submitted_by_name',
      'c.full_name as decided_by_name',
    );

/** @param {Deps} deps @param {AuthContext} auth @param {string} id */
export async function getStockTake({ db }, auth, id) {
  const t = await base(db)
    .where({ 't.id': id, 't.facility_id': facilityOf(auth) })
    .first();
  if (!t) throw notFound('Stock take');
  const today = todayNairobi();
  const lines = await db('stock_take_lines as l')
    .join('items as i', 'i.id', 'l.item_id')
    .join('item_batches as b', 'b.id', 'l.batch_id')
    .leftJoin('users as u', 'u.id', 'l.counted_by')
    .where('l.stock_take_id', id)
    .orderBy(['i.name', 'b.expiry_date'])
    .select(
      'l.*',
      'i.name',
      'i.code',
      'i.base_unit',
      'b.batch_number',
      'b.expiry_date',
      'u.full_name as counted_by_name',
    );
  let gain = 0;
  let loss = 0;
  const out = lines.map((l) => {
    const variance = l.counted_qty === null ? null : toMilli(l.counted_qty) - toMilli(l.system_qty);
    const value = variance === null ? 0 : (variance / 1000) * Number(l.unit_cost);
    if (value > 0) gain += value;
    else loss -= value;
    return {
      id: l.id,
      itemId: l.item_id,
      code: l.code,
      name: l.name,
      baseUnit: l.base_unit,
      batchNumber: l.batch_number,
      expiryDate: l.expiry_date,
      expired: l.expiry_date < today,
      systemQty: q3(l.system_qty),
      countedQty: q3(l.counted_qty),
      variance: variance === null ? null : fromMilli(variance),
      varianceValue: value.toFixed(2),
      reason: l.reason,
      countedBy: l.counted_by_name,
      countedById: l.counted_by,
    };
  });
  return {
    ...header(t),
    lines: out,
    counted: out.filter((l) => l.countedQty !== null).length,
    gainValue: gain.toFixed(2),
    lossValue: loss.toFixed(2),
  };
}

/** @param {Deps} deps @param {AuthContext} auth @param {{storeId?: string, status?: string}} q */
export async function listStockTakes({ db }, auth, q = {}) {
  const rows = await base(db)
    .where('t.facility_id', facilityOf(auth))
    .modify((x) => {
      if (q.storeId) x.andWhere('t.store_id', q.storeId);
      if (q.status) x.andWhere('t.status', q.status);
    })
    .orderBy('t.started_at', 'desc')
    .limit(100);
  return rows.map(header);
}

/**
 * Remove an expired batch from the shelf ('expiry_writeoff'). Only expired stock; the whole
 * remaining quantity of that batch in the store.
 * @param {Deps} deps @param {AuthContext} auth @param {string} storeId @param {{batchId: string, reason: string}} input @param {Meta} meta
 */
export async function writeOffExpired({ db }, auth, storeId, input, meta) {
  return db.transaction(async (trx) => {
    const store = await storeFor(trx, auth, storeId, 'inventory.stocktake.perform');
    const batch = await trx('item_batches').where({ id: input.batchId, facility_id: store.facility_id }).first();
    if (!batch) throw notFound('Batch');
    if (batch.expiry_date >= todayNairobi())
      throw conflict('This batch has not expired; only expired stock is written off here');
    const level = await trx('stock_levels').where({ store_id: store.id, batch_id: batch.id }).first('quantity');
    if (!level || toMilli(level.quantity) === 0) throw conflict('None of this batch is left in the store');
    const qty = Number(level.quantity);
    await moveStock(trx, {
      facilityId: store.facility_id,
      storeId: store.id,
      itemId: batch.item_id,
      batchId: batch.id,
      quantity: -qty,
      type: 'expiry_writeoff',
      unitCost: batch.unit_cost,
      referenceType: 'batch',
      referenceId: batch.id,
      reason: input.reason,
      userId: auth.userId,
    });
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'item_batch',
      entityId: batch.id,
      reason: input.reason,
      metadata: { writeOff: q3(qty), store: store.code, batchNumber: batch.batch_number },
    });
    return { batchId: batch.id, writtenOff: q3(qty), value: (qty * Number(batch.unit_cost)).toFixed(2) };
  });
}
