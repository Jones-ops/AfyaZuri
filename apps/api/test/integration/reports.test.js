import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayNairobi } from '@afyazuri/shared';
import { makeApp, signIn } from '../helpers.js';

let ctx;
let clerk;
let cashier;
let billing;
let accountant;

const letters = (n) =>
  Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const key = () => `k-${crypto.randomUUID()}`;
const today = todayNairobi();
const n = (v) => Number(v);

beforeAll(async () => {
  ctx = makeApp();
  [clerk, cashier, billing, accountant] = await Promise.all(
    ['records', 'cashier', 'billing', 'accountant'].map((u) => signIn(ctx.app, u)),
  );
  const u = await ctx.db('users').where({ username: 'cashier' }).first('id');
  await ctx
    .db('cashier_shifts')
    .where({ cashier_id: u.id, status: 'open' })
    .update({ status: 'closed', closed_at: ctx.db.fn.now() });
  expect((await cashier.post('/api/v1/shifts', { openingFloat: '500' })).status).toBe(201);
});
afterAll(async () => {
  await cashier.post('/api/v1/shifts/current/close', { declared: { cash: '0', mpesa: '0', card: '0', bank: '0' } });
  await ctx.db.destroy();
});

async function cashVisit() {
  const p = (
    await clerk.post('/api/v1/patients', {
      firstName: cap(letters(7)),
      lastName: cap(letters(8)),
      sex: 'male',
      dateOfBirth: `19${50 + Math.floor(Math.random() * 49)}-0${1 + Math.floor(Math.random() * 8)}-1${Math.floor(Math.random() * 9)}`,
      phone: `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
    })
  ).body;
  const e = (await clerk.post('/api/v1/encounters', { patientId: p.id })).body;
  const bill = (await cashier.get(`/api/v1/encounters/${e.id}/bill`)).body;
  return { patient: p, bill };
}
const revenue = async (who = accountant) => (await who.get(`/api/v1/reports/revenue?from=${today}&to=${today}`)).body;

describe('daily revenue reconciliation', () => {
  it('moves by exactly what was billed, collected, waived and refunded today', async () => {
    const before = await revenue();
    const { bill } = await cashVisit(); // 200 registration + 500 consultation
    await cashier
      .post(`/api/v1/bills/${bill.id}/payments`, { method: 'cash', amount: '500' })
      .set('Idempotency-Key', key());
    const w = await cashier
      .post(`/api/v1/bills/${bill.id}/waivers`, { amount: '200', reason: 'Hardship, assessed today' })
      .set('Idempotency-Key', key());
    await billing.post(`/api/v1/waivers/${w.body.id}/decision`, { approve: true });
    const after = await revenue();

    expect(n(after.totals.billed) - n(before.totals.billed)).toBe(700);
    expect(n(after.totals.collected) - n(before.totals.collected)).toBe(500);
    expect(n(after.totals.waived) - n(before.totals.waived)).toBe(200);
    const cash = (r) => r.methods.find((m) => m.method === 'cash');
    expect(n(cash(after).received) - n(cash(before).received)).toBe(500);
    expect(after.days).toHaveLength(1);
    expect(after.days[0].day).toBe(today);
    // Departments and payers each add up to what was billed.
    const sum = (rows, k) => rows.reduce((s, r) => s + n(r[k]), 0);
    expect(sum(after.departments, 'billed')).toBeCloseTo(n(after.totals.billed), 2);
    expect(sum(after.payers, 'billed')).toBeCloseTo(n(after.totals.billed), 2);
    expect(after.payers.at(-1).payer).toBe('Patients (out of pocket)');
    // The open shift is listed for reconciliation.
    expect(after.cashiers.some((c) => c.cashier === 'John Kamau' && c.status === 'open')).toBe(true);
  });

  it('validates the range and keeps to the facility', async () => {
    expect((await accountant.get(`/api/v1/reports/revenue?from=${today}&to=2020-01-01`)).status).toBe(400);
    expect((await accountant.get('/api/v1/reports/revenue?from=2024-01-01&to=2025-06-01')).status).toBe(400);
    expect((await accountant.get('/api/v1/reports/revenue?from=2026-02-30&to=2026-03-01')).status).toBe(400);
    const r = await revenue();
    const f = await ctx.db('facilities').where({ kmhfl_code: '99001' }).first('id');
    expect(r.facilityId).toBe(f.id);
  });

  it('is only for finance roles; CSV export is audited and safe to open', async () => {
    expect((await cashier.get(`/api/v1/reports/revenue?from=${today}&to=${today}`)).status).toBe(403);
    expect((await clerk.get('/api/v1/reports/debtors')).status).toBe(403);

    const res = await billing.get(`/api/v1/reports/revenue?from=${today}&to=${today}&format=csv&table=methods`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toContain(`revenue-methods-${today}-to-${today}.csv`);
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    const lines = res.text.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe('Method,Payments,Received,Refunded,Net');
    expect(lines.map((l) => l.split(',')[0])).toEqual(['Method', 'cash', 'mpesa', 'card', 'bank']);

    const audit = await ctx
      .db('audit_log')
      .where({ action: 'export', entity_type: 'revenue_report' })
      .orderBy('id', 'desc')
      .first();
    expect(audit.actor_username).toBe('billing');
    expect(audit.metadata).toMatchObject({ table: 'methods', from: today });
  });
});

describe('debtor ageing', () => {
  it('ages unpaid bills into buckets and masks restricted patients', async () => {
    const fresh = await cashVisit();
    const old = await cashVisit();
    await ctx
      .db('bills')
      .where({ id: old.bill.id })
      .update({ opened_at: ctx.db.raw("now() - interval '45 days'") });
    const hidden = await cashVisit();
    await ctx.db('patients').where({ id: hidden.patient.id }).update({ is_restricted: true });

    const r = (await accountant.get('/api/v1/reports/debtors')).body;
    expect(r.asOf).toBe(today);
    const row = (id) => r.bills.find((b) => b.billId === id);
    expect(row(fresh.bill.id)).toMatchObject({ bucket: '0-30', ageDays: 0, balance: '700.00', scheme: 'Cash' });
    expect(row(old.bill.id)).toMatchObject({ bucket: '31-60', ageDays: 45 });
    expect(row(hidden.bill.id).patient).toBe('Restricted patient');
    expect(row(hidden.bill.id).mrn).toBe(hidden.patient.mrn);
    // Bucket totals add up to the grand total and to the rows.
    const bucketSum = r.buckets.reduce((s, b) => s + n(b.amount), 0);
    expect(bucketSum).toBeCloseTo(n(r.total), 2);
    expect(r.bills.reduce((s, b) => s + n(b.balance), 0)).toBeCloseTo(n(r.total), 2);
    // A settled bill is not a debtor.
    await cashier
      .post(`/api/v1/bills/${fresh.bill.id}/payments`, { method: 'cash', amount: '700' })
      .set('Idempotency-Key', key());
    const after = (await accountant.get('/api/v1/reports/debtors')).body;
    expect(after.bills.find((b) => b.billId === fresh.bill.id)).toBeUndefined();

    const only = (await accountant.get('/api/v1/reports/debtors?bucket=31-60')).body;
    expect(only.bills.every((b) => b.bucket === '31-60')).toBe(true);
    expect(only.bills.some((b) => b.billId === old.bill.id)).toBe(true);
  });

  it('exports the debtor list as CSV, with formula-like text neutralised', async () => {
    const v = await cashVisit();
    await ctx.db('patients').where({ id: v.patient.id }).update({ first_name: '=HYPERLINK("x")' });
    const res = await accountant.get('/api/v1/reports/debtors?format=csv');
    expect(res.status).toBe(200);
    const text = res.text.slice(1);
    expect(text.split('\r\n')[0]).toMatch(/^Bill,Patient,MRN,Scheme,Opened,Age \(days\),Bucket/);
    expect(text).toContain(`"'=HYPERLINK(""x"")`);
    expect(text).not.toMatch(/(^|,)=HYPERLINK/m);
  });
});
