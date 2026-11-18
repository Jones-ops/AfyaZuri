import '../../lib/db-types.js';
// Purchase orders and goods received notes. A GRN brings stock in: batch and expiry are captured,
// the weighted average cost is updated and each line writes a 'grn' movement, all in one
// transaction. Receiving against an order can never exceed what was ordered.
import { fromCents, fromMilli, todayNairobi, toCents, toMilli } from '@afyazuri/shared';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { nextDocNumber } from '../../lib/sequences.js';
import { recordAudit } from '../audit/service.js';
import { actorOf, facilityOf, storeFor } from './service.js';
import { moveStock, updateAverageCost } from './stock.js';

/**
 * @typedef {import('../../middleware/auth.js').AuthContext} AuthContext
 * @typedef {{ip?: string|null, userAgent?: string|null, requestId?: string|null}} Meta
 * @typedef {{db: import('knex').Knex, bus: import('../../lib/events.js').EventBus}} Deps
 */

const q3 = (v) => fromMilli(toMilli(v ?? 0));
/** KES total for quantity × unit cost, rounded to the cent. */
const lineTotal = (qty, cost) => Math.round(Number(qty) * Number(cost) * 100);

// ---- Purchase orders ---------------------------------------------------------------------------

async function loadSupplier(db, facilityId, id) {
  const s = await db('suppliers').where({ id, facility_id: facilityId }).first();
  if (!s) throw badRequest('That supplier is not at this facility');
  if (!s.active) throw conflict(`${s.name} is inactive`);
  return s;
}

/** @param {Deps} deps @param {AuthContext} auth @param {any} input @param {Meta} meta */
export async function createPurchaseOrder({ db }, auth, input, meta) {
  const f = facilityOf(auth);
  const id = await db.transaction(async (trx) => {
    await loadSupplier(trx, f, input.supplierId);
    const store = await trx('stores').where({ id: input.storeId, facility_id: f }).first('id');
    if (!store) throw badRequest('That store is not at this facility');
    const items = await trx('items')
      .whereIn(
        'id',
        input.lines.map((l) => l.itemId),
      )
      .andWhere({ facility_id: f, active: true });
    if (items.length !== input.lines.length) throw badRequest('Some items are not active items at this facility');
    const total = input.lines.reduce((s, l) => s + lineTotal(l.quantity, l.unitCost), 0);
    const [po] = await trx('purchase_orders')
      .insert({
        facility_id: f,
        po_number: await nextDocNumber(trx, f, 'PO'),
        supplier_id: input.supplierId,
        store_id: input.storeId,
        expected_date: input.expectedDate ?? null,
        notes: input.notes ?? null,
        total_amount: fromCents(total),
        created_by: auth.userId,
        updated_by: auth.userId,
      })
      .returning('*');
    await trx('purchase_order_items').insert(
      input.lines.map((l) => ({ po_id: po.id, item_id: l.itemId, quantity: l.quantity, unit_cost: l.unitCost })),
    );
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'create',
      entityType: 'purchase_order',
      entityId: po.id,
      after: { ...po, lines: input.lines },
    });
    return po.id;
  });
  return getPurchaseOrder({ db }, auth, id);
}

/** draft → sent, or → cancelled (only before anything was received). */
export async function setPurchaseOrderStatus({ db }, auth, id, status, meta) {
  await db.transaction(async (trx) => {
    const before = await trx('purchase_orders')
      .where({ id, facility_id: facilityOf(auth) })
      .forUpdate()
      .first();
    if (!before) throw notFound('Purchase order');
    const allowed = { sent: ['draft'], cancelled: ['draft', 'sent'] }[status];
    if (!allowed?.includes(before.status))
      throw conflict(`A ${before.status.replace('_', ' ')} order cannot be ${status}`);
    const [after] = await trx('purchase_orders')
      .where({ id })
      .update({ status, updated_by: auth.userId })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'purchase_order',
      entityId: id,
      before,
      after,
    });
  });
  return getPurchaseOrder({ db }, auth, id);
}

/** @param {Deps} deps @param {AuthContext} auth @param {string} id */
export async function getPurchaseOrder({ db }, auth, id) {
  const po = await db('purchase_orders as p')
    .join('suppliers as s', 's.id', 'p.supplier_id')
    .join('stores as st', 'st.id', 'p.store_id')
    .where({ 'p.id': id, 'p.facility_id': facilityOf(auth) })
    .first('p.*', 's.name as supplier', 'st.name as store');
  if (!po) throw notFound('Purchase order');
  const lines = await db('purchase_order_items as l')
    .join('items as i', 'i.id', 'l.item_id')
    .where('l.po_id', id)
    .orderBy('i.name')
    .select('l.*', 'i.name', 'i.code', 'i.base_unit');
  const grns = await db('goods_received_notes')
    .where({ po_id: id })
    .orderBy('received_at')
    .select('id', 'grn_number', 'received_at', 'total_amount');
  return {
    id: po.id,
    poNumber: po.po_number,
    status: po.status,
    supplierId: po.supplier_id,
    supplier: po.supplier,
    storeId: po.store_id,
    store: po.store,
    expectedDate: po.expected_date,
    notes: po.notes,
    totalAmount: fromCents(toCents(po.total_amount)),
    createdAt: po.created_at,
    lines: lines.map((l) => ({
      id: l.id,
      itemId: l.item_id,
      code: l.code,
      name: l.name,
      baseUnit: l.base_unit,
      quantity: q3(l.quantity),
      receivedQty: q3(l.received_qty),
      outstanding: fromMilli(Math.max(toMilli(l.quantity) - toMilli(l.received_qty), 0)),
      unitCost: Number(l.unit_cost).toFixed(4),
    })),
    grns: grns.map((g) => ({
      id: g.id,
      grnNumber: g.grn_number,
      receivedAt: g.received_at,
      totalAmount: fromCents(toCents(g.total_amount)),
    })),
  };
}

/** @param {Deps} deps @param {AuthContext} auth @param {{status?: string}} [q] */
export async function listPurchaseOrders({ db }, auth, q = {}) {
  const rows = await db('purchase_orders as p')
    .join('suppliers as s', 's.id', 'p.supplier_id')
    .join('stores as st', 'st.id', 'p.store_id')
    .where('p.facility_id', facilityOf(auth))
    .modify((x) => q.status && x.andWhere('p.status', q.status))
    .orderBy('p.created_at', 'desc')
    .limit(200)
    .select(
      'p.id',
      'p.po_number',
      'p.status',
      'p.total_amount',
      'p.expected_date',
      'p.created_at',
      's.name as supplier',
      'st.name as store',
    );
  return rows.map((p) => ({
    id: p.id,
    poNumber: p.po_number,
    status: p.status,
    supplier: p.supplier,
    store: p.store,
    totalAmount: fromCents(toCents(p.total_amount)),
    expectedDate: p.expected_date,
    createdAt: p.created_at,
  }));
}

// ---- Goods received ----------------------------------------------------------------------------

/**
 * Receive goods into a store. Lines in packs are converted to base units (and pack cost to unit
 * cost). Expired or same-day-expiry stock is refused.
 * @param {Deps} deps @param {AuthContext} auth @param {any} input @param {Meta} meta
 */
export async function receiveGoods({ db, bus }, auth, input, meta) {
  const today = todayNairobi();
  const id = await db.transaction(async (trx) => {
    const store = await storeFor(trx, auth, input.storeId, 'inventory.receive');
    const f = store.facility_id;
    const supplier = await loadSupplier(trx, f, input.supplierId);

    let po = null;
    let poLines = [];
    if (input.poId) {
      po = await trx('purchase_orders').where({ id: input.poId, facility_id: f }).forUpdate().first();
      if (!po) throw notFound('Purchase order');
      if (!['sent', 'partially_received'].includes(po.status))
        throw conflict(`This order is ${po.status.replace('_', ' ')}; only sent orders can be received`);
      if (po.store_id !== store.id || po.supplier_id !== supplier.id)
        throw badRequest('The store and supplier must match the purchase order');
      poLines = await trx('purchase_order_items').where({ po_id: po.id }).forUpdate();
    }

    const items = await trx('items')
      .whereIn('id', [...new Set(input.lines.map((l) => l.itemId))])
      .andWhere({ facility_id: f });
    const packs = await trx('item_pack_sizes').whereIn(
      'item_id',
      items.map((i) => i.id),
    );
    const issues = [];
    const lines = input.lines.map((l, n) => {
      const item = items.find((i) => i.id === l.itemId);
      if (!item) issues.push({ path: `lines.${n}.itemId`, message: 'Not an item at this facility' });
      if (l.expiryDate <= today)
        issues.push({ path: `lines.${n}.expiryDate`, message: 'Expired stock cannot be received' });
      let base = l.quantity;
      let cost = l.unitCost;
      if (l.packSizeId) {
        const p = packs.find((x) => x.id === l.packSizeId && x.item_id === l.itemId);
        if (!p) issues.push({ path: `lines.${n}.packSizeId`, message: 'Not a pack size of this item' });
        else {
          base = Number((l.quantity * Number(p.base_qty)).toFixed(3));
          cost = (Number(l.unitCost) / Number(p.base_qty)).toFixed(4);
        }
      }
      return { ...l, item, baseQty: base, cost };
    });
    if (po) {
      const want = new Map();
      for (const [n, l] of lines.entries()) {
        const pl = poLines.find((x) => x.item_id === l.itemId);
        if (!pl) {
          issues.push({ path: `lines.${n}.itemId`, message: 'Not on this purchase order' });
          continue;
        }
        want.set(pl.id, (want.get(pl.id) ?? 0) + toMilli(l.baseQty));
        l.poLine = pl;
      }
      for (const [plId, m] of want) {
        const pl = poLines.find((x) => x.id === plId);
        const left = toMilli(pl.quantity) - toMilli(pl.received_qty);
        if (m > left)
          issues.push({ path: 'lines', message: `More than the ${fromMilli(left)} still on order for an item` });
      }
    }
    if (issues.length) throw new AppError(400, 'VALIDATION_FAILED', 'Check the delivery lines', { issues });

    const [grn] = await trx('goods_received_notes')
      .insert({
        facility_id: f,
        grn_number: await nextDocNumber(trx, f, 'GRN'),
        po_id: po?.id ?? null,
        supplier_id: supplier.id,
        store_id: store.id,
        delivery_note: input.deliveryNote ?? null,
        invoice_ref: input.invoiceRef ?? null,
        notes: input.notes ?? null,
        received_by: auth.userId,
      })
      .returning('*');

    let total = 0;
    for (const l of lines) {
      await trx('item_batches')
        .insert({
          facility_id: f,
          item_id: l.itemId,
          batch_number: l.batchNumber,
          expiry_date: l.expiryDate,
          supplier_id: supplier.id,
          unit_cost: l.cost,
        })
        .onConflict(['item_id', 'batch_number', 'expiry_date'])
        .ignore();
      const batch = await trx('item_batches')
        .where({ item_id: l.itemId, batch_number: l.batchNumber, expiry_date: l.expiryDate })
        .first();
      await updateAverageCost(trx, l.itemId, l.baseQty, l.cost);
      await trx('grn_items').insert({
        grn_id: grn.id,
        po_item_id: l.poLine?.id ?? null,
        item_id: l.itemId,
        batch_id: batch.id,
        quantity: l.baseQty,
        unit_cost: l.cost,
      });
      await moveStock(trx, {
        facilityId: f,
        storeId: store.id,
        itemId: l.itemId,
        batchId: batch.id,
        quantity: l.baseQty,
        type: 'grn',
        unitCost: l.cost,
        referenceType: 'grn',
        referenceId: grn.id,
        userId: auth.userId,
      });
      if (l.poLine)
        await trx('purchase_order_items')
          .where({ id: l.poLine.id })
          .update({ received_qty: trx.raw('received_qty + ?', [l.baseQty]) });
      total += lineTotal(l.baseQty, l.cost);
    }
    await trx('goods_received_notes')
      .where({ id: grn.id })
      .update({ total_amount: fromCents(total) });

    if (po) {
      const after = await trx('purchase_order_items').where({ po_id: po.id });
      const done = after.every((x) => toMilli(x.received_qty) >= toMilli(x.quantity));
      await trx('purchase_orders')
        .where({ id: po.id })
        .update({ status: done ? 'received' : 'partially_received', updated_by: auth.userId });
    }
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'create',
      entityType: 'grn',
      entityId: grn.id,
      after: {
        ...grn,
        total_amount: fromCents(total),
        lines: lines.map((l) => ({
          itemId: l.itemId,
          batchNumber: l.batchNumber,
          expiryDate: l.expiryDate,
          quantity: l.baseQty,
          unitCost: l.cost,
        })),
      },
      metadata: { store: store.code, poNumber: po?.po_number ?? null },
    });
    await bus.publish(trx, {
      type: 'stock.received',
      aggregateType: 'grn',
      aggregateId: grn.id,
      facilityId: f,
      payload: { storeId: store.id, lines: lines.length },
    });
    return grn.id;
  });
  return getGrn({ db }, auth, id);
}

/** @param {Deps} deps @param {AuthContext} auth @param {string} id */
export async function getGrn({ db }, auth, id) {
  const g = await db('goods_received_notes as g')
    .join('suppliers as s', 's.id', 'g.supplier_id')
    .join('stores as st', 'st.id', 'g.store_id')
    .join('users as u', 'u.id', 'g.received_by')
    .leftJoin('purchase_orders as p', 'p.id', 'g.po_id')
    .where({ 'g.id': id, 'g.facility_id': facilityOf(auth) })
    .first('g.*', 's.name as supplier', 'st.name as store', 'u.full_name as received_by_name', 'p.po_number');
  if (!g) throw notFound('Goods received note');
  const lines = await db('grn_items as l')
    .join('items as i', 'i.id', 'l.item_id')
    .join('item_batches as b', 'b.id', 'l.batch_id')
    .where('l.grn_id', id)
    .select('l.*', 'i.name', 'i.code', 'i.base_unit', 'b.batch_number', 'b.expiry_date');
  return {
    id: g.id,
    grnNumber: g.grn_number,
    poNumber: g.po_number,
    supplier: g.supplier,
    store: g.store,
    deliveryNote: g.delivery_note,
    invoiceRef: g.invoice_ref,
    notes: g.notes,
    totalAmount: fromCents(toCents(g.total_amount)),
    receivedBy: g.received_by_name,
    receivedAt: g.received_at,
    lines: lines.map((l) => ({
      itemId: l.item_id,
      code: l.code,
      name: l.name,
      baseUnit: l.base_unit,
      batchNumber: l.batch_number,
      expiryDate: l.expiry_date,
      quantity: q3(l.quantity),
      unitCost: Number(l.unit_cost).toFixed(4),
      total: fromCents(lineTotal(l.quantity, l.unit_cost)),
    })),
  };
}

/** @param {Deps} deps @param {AuthContext} auth */
export async function listGrns({ db }, auth) {
  const rows = await db('goods_received_notes as g')
    .join('suppliers as s', 's.id', 'g.supplier_id')
    .join('stores as st', 'st.id', 'g.store_id')
    .leftJoin('purchase_orders as p', 'p.id', 'g.po_id')
    .where('g.facility_id', facilityOf(auth))
    .orderBy('g.received_at', 'desc')
    .limit(200)
    .select(
      'g.id',
      'g.grn_number',
      'g.received_at',
      'g.total_amount',
      's.name as supplier',
      'st.name as store',
      'p.po_number',
    );
  return rows.map((g) => ({
    id: g.id,
    grnNumber: g.grn_number,
    poNumber: g.po_number,
    supplier: g.supplier,
    store: g.store,
    receivedAt: g.received_at,
    totalAmount: fromCents(toCents(g.total_amount)),
  }));
}
