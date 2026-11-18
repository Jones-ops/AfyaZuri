import '../../lib/db-types.js';
// Cashier shifts, payments, receipts and M-Pesa (STK Push and Paybill/C2B).
// Every payment, its receipt, the bill totals and (for pay-first visits) the
// patient's move out of the cashier queue commit in one transaction.
import { PAYMENT_METHODS, fromCents, toCents } from '@afyazuri/shared';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { parseStkCallback, stkStatusFor } from '../../integrations/mpesa.js';
import { recordAudit } from '../audit/service.js';
import { advanceAfterPayment } from '../opd/service.js';
import { facilityOf, nextNumber, recalcBill } from './service.js';

/**
 * @typedef {import('../../middleware/auth.js').AuthContext} AuthContext
 * @typedef {{ip?: string|null, userAgent?: string|null, requestId?: string|null}} Meta
 * @typedef {{db: import('knex').Knex, bus: import('../../lib/events.js').EventBus, crypto: import('../../lib/crypto.js').FieldCrypto,
 *            mpesa: import('../../integrations/mpesa.js').DarajaAdapter, logger?: import('pino').Logger}} Deps
 */

const actorOf = (a) => ({ userId: a.userId, username: a.username, roles: a.roles, facilityId: a.facilityId });
const money = (v) => fromCents(toCents(v ?? 0));
const SYSTEM_META = { ip: null, userAgent: 'safaricom-daraja', requestId: null };

// ---- Shifts -------------------------------------------------------------------

/** Totals for a shift: payments taken and refunds paid out, by method. @param {import('knex').Knex} db @param {any} shift */
export async function shiftTotals(db, shift) {
  const pay = await db('payments')
    .where({ shift_id: shift.id, status: 'completed' })
    .groupBy('method')
    .select('method', db.raw('sum(amount) AS total'), db.raw('count(*)::int AS n'));
  const ref = await db('refunds')
    .where({ shift_id: shift.id, status: 'paid' })
    .groupBy('method')
    .select('method', db.raw('sum(amount) AS total'));
  const out = {};
  for (const m of PAYMENT_METHODS) {
    const p = pay.find((r) => r.method === m);
    const r = ref.find((x) => x.method === m);
    const received = toCents(p?.total ?? 0);
    const refunded = toCents(r?.total ?? 0);
    const expected = received - refunded + (m === 'cash' ? toCents(shift.opening_float) : 0);
    out[m] = {
      received: fromCents(received),
      refunded: fromCents(refunded),
      expected: fromCents(expected),
      count: p?.n ?? 0,
    };
  }
  return out;
}

const toShift = (s, totals) => ({
  id: s.id,
  cashierId: s.cashier_id,
  cashierName: s.cashier_name ?? null,
  status: s.status,
  openedAt: s.opened_at,
  openingFloat: money(s.opening_float),
  closedAt: s.closed_at,
  declared: s.declared,
  systemTotals: s.system_totals ?? totals ?? null,
  variance: s.variance,
  notes: s.notes,
});

/** @param {Deps} deps @param {AuthContext} auth */
export async function currentShift({ db }, auth) {
  const s = await db('cashier_shifts')
    .where({ cashier_id: auth.userId, status: 'open', facility_id: facilityOf(auth) })
    .first();
  return s ? toShift(s, await shiftTotals(db, s)) : null;
}

/** @param {Deps} deps @param {AuthContext} auth @param {{openingFloat: string}} input @param {Meta} meta */
export async function openShift({ db }, auth, input, meta) {
  const facilityId = facilityOf(auth);
  if (await db('cashier_shifts').where({ cashier_id: auth.userId, status: 'open' }).first('id'))
    throw new AppError(409, 'SHIFT_ALREADY_OPEN', 'You already have an open shift. Close it before opening another.');
  return db.transaction(async (trx) => {
    const [s] = await trx('cashier_shifts')
      .insert({ facility_id: facilityId, cashier_id: auth.userId, opening_float: input.openingFloat })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'create',
      entityType: 'cashier_shift',
      entityId: s.id,
      after: s,
    });
    return toShift(s, await shiftTotals(trx, s));
  });
}

/**
 * Close the shift: compare what the cashier counted with what the system recorded.
 * Variance = declared − expected, per method (expected cash includes the float).
 * @param {Deps} deps @param {AuthContext} auth @param {{declared: Record<string, string>, notes?: string|null}} input @param {Meta} meta
 */
export async function closeShift({ db }, auth, input, meta) {
  return db.transaction(async (trx) => {
    const s = await trx('cashier_shifts')
      .where({ cashier_id: auth.userId, status: 'open', facility_id: facilityOf(auth) })
      .forUpdate()
      .first();
    if (!s) throw new AppError(409, 'NO_OPEN_SHIFT', 'You have no open shift');
    const pending = await trx('mpesa_transactions').where({ shift_id: s.id, status: 'pending' }).first('id');
    if (pending)
      throw new AppError(
        409,
        'MPESA_PENDING',
        'An M-Pesa payment from this shift is still waiting for confirmation. Check its status first.',
      );
    const totals = await shiftTotals(trx, s);
    const variance = Object.fromEntries(
      PAYMENT_METHODS.map((m) => [m, fromCents(toCents(input.declared[m]) - toCents(totals[m].expected))]),
    );
    const [after] = await trx('cashier_shifts')
      .where({ id: s.id })
      .update({
        status: 'closed',
        closed_at: trx.fn.now(),
        declared: JSON.stringify(input.declared),
        system_totals: JSON.stringify(totals),
        variance: JSON.stringify(variance),
        notes: input.notes ?? null,
      })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'cashier_shift',
      entityId: s.id,
      before: s,
      after,
    });
    return toShift(after);
  });
}

/** Recent shifts for supervisors. @param {Deps} deps @param {AuthContext} auth @param {{limit?: number}} [q] */
export async function listShifts({ db }, auth, q = {}) {
  const rows = await db('cashier_shifts as s')
    .join('users as u', 'u.id', 's.cashier_id')
    .where('s.facility_id', facilityOf(auth))
    .orderBy('s.opened_at', 'desc')
    .limit(q.limit ?? 50)
    .select('s.*', 'u.full_name as cashier_name');
  return Promise.all(rows.map(async (s) => toShift(s, s.status === 'open' ? await shiftTotals(db, s) : null)));
}

async function requireOpenShift(trx, auth) {
  const s = await trx('cashier_shifts')
    .where({ cashier_id: auth.userId, status: 'open', facility_id: auth.facilityId })
    .first();
  if (!s) throw new AppError(409, 'NO_OPEN_SHIFT', 'Open a cashier shift before taking payments');
  return s;
}

// ---- Payments and receipts ----------------------------------------------------

async function issueReceipt(trx, payment, issuedBy) {
  const [r] = await trx('receipts')
    .insert({
      facility_id: payment.facility_id,
      receipt_number: await nextNumber(trx, payment.facility_id, 'receipt'),
      payment_id: payment.id,
      issued_by: issuedBy,
    })
    .returning('*');
  return r;
}

/**
 * Record a completed payment, issue its receipt, recalculate the bill and, for a
 * settled pay-first visit, send the patient on from the cashier. Shared by the
 * cashier desk, STK callbacks and Paybill confirmations.
 * @param {import('knex').Knex.Transaction} trx @param {Deps} deps @param {AuthContext} actor
 * @param {{bill: any, method: string, amount: string, reference?: string|null, shiftId?: string|null, notes?: string|null, clientId?: string|null}} p
 * @param {Meta} meta
 */
async function recordPayment(trx, deps, actor, p, meta) {
  const [payment] = await trx('payments')
    .insert({
      facility_id: p.bill.facility_id,
      bill_id: p.bill.id,
      shift_id: p.shiftId ?? null,
      method: p.method,
      amount: p.amount,
      reference: p.reference ?? null,
      status: 'completed',
      received_by: actor.userId ?? null,
      received_at: trx.fn.now(),
      notes: p.notes ?? null,
      client_id: p.clientId ?? null,
    })
    .returning('*');
  const receipt = await issueReceipt(trx, payment, actor.userId ?? null);
  const bill = await recalcBill(trx, p.bill.id);
  await recordAudit(trx, actor.userId ? actorOf(actor) : null, meta, {
    action: 'create',
    entityType: 'payment',
    entityId: payment.id,
    patientId: bill.patient_id,
    after: payment,
    facilityId: bill.facility_id,
    metadata: { receiptNumber: receipt.receipt_number, billNumber: bill.bill_number, method: p.method },
  });
  await deps.bus.publish(trx, {
    type: 'payment.completed',
    aggregateType: 'payment',
    aggregateId: payment.id,
    facilityId: bill.facility_id,
    payload: { billId: bill.id, receiptId: receipt.id, method: p.method, amount: p.amount },
  });
  let advanced = null;
  if (bill.encounter_id && bill.billing_mode === 'pay_first' && toCents(bill.balance) <= 0)
    advanced = await advanceAfterPayment(
      trx,
      deps.bus,
      { ...actor, facilityId: bill.facility_id },
      bill.encounter_id,
      meta,
    );
  return { payment, receipt, bill, advanced };
}

const paymentResult = ({ payment, receipt, bill, advanced }, extra = {}) => ({
  payment: {
    id: payment.id,
    method: payment.method,
    amount: money(payment.amount),
    reference: payment.reference,
    receivedAt: payment.received_at,
  },
  receipt: { id: receipt.id, receiptNumber: receipt.receipt_number },
  bill: { id: bill.id, billNumber: bill.bill_number, balance: money(bill.balance), status: bill.status },
  sentTo: advanced?.nextTicket
    ? { label: advanced.nextTicket.label, servicePointName: advanced.nextTicket.servicePointName }
    : null,
  ...extra,
});

/**
 * Take a cash, card or bank payment at the desk.
 * @param {Deps} deps @param {AuthContext} auth @param {string} billId @param {any} input @param {Meta} meta
 */
export async function receivePayment(deps, auth, billId, input, meta) {
  const { db } = deps;
  if (input.clientId) {
    const existing = await db('payments as p')
      .join('receipts as r', 'r.payment_id', 'p.id')
      .where('p.client_id', input.clientId)
      .first('p.*', 'r.id as rid', 'r.receipt_number');
    if (existing) {
      const bill = await db('bills').where({ id: existing.bill_id }).first();
      return paymentResult(
        {
          payment: existing,
          receipt: { id: existing.rid, receipt_number: existing.receipt_number },
          bill,
          advanced: null,
        },
        { replayed: true },
      );
    }
  }
  return db.transaction(async (trx) => {
    const bill = await trx('bills')
      .where({ id: billId, facility_id: facilityOf(auth) })
      .forUpdate()
      .first();
    if (!bill) throw notFound('Bill');
    if (bill.status === 'cancelled') throw conflict('This bill is cancelled');
    if (toCents(input.amount) > toCents(bill.balance))
      throw new AppError(409, 'OVERPAYMENT', `The patient owes ${money(bill.balance)}; take no more than that.`, {
        balance: money(bill.balance),
      });
    const shift = await requireOpenShift(trx, auth);
    const result = await recordPayment(
      trx,
      deps,
      auth,
      {
        bill,
        method: input.method,
        amount: input.amount,
        reference: input.reference,
        shiftId: shift.id,
        notes: input.notes,
        clientId: input.clientId,
      },
      meta,
    );
    const changeDue =
      input.method === 'cash' && input.tendered ? fromCents(toCents(input.tendered) - toCents(input.amount)) : null;
    return paymentResult(result, { changeDue });
  });
}

/**
 * Receipt for printing (80 mm), with facility letterhead details.
 * @param {Deps} deps @param {AuthContext} auth @param {string} id @param {{reprint?: boolean}} [opts] @param {Meta} [meta]
 */
export async function getReceipt({ db }, auth, id, opts = {}, meta = {}) {
  const r = await db('receipts as r')
    .join('payments as p', 'p.id', 'r.payment_id')
    .join('bills as b', 'b.id', 'p.bill_id')
    .join('facilities as f', 'f.id', 'r.facility_id')
    .leftJoin('patients as pt', 'pt.id', 'b.patient_id')
    .leftJoin('users as u', 'u.id', 'r.issued_by')
    .leftJoin('patient_payer_schemes as ps', 'ps.id', 'b.patient_payer_scheme_id')
    .leftJoin('schemes as s', 's.id', 'ps.scheme_id')
    .where({ 'r.id': id, 'r.facility_id': facilityOf(auth) })
    .first(
      'r.*',
      'p.method',
      'p.amount',
      'p.reference',
      'p.received_at',
      'b.bill_number',
      'b.total_amount',
      'b.payer_amount',
      'b.patient_amount',
      'b.paid_amount',
      'b.balance',
      'f.name as facility_name',
      'f.kmhfl_code',
      'f.address',
      'f.phone as facility_phone',
      'pt.mrn',
      'pt.first_name',
      'pt.middle_name',
      'pt.last_name',
      'b.customer_name',
      'u.full_name as cashier_name',
      's.name as scheme_name',
    );
  if (!r) throw notFound('Receipt');
  if (opts.reprint) {
    await db('receipts').where({ id }).increment('reprint_count', 1);
    await recordAudit(db, actorOf(auth), meta, {
      action: 'view',
      entityType: 'receipt',
      entityId: id,
      metadata: { reprint: r.reprint_count + 1 },
    });
  }
  return {
    id: r.id,
    receiptNumber: r.receipt_number,
    issuedAt: r.issued_at,
    reprintCount: r.reprint_count + (opts.reprint ? 1 : 0),
    facility: { name: r.facility_name, kmhflCode: r.kmhfl_code, address: r.address, phone: r.facility_phone },
    patient: {
      mrn: r.mrn,
      fullName: r.first_name ? [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' ') : r.customer_name,
    },
    billNumber: r.bill_number,
    schemeName: r.scheme_name,
    payment: { method: r.method, amount: money(r.amount), reference: r.reference, receivedAt: r.received_at },
    bill: {
      totalAmount: money(r.total_amount),
      payerAmount: money(r.payer_amount),
      patientAmount: money(r.patient_amount),
      paidAmount: money(r.paid_amount),
      balance: money(r.balance),
    },
    cashierName: r.cashier_name ?? 'M-Pesa',
    etims: {
      status: r.etims_status,
      invoiceNumber: r.etims_invoice_number,
      controlUnitId: r.etims_status === 'submitted' ? (r.etims_response?.controlUnitId ?? null) : null,
      signature: r.etims_status === 'submitted' ? (r.etims_response?.signature ?? null) : null,
    },
  };
}

// ---- M-Pesa STK Push -------------------------------------------------------------

const toMpesa = (t) => ({
  id: t.id,
  kind: t.kind,
  status: t.status,
  amount: money(t.amount),
  billId: t.bill_id,
  accountReference: t.account_reference,
  checkoutRequestId: t.checkout_request_id,
  mpesaReceipt: t.mpesa_receipt,
  resultCode: t.result_code,
  resultDesc: t.result_desc,
  paymentId: t.payment_id,
  createdAt: t.created_at,
  completedAt: t.completed_at,
});

/**
 * Prompt the patient's phone for payment (Lipa na M-Pesa Online).
 * @param {Deps} deps @param {AuthContext} auth @param {string} billId @param {{phone: string, amount: string}} input @param {Meta} meta
 */
export async function initiateStk(deps, auth, billId, input, meta) {
  const { db, crypto, mpesa } = deps;
  const txn = await db.transaction(async (trx) => {
    const bill = await trx('bills')
      .where({ id: billId, facility_id: facilityOf(auth) })
      .forUpdate()
      .first();
    if (!bill) throw notFound('Bill');
    if (bill.status === 'cancelled') throw conflict('This bill is cancelled');
    if (toCents(input.amount) > toCents(bill.balance))
      throw new AppError(409, 'OVERPAYMENT', `The patient owes ${money(bill.balance)}; request no more than that.`, {
        balance: money(bill.balance),
      });
    const shift = await requireOpenShift(trx, auth);
    const [t] = await trx('mpesa_transactions')
      .insert({
        facility_id: bill.facility_id,
        bill_id: bill.id,
        shift_id: shift.id,
        kind: 'stk',
        phone_enc: crypto.encrypt(input.phone),
        phone_hash: crypto.blindIndex('phone', input.phone),
        amount: input.amount,
        account_reference: bill.bill_number,
        initiated_by: auth.userId,
      })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'create',
      entityType: 'mpesa_transaction',
      entityId: t.id,
      patientId: bill.patient_id,
      after: t,
    });
    return t;
  });
  try {
    const r = await mpesa.stkPush({
      phone: input.phone,
      amount: input.amount,
      accountReference: txn.account_reference,
      description: 'Hospital bill',
    });
    const [t] = await db('mpesa_transactions')
      .where({ id: txn.id })
      .update({ merchant_request_id: r.merchantRequestId, checkout_request_id: r.checkoutRequestId })
      .returning('*');
    return toMpesa(t);
  } catch (err) {
    await db('mpesa_transactions')
      .where({ id: txn.id })
      .update({ status: 'failed', result_desc: String(err.message).slice(0, 300), completed_at: db.fn.now() });
    throw new AppError(502, err.code ?? 'MPESA_ERROR', `M-Pesa did not accept the request: ${err.message}`);
  }
}

/** @param {Deps} deps @param {AuthContext} auth @param {string} id */
export async function getMpesa({ db }, auth, id) {
  const t = await db('mpesa_transactions')
    .where({ id, facility_id: facilityOf(auth) })
    .first();
  if (!t) throw notFound('M-Pesa request');
  const receipt = t.payment_id
    ? await db('receipts').where({ payment_id: t.payment_id }).first('id', 'receipt_number')
    : null;
  return { ...toMpesa(t), receipt: receipt ? { id: receipt.id, receiptNumber: receipt.receipt_number } : null };
}

/** Initiator of a transaction, as the actor for its callback. */
async function initiatorOf(trx, t) {
  const u = t.initiated_by ? await trx('users').where({ id: t.initiated_by }).first('id', 'username') : null;
  return { userId: u?.id ?? null, username: u?.username ?? 'mpesa', roles: [], facilityId: t.facility_id };
}

/**
 * Settle a pending STK transaction (from the callback or a status query).
 * Idempotent: anything already settled is left alone.
 */
async function settleStk(deps, checkoutRequestId, outcome, raw) {
  return deps.db.transaction(async (trx) => {
    const t = await trx('mpesa_transactions').where({ checkout_request_id: checkoutRequestId }).forUpdate().first();
    if (!t) return { matched: false };
    if (t.status !== 'pending') return { matched: true, status: t.status };
    const status = stkStatusFor(outcome.resultCode);
    if (status !== 'completed') {
      await trx('mpesa_transactions')
        .where({ id: t.id })
        .update({
          status,
          result_code: outcome.resultCode,
          result_desc: outcome.resultDesc,
          raw_callback: raw ? JSON.stringify(raw) : null,
          completed_at: trx.fn.now(),
        });
      return { matched: true, status };
    }
    const bill = await trx('bills').where({ id: t.bill_id }).forUpdate().first();
    const actor = await initiatorOf(trx, t);
    const amount = outcome.amount ? fromCents(toCents(outcome.amount)) : money(t.amount);
    if (toCents(amount) !== toCents(t.amount))
      deps.logger?.warn(
        { transactionId: t.id, requested: money(t.amount), received: amount },
        'M-Pesa amount differs from the request; recording what was received',
      );
    const reference = outcome.receipt ?? `CHK-${t.checkout_request_id}`.slice(0, 60);
    const result = await recordPayment(
      trx,
      deps,
      actor,
      { bill, method: 'mpesa', amount, reference, shiftId: t.shift_id },
      SYSTEM_META,
    );
    await trx('mpesa_transactions')
      .where({ id: t.id })
      .update({
        status: 'completed',
        result_code: 0,
        result_desc: outcome.resultDesc,
        mpesa_receipt: outcome.receipt ?? null,
        payment_id: result.payment.id,
        raw_callback: raw ? JSON.stringify(raw) : null,
        completed_at: trx.fn.now(),
      });
    return { matched: true, status: 'completed', receiptNumber: result.receipt.receipt_number };
  });
}

/** Daraja STK callback (unauthenticated; the route checks the secret URL token). @param {Deps} deps @param {any} body */
export async function handleStkCallback(deps, body) {
  const cb = parseStkCallback(body);
  const r = await settleStk(deps, cb.checkoutRequestId, cb, body);
  if (!r.matched)
    deps.logger?.warn(
      { checkoutRequestId: cb.checkoutRequestId },
      'M-Pesa callback for an unknown request; the status job will reconcile',
    );
  return r;
}

/**
 * Ask Daraja for the outcome of a pending request (when the callback is late or lost).
 * @param {Deps} deps @param {AuthContext|null} auth null = background job @param {string} id
 */
export async function queryStk(deps, auth, id) {
  const q = deps.db('mpesa_transactions').where({ id });
  if (auth) q.andWhere({ facility_id: facilityOf(auth) });
  const t = await q.first();
  if (!t) throw notFound('M-Pesa request');
  if (t.status === 'pending' && t.checkout_request_id) {
    const r = await deps.mpesa.queryStk(t.checkout_request_id);
    if (r.resultCode !== null)
      await settleStk(
        deps,
        t.checkout_request_id,
        { resultCode: r.resultCode, resultDesc: r.resultDesc, amount: null, receipt: null },
        null,
      );
  }
  return auth ? getMpesa(deps, auth, id) : null;
}

/** Background reconciliation: query requests still pending after a minute (up to a day old). @param {Deps} deps */
export async function reconcilePendingStk(deps) {
  const ids = await deps
    .db('mpesa_transactions')
    .where({ status: 'pending', kind: 'stk' })
    .whereNotNull('checkout_request_id')
    .andWhere('created_at', '<', deps.db.raw(`now() - interval '60 seconds'`))
    .andWhere('created_at', '>', deps.db.raw(`now() - interval '1 day'`))
    .limit(50)
    .pluck('id');
  for (const id of ids) {
    try {
      await queryStk(deps, null, id);
    } catch (err) {
      deps.logger?.warn({ err, id }, 'M-Pesa status query failed');
    }
  }
  return ids.length;
}

// ---- M-Pesa Paybill (C2B) -------------------------------------------------------

/**
 * Paybill confirmation: match the account number (bill number, or an MRN with an
 * outstanding bill) and record the payment; otherwise keep it for manual matching.
 * Idempotent on the M-Pesa transaction id.
 * @param {Deps} deps @param {any} body
 */
export async function handleC2bConfirmation(deps, body) {
  const { db, crypto } = deps;
  const transId = String(body.TransID ?? '');
  if (!transId) throw badRequest('Missing TransID');
  const ref = String(body.BillRefNumber ?? '')
    .trim()
    .toUpperCase();
  const phone = body.MSISDN ? `+${String(body.MSISDN).replace(/^\+/, '')}` : null;
  return db.transaction(async (trx) => {
    if (await trx('mpesa_transactions').where({ mpesa_receipt: transId }).first('id')) return { duplicate: true };
    let bill = await trx('bills')
      .whereRaw('upper(bill_number) = ?', [ref])
      .whereNot('status', 'cancelled')
      .forUpdate()
      .first();
    if (!bill && ref) {
      const p = await trx('patients').whereRaw('upper(mrn) = ?', [ref]).whereNull('merged_into_id').first('id');
      if (p)
        bill = await trx('bills')
          .where({ patient_id: p.id })
          .andWhere('balance', '>', 0)
          .whereNot('status', 'cancelled')
          .orderBy('opened_at', 'desc')
          .forUpdate()
          .first();
    }
    const [t] = await trx('mpesa_transactions')
      .insert({
        facility_id: bill?.facility_id ?? null,
        bill_id: bill?.id ?? null,
        kind: 'c2b',
        phone_enc: crypto.encrypt(phone),
        phone_hash: phone ? crypto.blindIndex('phone', phone) : null,
        amount: fromCents(toCents(body.TransAmount)),
        account_reference: ref || null,
        mpesa_receipt: transId,
        status: bill ? 'pending' : 'unmatched',
        raw_callback: JSON.stringify(body),
      })
      .returning('*');
    if (!bill) return { matched: false, id: t.id };
    const result = await recordPayment(
      trx,
      deps,
      { userId: null, username: 'mpesa-paybill', roles: [], facilityId: bill.facility_id },
      { bill, method: 'mpesa', amount: money(t.amount), reference: transId },
      SYSTEM_META,
    );
    await trx('mpesa_transactions')
      .where({ id: t.id })
      .update({ status: 'completed', payment_id: result.payment.id, completed_at: trx.fn.now() });
    return { matched: true, receiptNumber: result.receipt.receipt_number };
  });
}

/** Paybill payments nobody could match. @param {Deps} deps @param {AuthContext} auth */
export async function listUnmatched({ db, crypto }, auth) {
  facilityOf(auth);
  const rows = await db('mpesa_transactions').where({ status: 'unmatched' }).orderBy('created_at', 'desc').limit(100);
  return rows.map((t) => {
    const phone = crypto.decrypt(t.phone_enc);
    return { ...toMpesa(t), phoneMasked: phone ? `${phone.slice(0, 6)}•••${phone.slice(-3)}` : null };
  });
}

/** Attach an unmatched Paybill payment to a bill. @param {Deps} deps @param {AuthContext} auth @param {string} id @param {string} billId @param {Meta} meta */
export async function matchC2b(deps, auth, id, billId, meta) {
  return deps.db.transaction(async (trx) => {
    const t = await trx('mpesa_transactions').where({ id, status: 'unmatched' }).forUpdate().first();
    if (!t) throw notFound('Unmatched M-Pesa payment');
    const bill = await trx('bills')
      .where({ id: billId, facility_id: facilityOf(auth) })
      .forUpdate()
      .first();
    if (!bill) throw notFound('Bill');
    if (bill.status === 'cancelled') throw conflict('This bill is cancelled');
    const result = await recordPayment(
      trx,
      deps,
      auth,
      {
        bill,
        method: 'mpesa',
        amount: money(t.amount),
        reference: t.mpesa_receipt,
        notes: 'Paybill payment matched by hand',
      },
      meta,
    );
    await trx('mpesa_transactions').where({ id }).update({
      status: 'completed',
      facility_id: bill.facility_id,
      bill_id: bill.id,
      payment_id: result.payment.id,
      completed_at: trx.fn.now(),
    });
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'mpesa_transaction',
      entityId: id,
      patientId: bill.patient_id,
      metadata: { matchedTo: bill.bill_number },
    });
    return paymentResult(result);
  });
}
