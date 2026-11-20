import '../../lib/db-types.js';
// Billing: service catalogue, price lists, bills and bill lines.
// Clinical modules call postCharge() inside their own transaction, so a clinical
// action and its charge commit together. Bill totals are recalculated in SQL
// (numeric arithmetic, never floats) after every change.
import { fromCents, splitLine, todayNairobi, toCents } from '@afyazuri/shared';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { decodeCursor, encodeCursor } from '../../lib/http.js';
import { getSetting } from '../../lib/settings.js';
import { recordAudit } from '../audit/service.js';
import { resolvePrice } from './pricing.js';

/**
 * @typedef {import('../../middleware/auth.js').AuthContext} AuthContext
 * @typedef {{ip?: string|null, userAgent?: string|null, requestId?: string|null}} Meta
 * @typedef {{db: import('knex').Knex, bus: import('../../lib/events.js').EventBus}} Deps
 */

const actorOf = (/** @type {AuthContext} */ a) => ({
  userId: a.userId,
  username: a.username,
  roles: a.roles,
  facilityId: a.facilityId,
});
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
const money = (v) => fromCents(toCents(v ?? 0));

/** @param {AuthContext} auth */
export function facilityOf(auth) {
  if (!auth.facilityId) throw badRequest('Select a facility first');
  return auth.facilityId;
}

const NUMBER_PREFIX = { bill: 'BIL', receipt: 'RCT', credit_note: 'CRN', refund: 'RFD' };

/**
 * Next document number, e.g. BIL-2026-000123, RCT-2026-000045, CRN-… (credit note), RFD-… (refund voucher).
 * Atomic per facility, kind and year.
 */
export async function nextNumber(trx, facilityId, kind) {
  const year = Number(todayNairobi().slice(0, 4));
  const { rows } = await trx.raw(
    `INSERT INTO bill_sequences (facility_id, kind, year, last_value) VALUES (?, ?, ?, 1)
     ON CONFLICT (facility_id, kind, year) DO UPDATE SET last_value = bill_sequences.last_value + 1
     RETURNING last_value`,
    [facilityId, kind, year],
  );
  return `${NUMBER_PREFIX[kind]}-${year}-${String(rows[0].last_value).padStart(6, '0')}`;
}

// ---- Catalogue ----------------------------------------------------------------

const toChargeItem = (c) => ({
  id: c.id,
  code: c.code,
  name: c.name,
  category: c.category,
  departmentId: c.department_id,
  unit: c.unit,
  vatRate: Number(c.vat_rate),
  tariffCode: c.tariff_code,
  active: c.active,
  cashPrice: c.cash_price ? money(c.cash_price) : null,
});

/** Catalogue with each item's current cash price. @param {Deps} deps @param {AuthContext} auth @param {{q?: string, active?: boolean}} [q] */
export async function listChargeItems({ db }, auth, q = {}) {
  const facilityId = facilityOf(auth);
  const query = db('charge_items as c')
    .where('c.facility_id', facilityId)
    .select(
      'c.*',
      db('price_list_items as i')
        .join('price_lists as pl', 'pl.id', 'i.price_list_id')
        .whereRaw('i.charge_item_id = c.id')
        .andWhere({ 'pl.is_default': true, 'pl.active': true })
        .select('i.unit_price')
        .limit(1)
        .as('cash_price'),
    )
    .orderBy(['c.category', 'c.name']);
  if (q.active !== undefined) query.andWhere('c.active', q.active);
  if (q.q) query.andWhere((w) => w.whereILike('c.name', `%${q.q}%`).orWhereILike('c.code', `%${q.q}%`));
  return (await query).map(toChargeItem);
}

/** @param {Deps} deps @param {AuthContext} auth @param {any} input @param {Meta} meta */
export async function createChargeItem({ db }, auth, input, meta) {
  const facilityId = facilityOf(auth);
  return db.transaction(async (trx) => {
    const [c] = await trx('charge_items')
      .insert({
        facility_id: facilityId,
        code: input.code,
        name: input.name,
        category: input.category,
        department_id: input.departmentId ?? null,
        unit: input.unit,
        vat_rate: input.vatRate,
        tariff_code: input.tariffCode ?? null,
        created_by: auth.userId,
        updated_by: auth.userId,
      })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'create',
      entityType: 'charge_item',
      entityId: c.id,
      after: c,
    });
    return toChargeItem(c);
  });
}

/** @param {Deps} deps @param {AuthContext} auth @param {string} id @param {any} input @param {Meta} meta */
export async function updateChargeItem({ db }, auth, id, input, meta) {
  return db.transaction(async (trx) => {
    const before = await trx('charge_items')
      .where({ id, facility_id: facilityOf(auth) })
      .forUpdate()
      .first();
    if (!before) throw notFound('Charge item');
    const patch = {};
    const map = {
      code: 'code',
      name: 'name',
      category: 'category',
      departmentId: 'department_id',
      unit: 'unit',
      vatRate: 'vat_rate',
      tariffCode: 'tariff_code',
      active: 'active',
    };
    for (const [k, col] of Object.entries(map)) if (input[k] !== undefined) patch[col] = input[k];
    const [after] = await trx('charge_items')
      .where({ id })
      .update({ ...patch, updated_by: auth.userId })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'charge_item',
      entityId: id,
      before,
      after,
    });
    return toChargeItem(after);
  });
}

// ---- Price lists ------------------------------------------------------------

const toPriceList = (p) => ({
  id: p.id,
  code: p.code,
  name: p.name,
  schemeId: p.scheme_id,
  schemeName: p.scheme_name ?? null,
  payerName: p.payer_name ?? null,
  isDefault: p.is_default,
  active: p.active,
  validFrom: p.valid_from,
  validTo: p.valid_to,
  itemCount: p.item_count ?? undefined,
});

/** @param {Deps} deps @param {AuthContext} auth */
export async function listPriceLists({ db }, auth) {
  const rows = await db('price_lists as pl')
    .leftJoin('schemes as s', 's.id', 'pl.scheme_id')
    .leftJoin('payers as py', 'py.id', 's.payer_id')
    .where('pl.facility_id', facilityOf(auth))
    .orderBy([{ column: 'pl.is_default', order: 'desc' }, { column: 'pl.name' }])
    .select(
      'pl.*',
      's.name as scheme_name',
      'py.name as payer_name',
      db.raw('(SELECT count(*) FROM price_list_items i WHERE i.price_list_id = pl.id)::int AS item_count'),
    );
  return rows.map(toPriceList);
}

/** @param {Deps} deps @param {AuthContext} auth @param {any} input @param {Meta} meta */
export async function createPriceList({ db }, auth, input, meta) {
  const facilityId = facilityOf(auth);
  if (input.schemeId && !(await db('schemes').where({ id: input.schemeId }).first('id')))
    throw badRequest('Scheme not found');
  return db.transaction(async (trx) => {
    const [p] = await trx('price_lists')
      .insert({
        facility_id: facilityId,
        code: input.code,
        name: input.name,
        scheme_id: input.schemeId,
        is_default: input.isDefault,
        valid_from: input.validFrom ? ymd(input.validFrom) : null,
        valid_to: input.validTo ? ymd(input.validTo) : null,
        created_by: auth.userId,
        updated_by: auth.userId,
      })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'create',
      entityType: 'price_list',
      entityId: p.id,
      after: p,
    });
    return toPriceList(p);
  });
}

/** @param {Deps} deps @param {AuthContext} auth @param {string} id @param {any} input @param {Meta} meta */
export async function updatePriceList({ db }, auth, id, input, meta) {
  return db.transaction(async (trx) => {
    const before = await trx('price_lists')
      .where({ id, facility_id: facilityOf(auth) })
      .forUpdate()
      .first();
    if (!before) throw notFound('Price list');
    const patch = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.active !== undefined) patch.active = input.active;
    if (input.validFrom !== undefined) patch.valid_from = input.validFrom ? ymd(input.validFrom) : null;
    if (input.validTo !== undefined) patch.valid_to = input.validTo ? ymd(input.validTo) : null;
    const [after] = await trx('price_lists')
      .where({ id })
      .update({ ...patch, updated_by: auth.userId })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'price_list',
      entityId: id,
      before,
      after,
    });
    return toPriceList(after);
  });
}

const toPriceItem = (i) => ({
  id: i.id,
  chargeItemId: i.charge_item_id,
  code: i.code,
  name: i.name,
  category: i.category,
  unitPrice: money(i.unit_price),
  coverType: i.cover_type,
  coverValue: money(i.cover_value),
  requiresPreauth: i.requires_preauth,
});

/** @param {Deps} deps @param {AuthContext} auth @param {string} priceListId */
export async function listPriceListItems({ db }, auth, priceListId) {
  const pl = await db('price_lists')
    .where({ id: priceListId, facility_id: facilityOf(auth) })
    .first('id');
  if (!pl) throw notFound('Price list');
  const rows = await db('price_list_items as i')
    .join('charge_items as c', 'c.id', 'i.charge_item_id')
    .where('i.price_list_id', priceListId)
    .orderBy(['c.category', 'c.name'])
    .select('i.*', 'c.code', 'c.name', 'c.category');
  return rows.map(toPriceItem);
}

/** Set (insert or update) an item's price on a list. @param {Deps} deps @param {AuthContext} auth @param {string} priceListId @param {any} input @param {Meta} meta */
export async function setPriceListItem({ db }, auth, priceListId, input, meta) {
  const facilityId = facilityOf(auth);
  return db.transaction(async (trx) => {
    const pl = await trx('price_lists').where({ id: priceListId, facility_id: facilityId }).first();
    if (!pl) throw notFound('Price list');
    if (!pl.scheme_id && input.coverType !== 'none') throw badRequest('The cash price list has no payer cover');
    const before = await trx('price_list_items')
      .where({ price_list_id: priceListId, charge_item_id: input.chargeItemId })
      .forUpdate()
      .first();
    const values = {
      unit_price: input.unitPrice,
      cover_type: input.coverType,
      cover_value: input.coverValue,
      requires_preauth: input.requiresPreauth,
      updated_by: auth.userId,
    };
    const [after] = before
      ? await trx('price_list_items').where({ id: before.id }).update(values).returning('*')
      : await trx('price_list_items')
          .insert({
            ...values,
            facility_id: facilityId,
            price_list_id: priceListId,
            charge_item_id: input.chargeItemId,
            created_by: auth.userId,
          })
          .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: before ? 'update' : 'create',
      entityType: 'price_list_item',
      entityId: after.id,
      before,
      after,
      metadata: { priceList: pl.code },
    });
    return (await listPriceListItems({ db: trx }, auth, priceListId)).find((i) => i.id === after.id);
  });
}

/** @param {Deps} deps @param {AuthContext} auth @param {string} priceListId @param {string} itemId @param {Meta} meta */
export async function removePriceListItem({ db }, auth, priceListId, itemId, meta) {
  await db.transaction(async (trx) => {
    const before = await trx('price_list_items')
      .where({ id: itemId, price_list_id: priceListId, facility_id: facilityOf(auth) })
      .first();
    if (!before) throw notFound('Price');
    await trx('price_list_items').where({ id: itemId }).delete();
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'delete',
      entityType: 'price_list_item',
      entityId: itemId,
      before,
    });
  });
}

// ---- Bills --------------------------------------------------------------------

/**
 * Recalculate a bill's cached totals from its lines, payments, waivers and refunds,
 * and move it between final ⇄ closed as its patient balance reaches or leaves zero.
 * @param {import('knex').Knex.Transaction | import('knex').Knex} trx @param {string} billId
 */
export async function recalcBill(trx, billId) {
  const [b] = await trx
    .raw(
      `UPDATE bills b SET
       total_amount    = t.total, payer_amount = t.payer, patient_amount = t.patient,
       paid_amount     = t.paid, waived_amount = t.waived, credited_amount = t.credited, refunded_amount = t.refunded,
       balance         = t.patient - t.paid - t.waived - t.credited + t.refunded,
       status = CASE
         WHEN b.status = 'final'  AND t.patient - t.paid - t.waived - t.credited + t.refunded <= 0 THEN 'closed'
         WHEN b.status = 'closed' AND t.patient - t.paid - t.waived - t.credited + t.refunded > 0  THEN 'final'
         ELSE b.status END,
       closed_at = CASE
         WHEN b.status = 'final' AND t.patient - t.paid - t.waived - t.credited + t.refunded <= 0 THEN now()
         WHEN t.patient - t.paid - t.waived - t.credited + t.refunded > 0 THEN NULL
         ELSE b.closed_at END
     FROM (SELECT
       COALESCE((SELECT sum(total_amount)   FROM bill_items WHERE bill_id = :id AND status = 'active'), 0) AS total,
       COALESCE((SELECT sum(payer_amount)   FROM bill_items WHERE bill_id = :id AND status = 'active'), 0) AS payer,
       COALESCE((SELECT sum(patient_amount) FROM bill_items WHERE bill_id = :id AND status = 'active'), 0) AS patient,
       COALESCE((SELECT sum(amount) FROM payments WHERE bill_id = :id AND status = 'completed'), 0) AS paid,
       COALESCE((SELECT sum(amount) FROM waivers  WHERE bill_id = :id AND status = 'approved'), 0) AS waived,
       COALESCE((SELECT sum(amount) FROM refunds  WHERE bill_id = :id AND kind = 'credit_note' AND status = 'approved'), 0) AS credited,
       COALESCE((SELECT sum(amount) FROM refunds  WHERE bill_id = :id AND kind = 'refund' AND status = 'paid'), 0) AS refunded
     ) t
     WHERE b.id = :id RETURNING b.*`.replace(/\s+/g, ' '),
      { id: billId },
    )
    .then((r) => r.rows);
  return b;
}

/**
 * The encounter's bill, created on first use (one bill per visit).
 * @param {import('knex').Knex.Transaction} trx @param {AuthContext} auth @param {any} encounter
 */
export async function ensureBillForEncounter(trx, auth, encounter) {
  const existing = await trx('bills')
    .where({ encounter_id: encounter.id })
    .whereNot('status', 'cancelled')
    .forUpdate()
    .first();
  if (existing) return existing;
  const [b] = await trx('bills')
    .insert({
      facility_id: encounter.facility_id,
      bill_number: await nextNumber(trx, encounter.facility_id, 'bill'),
      encounter_id: encounter.id,
      patient_id: encounter.patient_id,
      patient_payer_scheme_id: encounter.patient_payer_scheme_id,
      billing_mode: encounter.billing_mode,
      created_by: auth.userId,
      updated_by: auth.userId,
    })
    .returning('*');
  return b;
}

/**
 * Post a charge to an encounter's bill, priced for the patient's scheme. Idempotent
 * on (sourceType, sourceId): posting the same clinical action twice adds one line.
 * Call inside the transaction of the action being charged.
 * @param {import('knex').Knex.Transaction} trx @param {AuthContext} auth
 * @param {{encounter: any, chargeItemId?: string, chargeCode?: string, quantity?: number, sourceType: string, sourceId?: string|null,
 *          unitPrice?: string, description?: string, departmentId?: string|null}} p
 * @returns {Promise<any|null>} the line, or null when the item code is not set up at this facility
 */
export async function postCharge(trx, auth, p) {
  const { encounter } = p;
  const item = p.chargeItemId
    ? await trx('charge_items').where({ id: p.chargeItemId, facility_id: encounter.facility_id }).first()
    : await trx('charge_items').where({ code: p.chargeCode, facility_id: encounter.facility_id, active: true }).first();
  if (!item) {
    if (p.chargeItemId) throw badRequest('Charge item not found');
    return null;
  }
  if (!item.active) throw badRequest(`${item.name} is no longer active`);
  const bill = await ensureBillForEncounter(trx, auth, encounter);
  if (bill.status === 'cancelled') throw conflict('This bill is cancelled');

  if (p.sourceId) {
    const dup = await trx('bill_items')
      .where({ source_type: p.sourceType, source_id: p.sourceId, status: 'active' })
      .first();
    if (dup) return dup;
  }
  const scheme = bill.patient_payer_scheme_id
    ? await trx('patient_payer_schemes').where({ id: bill.patient_payer_scheme_id }).first('scheme_id')
    : null;
  const price = await resolvePrice(trx, {
    facilityId: encounter.facility_id,
    chargeItemId: item.id,
    schemeId: scheme?.scheme_id ?? null,
  });
  let unitPriceCents = price.unitPriceCents;
  let unpriced = price.unpriced;
  if (p.unitPrice !== undefined) {
    if (!price.unpriced)
      throw badRequest(`${item.name} has a set price of ${fromCents(price.unitPriceCents)}; it cannot be changed here`);
    unitPriceCents = toCents(p.unitPrice);
    unpriced = false;
  }
  const quantity = p.quantity ?? 1;
  const split = splitLine({ unitPriceCents, quantity, coverType: price.coverType, coverValue: price.coverValue });

  const [line] = await trx('bill_items')
    .insert({
      facility_id: encounter.facility_id,
      bill_id: bill.id,
      charge_item_id: item.id,
      price_list_id: price.priceListId,
      department_id: p.departmentId ?? item.department_id ?? encounter.department_id ?? null,
      description: p.description || item.name,
      quantity,
      unit_price: fromCents(unitPriceCents),
      total_amount: fromCents(split.totalCents),
      payer_amount: fromCents(split.payerCents),
      patient_amount: fromCents(split.patientCents),
      unpriced,
      source_type: p.sourceType,
      source_id: p.sourceId ?? null,
      posted_by: auth.userId,
    })
    .returning('*'); // the bill row is locked above, so the duplicate check cannot race; the unique index backs it up
  // A late charge on a settled bill re-opens it for payment.
  if (bill.status === 'closed') await trx('bills').where({ id: bill.id }).update({ status: 'final', closed_at: null });
  await recalcBill(trx, bill.id);
  return line;
}

/**
 * Automatic charges when a visit opens: the consultation fee for the visit type and,
 * on a patient's first visit, the registration fee. Item codes come from the
 * `billing.auto_charges` setting; codes not set up at the facility are skipped.
 * @param {import('knex').Knex.Transaction} trx @param {AuthContext} auth @param {any} encounter
 */
export async function onEncounterOpened(trx, auth, encounter) {
  const codes = await getSetting(trx, encounter.facility_id, 'billing.auto_charges', {
    registration: 'REG-NEW',
    opd: 'CONS-OPD',
    emergency: 'CONS-EMER',
  });
  await ensureBillForEncounter(trx, auth, encounter);
  const earlier = await trx('encounters')
    .where({ patient_id: encounter.patient_id })
    .whereNot('id', encounter.id)
    .first('id');
  if (!earlier && codes.registration)
    await postCharge(trx, auth, {
      encounter,
      chargeCode: codes.registration,
      sourceType: 'registration',
      sourceId: encounter.id,
    });
  const consult = codes[encounter.type];
  if (consult)
    await postCharge(trx, auth, { encounter, chargeCode: consult, sourceType: 'consultation', sourceId: encounter.id });
}

/** Mark the visit's bill final when the visit ends (no more automatic lines are expected). */
export async function onEncounterClosed(trx, encounterId) {
  const bill = await trx('bills').where({ encounter_id: encounterId, status: 'open' }).first('id');
  if (!bill) return;
  await trx('bills').where({ id: bill.id }).update({ status: 'final', finalized_at: trx.fn.now() });
  await recalcBill(trx, bill.id);
}

const toBillItem = (i) => ({
  id: i.id,
  chargeItemId: i.charge_item_id,
  code: i.code,
  category: i.category,
  description: i.description,
  quantity: Number(i.quantity),
  unitPrice: money(i.unit_price),
  totalAmount: money(i.total_amount),
  payerAmount: money(i.payer_amount),
  patientAmount: money(i.patient_amount),
  unpriced: i.unpriced,
  sourceType: i.source_type,
  status: i.status,
  voidReason: i.void_reason,
  postedAt: i.posted_at,
  postedBy: i.posted_by_name ?? null,
});

const toBill = (b) => ({
  id: b.id,
  billNumber: b.bill_number,
  status: b.status,
  encounterId: b.encounter_id,
  billingMode: b.billing_mode,
  patient: b.patient_id
    ? { id: b.patient_id, mrn: b.mrn, fullName: [b.first_name, b.middle_name, b.last_name].filter(Boolean).join(' ') }
    : { id: null, mrn: null, fullName: b.customer_name },
  payer: b.scheme_name ? { schemeName: b.scheme_name, payerName: b.payer_name, memberNumber: b.member_number } : null,
  totalAmount: money(b.total_amount),
  payerAmount: money(b.payer_amount),
  patientAmount: money(b.patient_amount),
  paidAmount: money(b.paid_amount),
  waivedAmount: money(b.waived_amount),
  creditedAmount: money(b.credited_amount),
  refundedAmount: money(b.refunded_amount),
  balance: money(b.balance),
  openedAt: b.opened_at,
  finalizedAt: b.finalized_at,
  closedAt: b.closed_at,
});

const billQuery = (db) =>
  db('bills as b')
    .leftJoin('patients as p', 'p.id', 'b.patient_id')
    .leftJoin('patient_payer_schemes as ps', 'ps.id', 'b.patient_payer_scheme_id')
    .leftJoin('schemes as s', 's.id', 'ps.scheme_id')
    .leftJoin('payers as py', 'py.id', 's.payer_id')
    .select(
      'b.*',
      'p.mrn',
      'p.first_name',
      'p.middle_name',
      'p.last_name',
      's.name as scheme_name',
      'py.name as payer_name',
      'ps.member_number',
    );

/**
 * Bill with its lines, payments, receipts, waivers and refunds.
 * @param {Deps} deps @param {AuthContext} auth @param {string} id
 */
export async function getBill({ db }, auth, id) {
  const b = await billQuery(db)
    .where({ 'b.id': id, 'b.facility_id': facilityOf(auth) })
    .first();
  if (!b) throw notFound('Bill');
  const [items, payments, waivers, refunds] = await Promise.all([
    db('bill_items as i')
      .join('charge_items as c', 'c.id', 'i.charge_item_id')
      .leftJoin('users as u', 'u.id', 'i.posted_by')
      .where('i.bill_id', id)
      .orderBy('i.posted_at')
      .select('i.*', 'c.code', 'c.category', 'u.full_name as posted_by_name'),
    db('payments as pay')
      .leftJoin('receipts as r', 'r.payment_id', 'pay.id')
      .leftJoin('users as u', 'u.id', 'pay.received_by')
      .leftJoin('sms_messages as sm', function () {
        this.on('sm.related_id', 'pay.id').andOnVal('sm.template', 'payment_received');
      })
      .where('pay.bill_id', id)
      .orderBy('pay.created_at')
      .select(
        'pay.*',
        'r.receipt_number',
        'r.id as receipt_id',
        'r.etims_status',
        'r.etims_invoice_number',
        'u.full_name as received_by_name',
        'sm.status as sms_status',
      ),
    db('waivers as w')
      .leftJoin('users as rq', 'rq.id', 'w.requested_by')
      .leftJoin('users as d', 'd.id', 'w.decided_by')
      .where('w.bill_id', id)
      .orderBy('w.requested_at')
      .select('w.*', 'rq.full_name as requested_by_name', 'd.full_name as decided_by_name'),
    db('refunds as f')
      .leftJoin('users as rq', 'rq.id', 'f.requested_by')
      .leftJoin('users as d', 'd.id', 'f.decided_by')
      .where('f.bill_id', id)
      .orderBy('f.requested_at')
      .select('f.*', 'rq.full_name as requested_by_name', 'd.full_name as decided_by_name'),
  ]);
  return {
    ...toBill(b),
    items: items.map(toBillItem),
    payments: payments.map((p) => ({
      id: p.id,
      method: p.method,
      amount: money(p.amount),
      reference: p.reference,
      status: p.status,
      receivedAt: p.received_at,
      receivedBy: p.received_by_name,
      receiptNumber: p.receipt_number,
      receiptId: p.receipt_id,
      etims: { status: p.etims_status, invoiceNumber: p.etims_invoice_number },
      sms: p.sms_status ?? null,
    })),
    waivers: waivers.map((w) => ({
      id: w.id,
      amount: money(w.amount),
      reason: w.reason,
      status: w.status,
      requestedBy: w.requested_by_name,
      requestedById: w.requested_by,
      requestedAt: w.requested_at,
      decidedBy: w.decided_by_name,
      decidedAt: w.decided_at,
      decisionNote: w.decision_note,
    })),
    refunds: refunds.map((f) => ({
      id: f.id,
      kind: f.kind,
      amount: money(f.amount),
      reason: f.reason,
      status: f.status,
      paymentId: f.payment_id,
      method: f.method,
      requestedBy: f.requested_by_name,
      requestedById: f.requested_by,
      requestedAt: f.requested_at,
      decidedBy: f.decided_by_name,
      decidedAt: f.decided_at,
      decisionNote: f.decision_note,
      documentNumber: f.document_number,
      reference: f.reference,
      paidAt: f.paid_at,
      etims: { status: f.etims_status, invoiceNumber: f.etims_invoice_number },
    })),
  };
}

/** @param {Deps} deps @param {AuthContext} auth @param {string} encounterId */
export async function getEncounterBill({ db }, auth, encounterId) {
  const b = await db('bills')
    .where({ encounter_id: encounterId, facility_id: facilityOf(auth) })
    .whereNot('status', 'cancelled')
    .first('id');
  if (!b) throw notFound('Bill');
  return getBill({ db }, auth, b.id);
}

/**
 * Bills for the cashier and billing office, newest first.
 * @param {Deps} deps @param {AuthContext} auth @param {{status: string, patientId?: string, encounterId?: string, q?: string, limit: number, cursor?: string}} q
 */
export async function listBills({ db }, auth, q) {
  const query = billQuery(db).where('b.facility_id', facilityOf(auth));
  if (q.status === 'outstanding') query.andWhere('b.balance', '>', 0).whereNot('b.status', 'cancelled');
  else if (q.status !== 'all') query.andWhere('b.status', q.status);
  if (q.patientId) query.andWhere('b.patient_id', q.patientId);
  if (q.encounterId) query.andWhere('b.encounter_id', q.encounterId);
  if (q.q) {
    const like = `%${q.q.replace(/[%_\\]/g, '\\$&')}%`;
    query.andWhere((w) =>
      w
        .whereILike('b.bill_number', like)
        .orWhereILike('b.customer_name', like)
        .orWhereILike('p.mrn', like)
        .orWhereRaw('p.search_name LIKE ?', [like.toLowerCase()]),
    );
  }
  const c = decodeCursor(q.cursor);
  if (c) query.andWhereRaw('(b.opened_at, b.id) < (?, ?)', [c.t, c.id]);
  const rows = await query
    .orderBy([
      { column: 'b.opened_at', order: 'desc' },
      { column: 'b.id', order: 'desc' },
    ])
    .limit(q.limit + 1);
  const more = rows.length > q.limit;
  const data = rows.slice(0, q.limit);
  return {
    data: data.map(toBill),
    nextCursor: more ? encodeCursor({ t: data[data.length - 1].opened_at, id: data[data.length - 1].id }) : null,
  };
}

/**
 * Add a manual line (with permission). Items with a set price use it; unpriced
 * items need a price entered here.
 * @param {Deps} deps @param {AuthContext} auth @param {string} billId @param {any} input @param {Meta} meta
 */
export async function addManualCharge({ db }, auth, billId, input, meta) {
  await db.transaction(async (trx) => {
    const bill = await trx('bills')
      .where({ id: billId, facility_id: facilityOf(auth) })
      .forUpdate()
      .first();
    if (!bill) throw notFound('Bill');
    if (bill.status === 'cancelled') throw conflict('This bill is cancelled');
    if (!bill.encounter_id) throw badRequest('Manual charges need a visit bill');
    const encounter = await trx('encounters').where({ id: bill.encounter_id }).first();
    const line = await postCharge(trx, auth, {
      encounter,
      chargeItemId: input.chargeItemId,
      quantity: input.quantity,
      unitPrice: input.unitPrice,
      description: input.description,
      sourceType: 'manual',
    });
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'create',
      entityType: 'bill_item',
      entityId: line.id,
      patientId: bill.patient_id,
      after: line,
      metadata: { billNumber: bill.bill_number },
    });
  });
  return getBill({ db }, auth, billId);
}

/** Void a line (kept, struck through, with reason). @param {Deps} deps @param {AuthContext} auth @param {string} itemId @param {string} reason @param {Meta} meta */
export async function voidBillItem({ db }, auth, itemId, reason, meta) {
  const billId = await db.transaction(async (trx) => {
    const before = await trx('bill_items')
      .where({ id: itemId, facility_id: facilityOf(auth) })
      .forUpdate()
      .first();
    if (!before) throw notFound('Bill line');
    if (before.status === 'voided') throw conflict('This line is already voided');
    const bill = await trx('bills').where({ id: before.bill_id }).forUpdate().first();
    if (bill.status === 'cancelled') throw conflict('This bill is cancelled');
    const [after] = await trx('bill_items')
      .where({ id: itemId })
      .update({ status: 'voided', void_reason: reason, voided_by: auth.userId, voided_at: trx.fn.now() })
      .returning('*');
    // A void after payment can leave the bill overpaid (negative balance). That credit is
    // shown on the bill and paid back through an approved refund.
    await recalcBill(trx, bill.id);
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'bill_item',
      entityId: itemId,
      patientId: bill.patient_id,
      before,
      after,
      reason,
    });
    return bill.id;
  });
  return getBill({ db }, auth, billId);
}
