import '../../lib/db-types.js';
// Waivers, credit notes and refunds: maker-checker workflows on a bill.
//
//   waiver       forgives part of what the patient owes (e.g. a hardship exemption)
//   credit note  corrects the bill downwards (wrong charge, service not given); reported to eTIMS
//   refund       pays money back from a payment, once the bill shows it is overpaid
//
// Every request needs a second person to approve it: the requester can never decide their own
// request (checked here and by a database constraint). Bills are locked before any change, and
// limits are re-checked at decision time because the bill may have moved since the request.
import { fromCents, hasPermission, toCents } from '@afyazuri/shared';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { recordAudit } from '../audit/service.js';
import { advanceAfterPayment } from '../opd/service.js';
import { shiftTotals } from './payments.js';
import { facilityOf, nextNumber, recalcBill } from './service.js';

/**
 * @typedef {import('../../middleware/auth.js').AuthContext} AuthContext
 * @typedef {{ip?: string|null, userAgent?: string|null, requestId?: string|null}} Meta
 * @typedef {{db: import('knex').Knex, bus: import('../../lib/events.js').EventBus,
 *            etims?: import('../../integrations/etims.js').EtimsAdapter}} Deps
 */

const actorOf = (a) => ({ userId: a.userId, username: a.username, roles: a.roles, facilityId: a.facilityId });
const money = (v) => fromCents(toCents(v ?? 0));
const sumOf = async (q) => toCents((await q.sum({ s: 'amount' }).first()).s ?? 0);

const selfApproval = () =>
  new AppError(403, 'SELF_APPROVAL', 'Someone else must approve this: you raised the request.');
const exceeds = (what, limit) =>
  new AppError(409, 'EXCEEDS_LIMIT', `That is more than ${what} (KES ${money(fromCents(limit))}).`, {
    limit: fromCents(limit),
  });

/** Lock the bill (always before its waivers/refunds, so concurrent requests queue up). */
async function lockBill(trx, auth, billId) {
  const bill = await trx('bills')
    .where({ id: billId, facility_id: facilityOf(auth) })
    .forUpdate()
    .first();
  if (!bill) throw notFound('Bill');
  if (bill.status === 'cancelled') throw conflict('This bill is cancelled');
  return bill;
}

/** Waivers and credit notes still waiting for a decision reduce what can be requested next. */
const pendingReductions = async (trx, billId) =>
  (await sumOf(trx('waivers').where({ bill_id: billId, status: 'requested' }))) +
  (await sumOf(trx('refunds').where({ bill_id: billId, kind: 'credit_note', status: 'requested' })));

/** A settled pay-first patient leaves the cashier queue, whether paid, waived or credited. */
async function maybeAdvance(trx, deps, auth, bill, meta) {
  if (bill.encounter_id && bill.billing_mode === 'pay_first' && toCents(bill.balance) <= 0)
    return advanceAfterPayment(trx, deps.bus, auth, bill.encounter_id, meta);
  return null;
}

// ---- Waivers -----------------------------------------------------------------------

/**
 * Ask for part of the patient's balance to be waived.
 * @param {Deps} deps @param {AuthContext} auth @param {string} billId
 * @param {{amount: string, reason: string}} input @param {Meta} meta
 */
export async function requestWaiver(deps, auth, billId, input, meta) {
  const { db, bus } = deps;
  const id = await db.transaction(async (trx) => {
    const bill = await lockBill(trx, auth, billId);
    const room = toCents(bill.balance) - (await pendingReductions(trx, bill.id));
    if (toCents(input.amount) > room) throw exceeds('the balance not already under review', Math.max(room, 0));
    const [w] = await trx('waivers')
      .insert({
        facility_id: bill.facility_id,
        bill_id: bill.id,
        amount: input.amount,
        reason: input.reason,
        requested_by: auth.userId,
      })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'create',
      entityType: 'waiver',
      entityId: w.id,
      patientId: bill.patient_id,
      after: w,
      reason: input.reason,
      metadata: { billNumber: bill.bill_number },
    });
    await bus.publish(trx, {
      type: 'waiver.requested',
      aggregateType: 'waiver',
      aggregateId: w.id,
      facilityId: bill.facility_id,
      payload: { billId: bill.id, amount: money(w.amount) },
    });
    return w.id;
  });
  return getWaiver(deps, auth, id);
}

/**
 * Approve or reject a waiver. The approver must not be the requester.
 * @param {Deps} deps @param {AuthContext} auth @param {string} id
 * @param {{approve: boolean, note?: string|null}} input @param {Meta} meta
 */
export async function decideWaiver(deps, auth, id, input, meta) {
  const { db, bus } = deps;
  const out = await db.transaction(async (trx) => {
    const peek = await trx('waivers')
      .where({ id, facility_id: facilityOf(auth) })
      .first('bill_id');
    if (!peek) throw notFound('Waiver');
    const bill = await lockBill(trx, auth, peek.bill_id);
    const before = await trx('waivers').where({ id }).forUpdate().first();
    if (before.status !== 'requested') throw conflict(`This waiver was already ${before.status}`);
    if (before.requested_by === auth.userId) throw selfApproval();
    if (input.approve && toCents(before.amount) > toCents(bill.balance))
      throw exceeds('the current balance', Math.max(toCents(bill.balance), 0));
    const [after] = await trx('waivers')
      .where({ id })
      .update({
        status: input.approve ? 'approved' : 'rejected',
        decided_by: auth.userId,
        decided_at: trx.fn.now(),
        decision_note: input.note ?? null,
      })
      .returning('*');
    const totals = await recalcBill(trx, bill.id);
    await recordAudit(trx, actorOf(auth), meta, {
      action: input.approve ? 'approve' : 'reject',
      entityType: 'waiver',
      entityId: id,
      patientId: bill.patient_id,
      before,
      after,
      reason: input.note ?? undefined,
      metadata: { billNumber: bill.bill_number, amount: money(after.amount) },
    });
    await bus.publish(trx, {
      type: input.approve ? 'waiver.approved' : 'waiver.rejected',
      aggregateType: 'waiver',
      aggregateId: id,
      facilityId: bill.facility_id,
      payload: { billId: bill.id, amount: money(after.amount) },
    });
    const advanced = input.approve ? await maybeAdvance(trx, deps, auth, totals, meta) : null;
    return { advanced };
  });
  return { ...(await getWaiver(deps, auth, id)), sentTo: sentTo(out.advanced) };
}

/** @param {Deps} deps @param {AuthContext} auth @param {string} id */
export async function getWaiver({ db }, auth, id) {
  const w = await adjustmentQuery(db, 'waivers')
    .where({ 'x.id': id, 'x.facility_id': facilityOf(auth) })
    .first();
  if (!w) throw notFound('Waiver');
  return toAdjustment(w, 'waiver');
}

// ---- Credit notes and refunds --------------------------------------------------------

/**
 * Raise a credit note (reduces what the patient owes) or a refund (pays money back from a payment).
 * @param {Deps} deps @param {AuthContext} auth @param {string} billId
 * @param {{kind: 'refund'|'credit_note', amount: string, reason: string, paymentId?: string}} input @param {Meta} meta
 */
export async function requestRefund(deps, auth, billId, input, meta) {
  const { db, bus } = deps;
  const id = await db.transaction(async (trx) => {
    const bill = await lockBill(trx, auth, billId);
    if (input.kind === 'credit_note') {
      const room = await creditableCents(trx, bill);
      if (toCents(input.amount) > room) throw exceeds('the patient was charged and not yet credited', room);
    } else {
      const payment = await trx('payments')
        .where({ id: input.paymentId, bill_id: bill.id, status: 'completed' })
        .forUpdate()
        .first();
      if (!payment) throw badRequest('That payment is not on this bill');
      const room = await refundableCents(trx, payment);
      if (toCents(input.amount) > room) throw exceeds('is left to refund on that payment', room);
    }
    const [f] = await trx('refunds')
      .insert({
        facility_id: bill.facility_id,
        bill_id: bill.id,
        payment_id: input.kind === 'refund' ? input.paymentId : null,
        kind: input.kind,
        amount: input.amount,
        reason: input.reason,
        requested_by: auth.userId,
      })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'create',
      entityType: input.kind,
      entityId: f.id,
      patientId: bill.patient_id,
      after: f,
      reason: input.reason,
      metadata: { billNumber: bill.bill_number },
    });
    await bus.publish(trx, {
      type: `${input.kind}.requested`,
      aggregateType: input.kind,
      aggregateId: f.id,
      facilityId: bill.facility_id,
      payload: { billId: bill.id, amount: money(f.amount) },
    });
    return f.id;
  });
  return getRefund(deps, auth, id);
}

/** Patient share charged, less what is already waived, credited or awaiting a credit decision. */
async function creditableCents(trx, bill, excludeId = null) {
  const pending = await sumOf(
    trx('refunds')
      .where({ bill_id: bill.id, kind: 'credit_note', status: 'requested' })
      .modify((q) => excludeId && q.whereNot({ id: excludeId })),
  );
  return Math.max(
    toCents(bill.patient_amount) - toCents(bill.waived_amount) - toCents(bill.credited_amount) - pending,
    0,
  );
}

/** What is left of a payment once refunds already requested, approved or paid are counted. */
async function refundableCents(trx, payment, excludeId = null) {
  const taken = await sumOf(
    trx('refunds')
      .where({ payment_id: payment.id })
      .whereIn('status', ['requested', 'approved', 'paid'])
      .modify((q) => excludeId && q.whereNot({ id: excludeId })),
  );
  return Math.max(toCents(payment.amount) - taken, 0);
}

/**
 * Approve or reject a credit note or refund. An approved credit note takes effect at once (and
 * is queued for eTIMS); an approved refund waits for a cashier to pay it out.
 * @param {Deps} deps @param {AuthContext} auth @param {string} id
 * @param {{approve: boolean, note?: string|null}} input @param {Meta} meta
 */
export async function decideRefund(deps, auth, id, input, meta) {
  const { db, bus } = deps;
  const out = await db.transaction(async (trx) => {
    const peek = await trx('refunds')
      .where({ id, facility_id: facilityOf(auth) })
      .first('bill_id');
    if (!peek) throw notFound('Refund or credit note');
    const bill = await lockBill(trx, auth, peek.bill_id);
    const before = await trx('refunds').where({ id }).forUpdate().first();
    if (before.status !== 'requested') throw conflict(`This was already ${before.status}`);
    if (before.requested_by === auth.userId) throw selfApproval();
    const patch = {
      status: input.approve ? 'approved' : 'rejected',
      decided_by: auth.userId,
      decided_at: trx.fn.now(),
      decision_note: input.note ?? null,
    };
    if (input.approve && before.kind === 'credit_note') {
      const room = await creditableCents(trx, bill, id);
      if (toCents(before.amount) > room) throw exceeds('the patient was charged and not yet credited', room);
      patch.document_number = await nextNumber(trx, bill.facility_id, 'credit_note');
      patch.etims_status = deps.etims?.enabled ? 'pending' : 'not_required';
    }
    if (input.approve && before.kind === 'refund') {
      const payment = await trx('payments').where({ id: before.payment_id }).first();
      if (payment.status !== 'completed') throw conflict('That payment is no longer completed');
      patch.document_number = await nextNumber(trx, bill.facility_id, 'refund');
    }
    const [after] = await trx('refunds').where({ id }).update(patch).returning('*');
    const totals = await recalcBill(trx, bill.id);
    await recordAudit(trx, actorOf(auth), meta, {
      action: input.approve ? 'approve' : 'reject',
      entityType: before.kind,
      entityId: id,
      patientId: bill.patient_id,
      before,
      after,
      reason: input.note ?? undefined,
      metadata: { billNumber: bill.bill_number, amount: money(after.amount), documentNumber: after.document_number },
    });
    await bus.publish(trx, {
      type: `${before.kind}.${input.approve ? 'approved' : 'rejected'}`,
      aggregateType: before.kind,
      aggregateId: id,
      facilityId: bill.facility_id,
      payload: { billId: bill.id, amount: money(after.amount) },
    });
    const advanced =
      input.approve && before.kind === 'credit_note' ? await maybeAdvance(trx, deps, auth, totals, meta) : null;
    return { advanced };
  });
  return { ...(await getRefund(deps, auth, id)), sentTo: sentTo(out.advanced) };
}

/**
 * Pay out an approved refund from the cashier's open shift. Only what the bill shows as
 * overpaid can go back, so a refund never leaves the patient owing for money they were given.
 * @param {Deps} deps @param {AuthContext} auth @param {string} id
 * @param {{method: string, reference?: string|null}} input @param {Meta} meta
 */
export async function payRefund(deps, auth, id, input, meta) {
  const { db, bus } = deps;
  if (input.method !== 'cash' && !input.reference)
    throw badRequest('Enter the M-Pesa, card or bank reference for the refund', {
      issues: [{ path: 'reference', message: 'Required for non-cash refunds' }],
    });
  await db.transaction(async (trx) => {
    const peek = await trx('refunds')
      .where({ id, facility_id: facilityOf(auth) })
      .first('bill_id');
    if (!peek) throw notFound('Refund');
    const bill = await lockBill(trx, auth, peek.bill_id);
    const before = await trx('refunds').where({ id }).forUpdate().first();
    if (before.kind !== 'refund') throw conflict('A credit note is not paid out');
    if (before.status !== 'approved')
      throw conflict(before.status === 'paid' ? 'This refund was already paid' : 'This refund is not approved');
    const overpaid = -toCents(bill.balance);
    if (toCents(before.amount) > overpaid)
      throw new AppError(
        409,
        'NOT_OVERPAID',
        overpaid > 0
          ? `The bill shows only KES ${money(fromCents(overpaid))} overpaid. Void the wrong line or raise a credit note first.`
          : 'The bill does not show an overpayment. Void the wrong line or raise a credit note first.',
        { overpaid: fromCents(Math.max(overpaid, 0)) },
      );
    const shift = await trx('cashier_shifts')
      .where({ cashier_id: auth.userId, status: 'open', facility_id: bill.facility_id })
      .forUpdate()
      .first();
    if (!shift) throw new AppError(409, 'NO_OPEN_SHIFT', 'Open a cashier shift before paying out a refund');
    if (input.method === 'cash') {
      const totals = await shiftTotals(trx, shift);
      if (toCents(totals.cash.expected) < toCents(before.amount))
        throw new AppError(409, 'INSUFFICIENT_CASH', `Your drawer should hold only KES ${totals.cash.expected}.`);
    }
    const [after] = await trx('refunds')
      .where({ id })
      .update({
        status: 'paid',
        method: input.method,
        reference: input.reference ?? null,
        shift_id: shift.id,
        paid_by: auth.userId,
        paid_at: trx.fn.now(),
      })
      .returning('*');
    await recalcBill(trx, bill.id);
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'refund',
      entityId: id,
      patientId: bill.patient_id,
      before,
      after,
      metadata: { billNumber: bill.bill_number, paidOut: money(after.amount), method: input.method },
    });
    await bus.publish(trx, {
      type: 'refund.paid',
      aggregateType: 'refund',
      aggregateId: id,
      facilityId: bill.facility_id,
      payload: { billId: bill.id, amount: money(after.amount), method: input.method },
    });
  });
  return getRefund(deps, auth, id);
}

/** @param {Deps} deps @param {AuthContext} auth @param {string} id */
export async function getRefund({ db }, auth, id) {
  const f = await adjustmentQuery(db, 'refunds')
    .leftJoin('users as pb', 'pb.id', 'x.paid_by')
    .select('pb.full_name as paid_by_name')
    .where({ 'x.id': id, 'x.facility_id': facilityOf(auth) })
    .first();
  if (!f) throw notFound('Refund or credit note');
  return toAdjustment(f, f.kind);
}

// ---- Approvals inbox ----------------------------------------------------------------

/**
 * Requests waiting for this user's decision (only kinds they may approve, never their own),
 * plus approved refunds waiting to be paid out.
 * @param {Deps} deps @param {AuthContext} auth
 */
export async function listApprovals({ db }, auth) {
  const facilityId = facilityOf(auth);
  const can = (p) => hasPermission(auth.grants, p, { facilityId });
  const [waivers, refunds, toPay] = await Promise.all([
    can('billing.waiver.approve')
      ? adjustmentQuery(db, 'waivers')
          .where({ 'x.facility_id': facilityId, 'x.status': 'requested' })
          .orderBy('x.requested_at')
          .limit(200)
      : [],
    can('billing.refund.approve')
      ? adjustmentQuery(db, 'refunds')
          .where({ 'x.facility_id': facilityId, 'x.status': 'requested' })
          .orderBy('x.requested_at')
          .limit(200)
      : [],
    can('billing.payment.receive')
      ? adjustmentQuery(db, 'refunds')
          .where({ 'x.facility_id': facilityId, 'x.status': 'approved', 'x.kind': 'refund' })
          .orderBy('x.decided_at')
          .limit(200)
      : [],
  ]);
  return {
    // Your own requests are left out: someone else has to decide them.
    toDecide: [...waivers.map((w) => [w, 'waiver']), ...refunds.map((f) => [f, f.kind])]
      .filter(([r]) => r.requested_by !== auth.userId)
      .map(([r, kind]) => toAdjustment(r, kind))
      .sort((a, b) => new Date(a.requestedAt) - new Date(b.requestedAt)),
    toPay: toPay.map((f) => toAdjustment(f, 'refund')),
  };
}

// ---- Shapes -----------------------------------------------------------------------------

function adjustmentQuery(db, table) {
  return db(`${table} as x`)
    .join('bills as b', 'b.id', 'x.bill_id')
    .leftJoin('patients as p', 'p.id', 'b.patient_id')
    .leftJoin('users as rq', 'rq.id', 'x.requested_by')
    .leftJoin('users as d', 'd.id', 'x.decided_by')
    .select(
      'x.*',
      'b.bill_number',
      'b.balance as bill_balance',
      'p.mrn',
      'p.first_name',
      'p.middle_name',
      'p.last_name',
      'b.customer_name',
      'rq.full_name as requested_by_name',
      'd.full_name as decided_by_name',
    );
}

function toAdjustment(x, kind) {
  return {
    id: x.id,
    kind,
    amount: money(x.amount),
    reason: x.reason,
    status: x.status,
    bill: { id: x.bill_id, billNumber: x.bill_number, balance: money(x.bill_balance) },
    patient: {
      mrn: x.mrn ?? null,
      fullName: x.first_name ? [x.first_name, x.middle_name, x.last_name].filter(Boolean).join(' ') : x.customer_name,
    },
    requestedBy: x.requested_by_name,
    requestedById: x.requested_by,
    requestedAt: x.requested_at,
    decidedBy: x.decided_by_name ?? null,
    decidedAt: x.decided_at ?? null,
    decisionNote: x.decision_note ?? null,
    ...(kind === 'waiver'
      ? {}
      : {
          paymentId: x.payment_id,
          documentNumber: x.document_number ?? null,
          method: x.method ?? null,
          reference: x.reference ?? null,
          paidBy: x.paid_by_name ?? null,
          paidAt: x.paid_at ?? null,
          etims: { status: x.etims_status, invoiceNumber: x.etims_invoice_number ?? null },
        }),
  };
}

const sentTo = (advanced) =>
  advanced?.nextTicket
    ? { label: advanced.nextTicket.label, servicePointName: advanced.nextTicket.servicePointName }
    : null;
