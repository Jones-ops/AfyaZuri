import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSmsMock } from '../../../../deploy/mocks/sms-mock.js';
import { reconcileEtims } from '../../src/modules/notifications/etims.js';
import { makeApp, signIn } from '../helpers.js';

let ctx;
let smsServer;
let smsMock;
let clerk;
let cashier;
let billing;
let accountant;

const letters = (n) =>
  Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const key = () => `k-${crypto.randomUUID()}`;
const phone = () => `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

/** Deliver everything in the outbox (eTIMS and SMS run there). */
async function drainOutbox() {
  for (let i = 0; i < 50; i += 1) if ((await ctx.bus.dispatchPending(ctx.db, { limit: 200 })) === 0) return;
}

beforeAll(async () => {
  smsMock = createSmsMock();
  smsServer = await new Promise((ok) => {
    const s = createServer(smsMock).listen(0, '127.0.0.1', () => ok(s));
  });
  ctx = makeApp({ SMS_ENV: 'mock', SMS_BASE_URL: `http://127.0.0.1:${smsServer.address().port}`, ETIMS_ENV: 'mock' });
  [clerk, cashier, billing, accountant] = await Promise.all(
    ['records', 'cashier', 'billing', 'accountant'].map((u) => signIn(ctx.app, u)),
  );
  // Clear the outbox backlog left by earlier test files, then give the cashier a fresh shift.
  await drainOutbox();
  const u = await ctx.db('users').where({ username: 'cashier' }).first('id');
  await ctx
    .db('cashier_shifts')
    .where({ cashier_id: u.id, status: 'open' })
    .update({ status: 'closed', closed_at: ctx.db.fn.now() });
  expect((await cashier.post('/api/v1/shifts', { openingFloat: '1000' })).status).toBe(201);
});
afterAll(async () => {
  await new Promise((r) => smsServer.close(r));
  await ctx.db.destroy();
});

/** Cash patient checked in (bill 700 = registration 200 + consultation 500). */
async function cashVisit({ smsConsent = false } = {}) {
  const tel = phone();
  const p = (
    await clerk.post('/api/v1/patients', {
      firstName: cap(letters(7)),
      lastName: cap(letters(8)),
      sex: 'female',
      dateOfBirth: `19${50 + Math.floor(Math.random() * 49)}-0${1 + Math.floor(Math.random() * 8)}-1${Math.floor(Math.random() * 9)}`,
      phone: tel,
      consents: smsConsent ? [{ consentType: 'sms', granted: true, method: 'verbal' }] : [],
    })
  ).body;
  expect(p.id).toBeTruthy();
  const e = (await clerk.post('/api/v1/encounters', { patientId: p.id })).body;
  const bill = (await cashier.get(`/api/v1/encounters/${e.id}/bill`)).body;
  return { patient: p, encounter: e, bill, msisdn: `+254${tel.slice(1)}` };
}

const pay = (billId, body) => cashier.post(`/api/v1/bills/${billId}/payments`, body).set('Idempotency-Key', key());
const getBill = async (id) => (await cashier.get(`/api/v1/bills/${id}`)).body;

describe('waivers', () => {
  it('needs a second person to approve, and a full waiver sends a pay-first patient on', async () => {
    const { bill, encounter } = await cashVisit();
    const body = { amount: '700', reason: 'Hardship: assessed by the social worker' };
    expect((await cashier.post(`/api/v1/bills/${bill.id}/waivers`, body)).body.error.code).toBe(
      'IDEMPOTENCY_KEY_REQUIRED',
    );
    expect(
      (
        await cashier
          .post(`/api/v1/bills/${bill.id}/waivers`, { ...body, reason: 'short' })
          .set('Idempotency-Key', key())
      ).status,
    ).toBe(400);
    expect(
      (await cashier.post(`/api/v1/bills/${bill.id}/waivers`, { ...body, amount: '800' }).set('Idempotency-Key', key()))
        .body.error.code,
    ).toBe('EXCEEDS_LIMIT');

    const k = key();
    const w = await cashier.post(`/api/v1/bills/${bill.id}/waivers`, body).set('Idempotency-Key', k);
    expect(w.status).toBe(201);
    expect(w.body).toMatchObject({ kind: 'waiver', status: 'requested', amount: '700.00', requestedBy: 'John Kamau' });
    // A retried click replays rather than raising a second request.
    const again = await cashier.post(`/api/v1/bills/${bill.id}/waivers`, body).set('Idempotency-Key', k);
    expect(again.body.id).toBe(w.body.id);
    // Nothing more can be requested while 700 is under review.
    expect(
      (await billing.post(`/api/v1/bills/${bill.id}/waivers`, { ...body, amount: '1' }).set('Idempotency-Key', key()))
        .body.error.code,
    ).toBe('EXCEEDS_LIMIT');

    // The cashier cannot approve at all; the billing officer can.
    expect((await cashier.post(`/api/v1/waivers/${w.body.id}/decision`, { approve: true })).status).toBe(403);
    const ok = await billing.post(`/api/v1/waivers/${w.body.id}/decision`, { approve: true, note: 'Approved' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      status: 'approved',
      decidedBy: 'Ruth Wambui',
      sentTo: { servicePointName: 'Triage' },
    });
    expect((await getBill(bill.id)).balance).toBe('0.00');
    expect((await clerk.get(`/api/v1/encounters/${encounter.id}`)).body.currentTicket.servicePointName).toBe('Triage');
    // Decided once only.
    expect((await accountant.post(`/api/v1/waivers/${w.body.id}/decision`, { approve: false })).status).toBe(409);

    const audit = await ctx
      .db('audit_log')
      .where({ entity_type: 'waiver', entity_id: w.body.id })
      .orderBy('occurred_at');
    expect(audit.map((a) => a.action)).toEqual(['create', 'approve']);
  });

  it('refuses self-approval, even by someone who holds the approve permission', async () => {
    const { bill } = await cashVisit();
    const w = await billing
      .post(`/api/v1/bills/${bill.id}/waivers`, { amount: '200', reason: 'Staff dependant, per policy' })
      .set('Idempotency-Key', key());
    const self = await billing.post(`/api/v1/waivers/${w.body.id}/decision`, { approve: true });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('SELF_APPROVAL');
    // It is not in their inbox either, but it is in the accountant's.
    expect((await billing.get('/api/v1/approvals')).body.toDecide.map((a) => a.id)).not.toContain(w.body.id);
    expect((await accountant.get('/api/v1/approvals')).body.toDecide.map((a) => a.id)).toContain(w.body.id);
    const no = await accountant.post(`/api/v1/waivers/${w.body.id}/decision`, { approve: false, note: 'Not eligible' });
    expect(no.body.status).toBe('rejected');
    expect((await getBill(bill.id)).balance).toBe('700.00');
  });

  it('re-checks the balance at approval time', async () => {
    const { bill } = await cashVisit();
    const w = await cashier
      .post(`/api/v1/bills/${bill.id}/waivers`, { amount: '500', reason: 'Hardship, partial waiver' })
      .set('Idempotency-Key', key());
    await pay(bill.id, { method: 'cash', amount: '300' }); // balance now 400
    const late = await billing.post(`/api/v1/waivers/${w.body.id}/decision`, { approve: true });
    expect(late.body.error.code).toBe('EXCEEDS_LIMIT');
  });

  it('keeps facilities apart', async () => {
    const { bill } = await cashVisit();
    const other = await ctx.db('facilities').where({ kmhfl_code: '99002' }).first('id');
    const requester = await ctx.db('users').where({ username: 'records' }).first('id');
    // The composite foreign key refuses a waiver that claims another facility's bill.
    await expect(
      ctx
        .db('waivers')
        .insert({ facility_id: other.id, bill_id: bill.id, amount: '1', reason: 'x', requested_by: requester.id }),
    ).rejects.toThrow(/foreign key/);
    expect((await billing.get(`/api/v1/waivers/${crypto.randomUUID()}`)).status).toBe(404);
  });
});

describe('credit notes and refunds', () => {
  it('credits a wrong charge, refunds the overpayment in cash, and reports both to eTIMS', async () => {
    const { bill } = await cashVisit();
    const paid = await pay(bill.id, { method: 'cash', amount: '700' });
    expect(paid.status).toBe(201);
    await drainOutbox();
    const receipt = (await cashier.get(`/api/v1/receipts/${paid.body.receipt.id}`)).body;
    expect(receipt.etims).toMatchObject({ status: 'submitted' });
    expect(receipt.etims.invoiceNumber).toMatch(/^KRACU/);
    expect(receipt.etims.signature).toMatch(/^[0-9A-F]{4}-/);

    // Refund before the bill shows an overpayment: allowed to request, but cannot be paid out.
    const early = await cashier
      .post(`/api/v1/bills/${bill.id}/refunds`, {
        kind: 'refund',
        paymentId: paid.body.payment.id,
        amount: '200',
        reason: 'Registration fee charged in error',
      })
      .set('Idempotency-Key', key());
    expect(early.status).toBe(201);
    expect((await accountant.post(`/api/v1/refunds/${early.body.id}/decision`, { approve: true })).body.status).toBe(
      'approved',
    );
    const blocked = await cashier
      .post(`/api/v1/refunds/${early.body.id}/pay`, { method: 'cash' })
      .set('Idempotency-Key', key());
    expect(blocked.body.error.code).toBe('NOT_OVERPAID');

    // Credit note for the registration line (the patient is a returning patient).
    const cn = await billing
      .post(`/api/v1/bills/${bill.id}/refunds`, {
        kind: 'credit_note',
        amount: '200',
        reason: 'Returning patient charged the new-patient fee',
      })
      .set('Idempotency-Key', key());
    expect(cn.status).toBe(201);
    expect(
      (
        await billing
          .post(`/api/v1/bills/${bill.id}/refunds`, {
            kind: 'credit_note',
            amount: '600',
            reason: 'Too much credit here',
          })
          .set('Idempotency-Key', key())
      ).body.error.code,
    ).toBe('EXCEEDS_LIMIT'); // 700 charged, 200 already under review
    expect((await billing.post(`/api/v1/refunds/${cn.body.id}/decision`, { approve: true })).status).toBe(403); // no refund.approve
    const approved = await accountant.post(`/api/v1/refunds/${cn.body.id}/decision`, { approve: true });
    expect(approved.body).toMatchObject({ status: 'approved', etims: { status: 'pending' } });
    expect(approved.body.documentNumber).toMatch(/^CRN-\d{4}-\d{6}$/);
    expect((await getBill(bill.id)).balance).toBe('-200.00');

    await drainOutbox();
    const cnAfter = (await cashier.get(`/api/v1/refunds/${cn.body.id}`)).body;
    expect(cnAfter.etims.status).toBe('submitted');
    const reported = ctx.etims.submitted.at(-1);
    expect(reported).toMatchObject({ kind: 'credit_note', documentNumber: cnAfter.documentNumber, total: '200.00' });
    expect(reported.originalInvoiceNumber).toBe(receipt.etims.invoiceNumber);

    // Now the refund can go out of the drawer, once.
    const before = (await cashier.get('/api/v1/shifts/current')).body.shift.systemTotals.cash;
    const out = await cashier
      .post(`/api/v1/refunds/${early.body.id}/pay`, { method: 'cash' })
      .set('Idempotency-Key', key());
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ status: 'paid', method: 'cash', paidBy: 'John Kamau' });
    expect(out.body.documentNumber).toMatch(/^RFD-/);
    const after = (await cashier.get('/api/v1/shifts/current')).body.shift.systemTotals.cash;
    expect(Number(after.expected)).toBe(Number(before.expected) - 200);
    expect(after.refunded).toBe(String((Number(before.refunded) + 200).toFixed(2)));
    const b = await getBill(bill.id);
    expect(b).toMatchObject({ balance: '0.00', creditedAmount: '200.00', refundedAmount: '200.00' });
    expect(
      (await cashier.post(`/api/v1/refunds/${early.body.id}/pay`, { method: 'cash' }).set('Idempotency-Key', key()))
        .body.error.code,
    ).toBe('CONFLICT');
  });

  it('never refunds more than the payment', async () => {
    const { bill } = await cashVisit();
    const paid = await pay(bill.id, { method: 'card', amount: '300', reference: `AUTH${letters(5)}` });
    const req = (amount) =>
      cashier
        .post(`/api/v1/bills/${bill.id}/refunds`, {
          kind: 'refund',
          paymentId: paid.body.payment.id,
          amount,
          reason: 'Card charged twice by mistake',
        })
        .set('Idempotency-Key', key());
    expect((await req('301')).body.error.code).toBe('EXCEEDS_LIMIT');
    expect((await req('300')).status).toBe(201);
    expect((await req('1')).body.error.code).toBe('EXCEEDS_LIMIT'); // the first request holds it all
    const missing = await cashier
      .post(`/api/v1/bills/${bill.id}/refunds`, { kind: 'refund', amount: '10', reason: 'No payment chosen here' })
      .set('Idempotency-Key', key());
    expect(missing.status).toBe(400);
  });

  it('needs a reference for non-cash payouts and an open shift', async () => {
    const { bill } = await cashVisit();
    const paid = await pay(bill.id, { method: 'cash', amount: '700' });
    const f = await cashier
      .post(`/api/v1/bills/${bill.id}/refunds`, {
        kind: 'refund',
        paymentId: paid.body.payment.id,
        amount: '100',
        reason: 'Overcharged on consultation',
      })
      .set('Idempotency-Key', key());
    await accountant.post(`/api/v1/refunds/${f.body.id}/decision`, { approve: true });
    const noRef = await cashier
      .post(`/api/v1/refunds/${f.body.id}/pay`, { method: 'mpesa' })
      .set('Idempotency-Key', key());
    expect(noRef.status).toBe(400);
    const noShift = await billing
      .post(`/api/v1/refunds/${f.body.id}/pay`, { method: 'cash' })
      .set('Idempotency-Key', key());
    expect(noShift.body.error.code).toBe('NOT_OVERPAID'); // checked before the shift: nothing overpaid yet
  });
});

describe('eTIMS retries', () => {
  it('marks a failed submission and lets staff retry it', async () => {
    const { bill } = await cashVisit();
    await drainOutbox(); // earlier receipts first, so the failure lands on this one
    ctx.etims.failNext = 1;
    const paid = await pay(bill.id, { method: 'cash', amount: '700' });
    await drainOutbox();
    const rid = paid.body.receipt.id;
    expect((await cashier.get(`/api/v1/receipts/${rid}`)).body.etims.status).toBe('failed');
    expect((await clerk.post(`/api/v1/receipts/${rid}/etims-retry`)).status).toBe(403);
    const retry = await cashier.post(`/api/v1/receipts/${rid}/etims-retry`);
    expect(retry.body).toEqual({ status: 'submitted' });
    expect((await cashier.post(`/api/v1/receipts/${rid}/etims-retry`)).status).toBe(409);
  });
});

describe('eTIMS sweep', () => {
  it('reports receipts the outbox gave up on', async () => {
    const { bill } = await cashVisit();
    const paid = await pay(bill.id, { method: 'cash', amount: '700' });
    await drainOutbox();
    const rid = paid.body.receipt.id;
    // As if KRA had been down past every retry, an hour ago.
    await ctx
      .db('receipts')
      .where({ id: rid })
      .update({
        etims_status: 'failed',
        etims_invoice_number: null,
        issued_at: ctx.db.raw("now() - interval '1 hour'"),
      });
    expect(await reconcileEtims(ctx)).toBeGreaterThanOrEqual(1);
    expect((await ctx.db('receipts').where({ id: rid }).first()).etims_status).toBe('submitted');
  });
});

describe('SMS', () => {
  it('texts a consenting patient once, in Kiswahili, and never a patient without consent', async () => {
    const yes = await cashVisit({ smsConsent: true });
    const no = await cashVisit();
    const p1 = await pay(yes.bill.id, { method: 'cash', amount: '700' });
    await pay(no.bill.id, { method: 'cash', amount: '700' });
    await drainOutbox();

    const got = smsMock.messages.filter((m) => m.to === yes.msisdn);
    expect(got).toHaveLength(1);
    expect(got[0].message).toContain('Tumepokea KES 700 kwa pesa taslimu');
    expect(got[0].message).toContain(p1.body.receipt.receiptNumber);
    expect(smsMock.messages.filter((m) => m.to === no.msisdn)).toHaveLength(0);

    const rows = await ctx.db('sms_messages').whereIn('patient_id', [yes.patient.id, no.patient.id]);
    expect(Object.fromEntries(rows.map((r) => [r.patient_id, r.status]))).toEqual({
      [yes.patient.id]: 'sent',
      [no.patient.id]: 'skipped_no_consent',
    });
    // The phone number is stored encrypted, never in clear.
    expect(rows.every((r) => !String(r.phone_enc).includes(yes.msisdn.slice(4)))).toBe(true);
    expect((await getBill(yes.bill.id)).payments[0].sms).toBe('sent');

    // Re-delivering the same event does not text again.
    await ctx
      .db('outbox_events')
      .where({ event_type: 'payment.completed', aggregate_id: p1.body.payment.id })
      .update({ status: 'pending', available_at: ctx.db.fn.now() });
    await drainOutbox();
    expect(smsMock.messages.filter((m) => m.to === yes.msisdn)).toHaveLength(1);
  });
});
