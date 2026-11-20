import '../../lib/db-types.js';
// Over-the-counter sales to walk-in customers (no patient record needed).
//   1. The pharmacy rings up the sale: a bill in the customer's name, priced from the cash list.
//      Only OTC-allowed drugs and consumables; stock must be on the shelf (in date) now.
//   2. The customer pays at the cashier (ordinary receipt, eTIMS, shift totals).
//   3. The pharmacy hands over: only once the bill is paid, stock leaves FEFO ('otc_sale').
// Selling and taking money stay separate duties.
import { fromCents, fromMilli, splitLine, todayNairobi, toCents, toMilli } from '@afyazuri/shared';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { nextDocNumber } from '../../lib/sequences.js';
import { recordAudit } from '../audit/service.js';
import { resolvePrice } from '../billing/pricing.js';
import { nextNumber, recalcBill } from '../billing/service.js';
import { storeFor } from '../inventory/service.js';
import { allocateFefo, moveStock } from '../inventory/stock.js';

/**
 * @typedef {import('../../middleware/auth.js').AuthContext} AuthContext
 * @typedef {{ip?: string|null, userAgent?: string|null, requestId?: string|null}} Meta
 * @typedef {{db: import('knex').Knex, bus: import('../../lib/events.js').EventBus,
 *            crypto: import('../../lib/crypto.js').FieldCrypto}} Deps
 */

const actorOf = (a) => ({ userId: a.userId, username: a.username, roles: a.roles, facilityId: a.facilityId });
const q3 = (v) => fromMilli(toMilli(v ?? 0));
const maskPhone = (p) => (p ? `${p.slice(0, 7)}…${p.slice(-3)}` : null);

/** @param {Deps} deps @param {AuthContext} auth @param {any} input @param {Meta} meta */
export async function createOtcSale({ db, crypto }, auth, input, meta) {
  const id = await db.transaction(async (trx) => {
    const store = await storeFor(trx, auth, input.storeId, 'pharmacy.otc.sell');
    if (!store.dispensing) throw badRequest(`${store.name} does not sell to the public`);
    const f = store.facility_id;
    const items = await trx('items as i')
      .leftJoin('drugs as d', 'd.item_id', 'i.id')
      .whereIn(
        'i.id',
        input.lines.map((l) => l.itemId),
      )
      .andWhere({ 'i.facility_id': f, 'i.active': true })
      .select('i.*', 'd.otc_allowed', 'd.controlled', 'd.generic_name');
    const today = todayNairobi();
    const issues = [];
    for (const [n, l] of input.lines.entries()) {
      const it = items.find((x) => x.id === l.itemId);
      if (!it) issues.push({ path: `lines.${n}.itemId`, message: 'Not an active item here' });
      else if (it.category === 'drug' && (!it.otc_allowed || it.controlled))
        issues.push({ path: `lines.${n}.itemId`, message: `${it.name} needs a prescription` });
      else if (!['drug', 'consumable'].includes(it.category))
        issues.push({ path: `lines.${n}.itemId`, message: `${it.name} is not for sale` });
      else if (!it.charge_item_id)
        issues.push({ path: `lines.${n}.itemId`, message: `${it.name} has no selling price set up` });
      else {
        const { rows } = await trx.raw(
          `SELECT COALESCE(sum(l.quantity), 0) AS q FROM stock_levels l JOIN item_batches b ON b.id = l.batch_id
           WHERE l.store_id = ? AND l.item_id = ? AND b.expiry_date >= ?`,
          [store.id, it.id, today],
        );
        if (toMilli(rows[0].q) < toMilli(l.quantity))
          issues.push({ path: `lines.${n}.quantity`, message: `Only ${q3(rows[0].q)} of ${it.name} on the shelf` });
      }
    }
    if (issues.length) throw new AppError(400, 'VALIDATION_FAILED', 'Check the sale', { issues });

    const [bill] = await trx('bills')
      .insert({
        facility_id: f,
        bill_number: await nextNumber(trx, f, 'bill'),
        customer_name: input.customerName,
        billing_mode: 'pay_first',
        status: 'final', // nothing more will be added; it closes when paid
        finalized_at: trx.fn.now(),
        created_by: auth.userId,
        updated_by: auth.userId,
      })
      .returning('*');
    const [sale] = await trx('otc_sales')
      .insert({
        facility_id: f,
        sale_number: await nextDocNumber(trx, f, 'OTC'),
        store_id: store.id,
        bill_id: bill.id,
        customer_name: input.customerName,
        customer_phone_enc: input.customerPhone ? crypto.encrypt(input.customerPhone) : null,
        created_by: auth.userId,
        updated_by: auth.userId,
      })
      .returning('*');
    for (const l of input.lines) {
      const it = items.find((x) => x.id === l.itemId);
      const price = await resolvePrice(trx, { facilityId: f, chargeItemId: it.charge_item_id, schemeId: null });
      if (price.unpriced) throw badRequest(`${it.name} has no cash price set`);
      const split = splitLine({
        unitPriceCents: price.unitPriceCents,
        quantity: l.quantity,
        coverType: 'none',
        coverValue: '0',
      });
      const [si] = await trx('otc_sale_items')
        .insert({ sale_id: sale.id, item_id: it.id, quantity: l.quantity })
        .returning('*');
      const [line] = await trx('bill_items')
        .insert({
          facility_id: f,
          bill_id: bill.id,
          charge_item_id: it.charge_item_id,
          price_list_id: price.priceListId,
          department_id: store.department_id,
          description: it.name,
          quantity: Number(Number(l.quantity).toFixed(2)),
          unit_price: fromCents(price.unitPriceCents),
          total_amount: fromCents(split.totalCents),
          payer_amount: '0.00',
          patient_amount: fromCents(split.totalCents),
          source_type: 'otc_sale',
          source_id: si.id,
          posted_by: auth.userId,
        })
        .returning('*');
      await trx('otc_sale_items').where({ id: si.id }).update({ bill_item_id: line.id });
    }
    await recalcBill(trx, bill.id);
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'create',
      entityType: 'otc_sale',
      entityId: sale.id,
      after: { ...sale, customer_phone_enc: undefined, lines: input.lines, billNumber: bill.bill_number },
    });
    return sale.id;
  });
  return getOtcSale({ db, crypto }, auth, id);
}

/**
 * Hand the goods over once the bill is paid. Stock leaves FEFO, recorded as dispensations.
 * @param {Deps} deps @param {AuthContext} auth @param {string} id @param {Meta} meta
 */
export async function handOver({ db, bus, crypto }, auth, id, meta) {
  await db.transaction(async (trx) => {
    const sale = await trx('otc_sales').where({ id, facility_id: auth.facilityId }).forUpdate().first();
    if (!sale) throw notFound('Sale');
    if (sale.status !== 'awaiting_payment') throw conflict(`This sale is ${sale.status.replace('_', ' ')}`);
    const store = await storeFor(trx, auth, sale.store_id, 'pharmacy.otc.sell');
    const bill = await trx('bills').where({ id: sale.bill_id }).forUpdate().first();
    if (toCents(bill.balance) > 0)
      throw new AppError(
        409,
        'NOT_PAID',
        `The customer still owes KES ${fromCents(toCents(bill.balance))}. Send them to the cashier.`,
        {
          balance: fromCents(toCents(bill.balance)),
          billId: bill.id,
        },
      );
    const lines = await trx('otc_sale_items').where({ sale_id: id });
    for (const l of lines) {
      const picks = await allocateFefo(trx, { storeId: store.id, itemId: l.item_id, quantity: Number(l.quantity) });
      const [d] = await trx('dispensations')
        .insert({
          facility_id: sale.facility_id,
          otc_sale_id: id,
          otc_sale_item_id: l.id,
          store_id: store.id,
          item_id: l.item_id,
          quantity: l.quantity,
          bill_item_id: l.bill_item_id,
          dispensed_by: auth.userId,
        })
        .returning('*');
      for (const p of picks) {
        await trx('dispensation_batches').insert({ dispensation_id: d.id, batch_id: p.batchId, quantity: p.quantity });
        await moveStock(trx, {
          facilityId: sale.facility_id,
          storeId: store.id,
          itemId: l.item_id,
          batchId: p.batchId,
          quantity: -p.quantity,
          type: 'otc_sale',
          unitCost: p.unitCost,
          referenceType: 'otc_sale',
          referenceId: id,
          userId: auth.userId,
        });
      }
    }
    const [after] = await trx('otc_sales')
      .where({ id })
      .update({ status: 'completed', completed_by: auth.userId, completed_at: trx.fn.now(), updated_by: auth.userId })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'otc_sale',
      entityId: id,
      before: { status: sale.status },
      after: { status: after.status },
    });
    await bus.publish(trx, {
      type: 'otc_sale.completed',
      aggregateType: 'otc_sale',
      aggregateId: id,
      facilityId: sale.facility_id,
      payload: { storeId: store.id, lines: lines.length },
    });
  });
  return getOtcSale({ db, crypto }, auth, id);
}

/** Cancel an unpaid sale; its bill is cancelled too. */
export async function cancelOtcSale({ db, crypto }, auth, id, reason, meta) {
  await db.transaction(async (trx) => {
    const sale = await trx('otc_sales').where({ id, facility_id: auth.facilityId }).forUpdate().first();
    if (!sale) throw notFound('Sale');
    if (sale.status !== 'awaiting_payment') throw conflict(`This sale is ${sale.status.replace('_', ' ')}`);
    await storeFor(trx, auth, sale.store_id, 'pharmacy.otc.sell');
    const bill = await trx('bills').where({ id: sale.bill_id }).forUpdate().first();
    if (toCents(bill.paid_amount) > 0)
      throw conflict('The customer has paid for this sale: hand it over, or refund through billing');
    await trx('bills').where({ id: bill.id }).update({ status: 'cancelled', updated_by: auth.userId });
    const [after] = await trx('otc_sales')
      .where({ id })
      .update({ status: 'cancelled', cancel_reason: reason, updated_by: auth.userId })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'otc_sale',
      entityId: id,
      before: { status: sale.status },
      after: { status: after.status },
      reason,
    });
  });
  return getOtcSale({ db, crypto }, auth, id);
}

const toSale = (s, crypto) => ({
  id: s.id,
  saleNumber: s.sale_number,
  status: s.status,
  customerName: s.customer_name,
  customerPhone: s.customer_phone_enc ? maskPhone(crypto.decrypt(s.customer_phone_enc)) : null,
  store: s.store,
  billId: s.bill_id,
  billNumber: s.bill_number,
  total: fromCents(toCents(s.total_amount)),
  balance: fromCents(toCents(s.balance)),
  paid: toCents(s.balance) <= 0 && s.status !== 'cancelled',
  createdBy: s.created_by_name,
  createdAt: s.created_at,
  completedBy: s.completed_by_name ?? null,
  completedAt: s.completed_at,
  cancelReason: s.cancel_reason,
});
const base = (db) =>
  db('otc_sales as s')
    .join('bills as b', 'b.id', 's.bill_id')
    .join('stores as st', 'st.id', 's.store_id')
    .join('users as u', 'u.id', 's.created_by')
    .leftJoin('users as c', 'c.id', 's.completed_by')
    .select(
      's.*',
      'b.bill_number',
      'b.total_amount',
      'b.balance',
      'st.name as store',
      'u.full_name as created_by_name',
      'c.full_name as completed_by_name',
    );

/** @param {Deps} deps @param {AuthContext} auth @param {string} id */
export async function getOtcSale({ db, crypto }, auth, id) {
  const s = await base(db).where({ 's.id': id, 's.facility_id': auth.facilityId }).first();
  if (!s) throw notFound('Sale');
  const lines = await db('otc_sale_items as l')
    .join('items as i', 'i.id', 'l.item_id')
    .leftJoin('bill_items as bi', 'bi.id', 'l.bill_item_id')
    .where('l.sale_id', id)
    .orderBy('i.name')
    .select('l.*', 'i.name', 'i.base_unit', 'bi.unit_price', 'bi.total_amount');
  return {
    ...toSale(s, crypto),
    lines: lines.map((l) => ({
      itemId: l.item_id,
      name: l.name,
      baseUnit: l.base_unit,
      quantity: q3(l.quantity),
      unitPrice: fromCents(toCents(l.unit_price)),
      total: fromCents(toCents(l.total_amount)),
    })),
  };
}

/** @param {Deps} deps @param {AuthContext} auth @param {{status?: string}} q */
export async function listOtcSales({ db, crypto }, auth, q = {}) {
  const rows = await base(db)
    .where('s.facility_id', auth.facilityId)
    .modify((x) => q.status && x.andWhere('s.status', q.status))
    .orderBy('s.created_at', 'desc')
    .limit(200);
  return rows.map((r) => toSale(r, crypto));
}
