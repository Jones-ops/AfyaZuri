import { createServer } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDarajaMock } from '../../../../deploy/mocks/daraja-mock.js';
import { client, makeApp } from '../helpers.js';

const TOKEN = 'test-callback-token-0123456789';
let ctx;
let server;
let mock;
let mockUrl;
let clerk;
let cashier;
let billing;

const letters = (n) =>
  Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const key = () => `k-${crypto.randomUUID()}`;
const listen = (handler) =>
  new Promise((ok) => {
    const s = createServer(handler);
    s.listen(0, '127.0.0.1', () => ok(s));
  });

/** Poll until fn() returns truthy (callbacks arrive asynchronously). */
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 150));
  }
}

beforeAll(async () => {
  // Mock Daraja and the API on real ports so callbacks are real HTTP round trips.
  mock = await listen(createDarajaMock({ delayMs: 200 }));
  mockUrl = `http://127.0.0.1:${mock.address().port}`;
  server = await listen();
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  ctx = makeApp({ MPESA_BASE_URL: mockUrl, MPESA_CALLBACK_BASE_URL: apiUrl, MPESA_CALLBACK_TOKEN: TOKEN });
  server.on('request', ctx.app);
  const login = async (u) => {
    const c = client(ctx.app);
    const res = await c.post('/api/v1/auth/login', { username: u, password: 'Afyazuri#2026' });
    expect(res.status).toBe(200);
    return c;
  };
  [clerk, cashier, billing] = await Promise.all(['records', 'cashier', 'billing'].map(login));
  // Clean slate for the cashier's shift.
  const u = await ctx.db('users').where({ username: 'cashier' }).first('id');
  await ctx
    .db('cashier_shifts')
    .where({ cashier_id: u.id, status: 'open' })
    .update({ status: 'closed', closed_at: ctx.db.fn.now() });
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => mock.close(r));
  await ctx.db.destroy();
});

/** New cash patient checked in; returns the visit and its bill (700 = registration + consultation). */
async function cashVisit() {
  const p = (
    await clerk.post('/api/v1/patients', {
      firstName: cap(letters(7)),
      lastName: cap(letters(8)),
      sex: 'female',
      dateOfBirth: `19${50 + Math.floor(Math.random() * 49)}-0${1 + Math.floor(Math.random() * 8)}-1${Math.floor(Math.random() * 9)}`,
      phone: `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
    })
  ).body;
  const e = (await clerk.post('/api/v1/encounters', { patientId: p.id })).body;
  const bill = (await cashier.get(`/api/v1/encounters/${e.id}/bill`)).body;
  return { patient: p, encounter: e, bill };
}

const pay = (billId, body, k = key()) =>
  cashier.post(`/api/v1/bills/${billId}/payments`, body).set('Idempotency-Key', k);

describe('cashier shifts and desk payments', () => {
  it('requires an open shift and one shift at a time', async () => {
    const { bill } = await cashVisit();
    expect((await pay(bill.id, { method: 'cash', amount: '700' })).body.error.code).toBe('NO_OPEN_SHIFT');
    const s = await cashier.post('/api/v1/shifts', { openingFloat: '2000' });
    expect(s.status).toBe(201);
    expect(s.body).toMatchObject({ status: 'open', openingFloat: '2000.00' });
    expect((await cashier.post('/api/v1/shifts', { openingFloat: '0' })).body.error.code).toBe('SHIFT_ALREADY_OPEN');
  });

  it('takes cash, issues a sequential receipt, gives change and sends a pay-first patient on to triage', async () => {
    const { bill, encounter } = await cashVisit();
    expect(
      (await cashier.post(`/api/v1/bills/${bill.id}/payments`, { method: 'cash', amount: '700' })).body.error.code,
    ).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const k = key();
    const res = await pay(bill.id, { method: 'cash', amount: '700', tendered: '1000' }, k);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      changeDue: '300.00',
      bill: { balance: '0.00' },
      sentTo: { servicePointName: 'Triage' },
    });
    expect(res.body.receipt.receiptNumber).toMatch(/^RCT-\d{4}-\d{6}$/);

    const replay = await pay(bill.id, { method: 'cash', amount: '700', tendered: '1000' }, k);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.body.receipt.receiptNumber).toBe(res.body.receipt.receiptNumber);

    const visit = (await clerk.get(`/api/v1/encounters/${encounter.id}`)).body;
    expect(visit.currentTicket.servicePointName).toBe('Triage');
    expect(visit.tickets[0]).toMatchObject({ queueName: 'Cashier', status: 'done' });

    const receipt = (await cashier.get(`/api/v1/receipts/${res.body.receipt.id}`)).body;
    expect(receipt).toMatchObject({
      payment: { method: 'cash', amount: '700.00' },
      bill: { balance: '0.00' },
      cashierName: 'John Kamau',
    });
    expect(receipt.facility.kmhflCode).toBe('99001');
    expect((await cashier.post(`/api/v1/receipts/${res.body.receipt.id}/reprint`)).body.reprintCount).toBe(1);
  });

  it('keeps part-paid patients at the cashier and refuses overpayment', async () => {
    const { bill, encounter } = await cashVisit();
    const part = await pay(bill.id, { method: 'card', amount: '200', reference: `AUTH${letters(4)}` });
    expect(part.body).toMatchObject({ bill: { balance: '500.00' }, sentTo: null });
    expect((await clerk.get(`/api/v1/encounters/${encounter.id}`)).body.currentTicket.queueName).toBe('Cashier');
    expect((await pay(bill.id, { method: 'cash', amount: '600' })).body.error.code).toBe('OVERPAYMENT');
    expect((await pay(bill.id, { method: 'bank', amount: '100' })).status).toBe(400); // needs a reference
  });

  it('lets the billing officer run a shift too', async () => {
    expect((await billing.post('/api/v1/shifts', { openingFloat: '0' })).status).toBe(201);
    await billing.post('/api/v1/shifts/current/close', { declared: { cash: '0', mpesa: '0', card: '0', bank: '0' } });
  });
});

describe('M-Pesa', () => {
  it('completes an STK Push through the callback', async () => {
    const { bill } = await cashVisit();
    const stk = await cashier
      .post(`/api/v1/bills/${bill.id}/mpesa`, { phone: '0712 345 678', amount: '700' })
      .set('Idempotency-Key', key());
    expect(stk.status).toBe(201);
    expect(stk.body).toMatchObject({ status: 'pending', amount: '700.00', accountReference: bill.billNumber });
    const done = await until(async () => {
      const t = (await cashier.get(`/api/v1/mpesa/${stk.body.id}`)).body;
      return t.status !== 'pending' && t;
    });
    expect(done).toMatchObject({ status: 'completed', resultCode: 0 });
    expect(done.mpesaReceipt).toMatch(/^S[0-9A-F]{9}$/);
    expect(done.receipt.receiptNumber).toMatch(/^RCT-/);
    const b = (await cashier.get(`/api/v1/bills/${bill.id}`)).body;
    expect(b.balance).toBe('0.00');
    expect(b.payments[0]).toMatchObject({ method: 'mpesa', reference: done.mpesaReceipt });
  });

  it('records a cancelled prompt without taking payment', async () => {
    const { bill } = await cashVisit();
    const stk = (
      await cashier
        .post(`/api/v1/bills/${bill.id}/mpesa`, { phone: '0712340032', amount: '700' })
        .set('Idempotency-Key', key())
    ).body;
    const done = await until(async () => {
      const t = (await cashier.get(`/api/v1/mpesa/${stk.id}`)).body;
      return t.status !== 'pending' && t;
    });
    expect(done).toMatchObject({ status: 'cancelled', resultCode: 1032, receipt: null });
    expect((await cashier.get(`/api/v1/bills/${bill.id}`)).body.balance).toBe('700.00');
  });

  it('settles a request whose callback was lost by querying Daraja', async () => {
    const { bill } = await cashVisit();
    const stk = (
      await cashier
        .post(`/api/v1/bills/${bill.id}/mpesa`, { phone: '0712340099', amount: '300' })
        .set('Idempotency-Key', key())
    ).body;
    await new Promise((r) => setTimeout(r, 500));
    expect((await cashier.get(`/api/v1/mpesa/${stk.id}`)).body.status).toBe('pending');
    const q = (await cashier.post(`/api/v1/mpesa/${stk.id}/query`)).body;
    expect(q.status).toBe('completed');
    expect((await cashier.get(`/api/v1/bills/${bill.id}`)).body.balance).toBe('400.00');
  });

  it('ignores callbacks with the wrong token and duplicate callbacks', async () => {
    const res = await request(ctx.app).post('/api/v1/integrations/mpesa/not-the-token-at-all-xx/stk-callback').send({});
    expect(res.status).toBe(404);
    const t = await ctx.db('mpesa_transactions').where({ status: 'completed', kind: 'stk' }).first();
    const before = await ctx.db('payments').where({ bill_id: t.bill_id }).count({ n: '*' }).first();
    await request(ctx.app)
      .post(`/api/v1/integrations/mpesa/${TOKEN}/stk-callback`)
      .send({
        Body: {
          stkCallback: {
            MerchantRequestID: 'x',
            CheckoutRequestID: t.checkout_request_id,
            ResultCode: 0,
            ResultDesc: 'again',
            CallbackMetadata: {
              Item: [
                { Name: 'Amount', Value: 700 },
                { Name: 'MpesaReceiptNumber', Value: 'SDUPLICATE1' },
              ],
            },
          },
        },
      });
    expect(await ctx.db('payments').where({ bill_id: t.bill_id }).count({ n: '*' }).first()).toEqual(before);
  });

  it('matches Paybill payments by bill number, and holds unknown ones for manual matching', async () => {
    const facadmin = client(ctx.app);
    await facadmin.post('/api/v1/auth/login', { username: 'facadmin', password: 'Afyazuri#2026' });
    expect((await facadmin.post('/api/v1/mpesa/register-c2b')).body.ResponseCode).toBe('0');

    const { bill } = await cashVisit();
    const paid = await (
      await fetch(`${mockUrl}/mock/c2b/pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ BillRefNumber: bill.billNumber.toLowerCase(), TransAmount: '700' }),
      })
    ).json();
    await until(async () => (await cashier.get(`/api/v1/bills/${bill.id}`)).body.balance === '0.00');
    expect((await cashier.get(`/api/v1/bills/${bill.id}`)).body.payments[0].reference).toBe(paid.TransID);

    const other = await cashVisit();
    await fetch(`${mockUrl}/mock/c2b/pay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ BillRefNumber: 'WRONG123', TransAmount: '250' }),
    });
    const unmatched = await until(async () =>
      (await cashier.get('/api/v1/mpesa-unmatched')).body.data.find((t) => t.accountReference === 'WRONG123'),
    );
    expect(unmatched.phoneMasked).toMatch(/^\+25471•••\d{3}$/);
    const m = await cashier.post(`/api/v1/mpesa/${unmatched.id}/match`, { billId: other.bill.id });
    expect(m.body.bill.balance).toBe('450.00');
  });
});

describe('closing the shift', () => {
  it('compares declared totals with the system and records the variance', async () => {
    const current = (await cashier.get('/api/v1/shifts/current')).body.shift;
    const sys = current.systemTotals;
    expect(sys.cash).toMatchObject({ received: '700.00', expected: '2700.00' }); // float 2000 + 700 cash
    expect(Number(sys.mpesa.received)).toBeGreaterThanOrEqual(1000);
    const closed = await cashier.post('/api/v1/shifts/current/close', {
      declared: { cash: '2650', mpesa: sys.mpesa.expected, card: sys.card.expected, bank: '0' },
      notes: 'Short by 50',
    });
    expect(closed.body).toMatchObject({
      status: 'closed',
      variance: { cash: '-50.00', mpesa: '0.00', card: '0.00', bank: '0.00' },
    });
    expect((await cashier.get('/api/v1/shifts/current')).body.shift).toBeNull();
  });
});
