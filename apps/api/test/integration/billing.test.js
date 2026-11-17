import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postCharge } from '../../src/modules/billing/service.js';
import { makeApp, signIn } from '../helpers.js';

let ctx;
let clerk;
let billing;
let facadmin;
let cashier;
let main;

const letters = (n) =>
  Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');
const cap = (s) => s[0].toUpperCase() + s.slice(1);

beforeAll(async () => {
  ctx = makeApp();
  [clerk, billing, facadmin, cashier] = await Promise.all(
    ['records', 'billing', 'facadmin', 'cashier'].map((u) => signIn(ctx.app, u)),
  );
  main = await ctx.db('facilities').where({ kmhfl_code: '99001' }).first('*');
});
afterAll(() => ctx.db.destroy());

/** Register a fresh patient (optionally on a scheme) and check them in. */
async function visit({ scheme = null, type = 'opd' } = {}) {
  const s = scheme ? await ctx.db('schemes').where({ code: scheme }).first('id') : null;
  const p = (
    await clerk.post('/api/v1/patients', {
      firstName: cap(letters(7)),
      lastName: cap(letters(8)),
      sex: 'male',
      dateOfBirth: `19${60 + Math.floor(Math.random() * 39)}-0${1 + Math.floor(Math.random() * 8)}-1${Math.floor(Math.random() * 9)}`,
      ...(s ? { payerScheme: { schemeId: s.id, memberNumber: `M-${letters(6)}` } } : {}),
    })
  ).body;
  const e = await clerk.post('/api/v1/encounters', {
    patientId: p.id,
    type,
    patientPayerSchemeId: p.payerSchemes[0]?.id ?? null,
  });
  expect(e.status, JSON.stringify(e.body)).toBe(201);
  const bill = (await billing.get(`/api/v1/encounters/${e.body.id}/bill`)).body;
  return { patient: p, encounter: e.body, bill };
}

const codes = (bill) =>
  bill.items
    .filter((i) => i.status === 'active')
    .map((i) => i.code)
    .sort();

describe('automatic charges at check-in', () => {
  it('charges a cash patient registration (first visit) and consultation, payable now', async () => {
    const { patient, bill } = await visit();
    expect(bill.billNumber).toMatch(/^BIL-\d{4}-\d{6}$/);
    expect(codes(bill)).toEqual(['CONS-OPD', 'REG-NEW']);
    expect(bill).toMatchObject({
      status: 'open',
      billingMode: 'pay_first',
      totalAmount: '700.00',
      payerAmount: '0.00',
      patientAmount: '700.00',
      balance: '700.00',
    });

    // Second visit: no registration fee.
    await ctx.db('encounters').where({ patient_id: patient.id, status: 'open' }).update({ status: 'closed' });
    const e2 = (await clerk.post('/api/v1/encounters', { patientId: patient.id })).body;
    expect(codes((await billing.get(`/api/v1/encounters/${e2.id}/bill`)).body)).toEqual(['CONS-OPD']);
  });

  it('splits an SHA (SHIF) consultation between payer and patient', async () => {
    const { bill } = await visit({ scheme: 'SHIF' });
    const cons = bill.items.find((i) => i.code === 'CONS-OPD');
    expect(cons).toMatchObject({ unitPrice: '500.00', payerAmount: '400.00', patientAmount: '100.00' });
    const reg = bill.items.find((i) => i.code === 'REG-NEW'); // not on the SHIF list → cash price, patient pays
    expect(reg).toMatchObject({ totalAmount: '200.00', payerAmount: '0.00', patientAmount: '200.00' });
    expect(bill).toMatchObject({
      payerAmount: '400.00',
      patientAmount: '300.00',
      balance: '300.00',
      billingMode: 'bill_at_exit',
    });
    expect(bill.payer).toMatchObject({
      payerName: 'Social Health Authority',
      schemeName: 'Social Health Insurance Fund',
    });
  });

  it('fully covers a Primary Healthcare Fund visit', async () => {
    const { bill } = await visit({ scheme: 'PHC' });
    expect(bill).toMatchObject({
      totalAmount: '700.00',
      payerAmount: '700.00',
      patientAmount: '0.00',
      balance: '0.00',
    });
  });

  it('uses the emergency consultation for emergency visits', async () => {
    const { bill } = await visit({ type: 'emergency' });
    expect(codes(bill)).toEqual(['CONS-EMER', 'REG-NEW']);
  });

  it('posts each clinical action only once', async () => {
    const { encounter, bill } = await visit();
    const enc = await ctx.db('encounters').where({ id: encounter.id }).first();
    const auth = {
      userId: (await ctx.db('users').where({ username: 'doctor' }).first('id')).id,
      username: 'doctor',
      roles: [],
      facilityId: main.id,
    };
    const sourceId = crypto.randomUUID();
    await ctx.db.transaction((trx) =>
      postCharge(trx, auth, { encounter: enc, chargeCode: 'PROC-DRESS', sourceType: 'procedure', sourceId }),
    );
    await ctx.db.transaction((trx) =>
      postCharge(trx, auth, { encounter: enc, chargeCode: 'PROC-DRESS', sourceType: 'procedure', sourceId }),
    );
    const after = (await billing.get(`/api/v1/bills/${bill.id}`)).body;
    expect(after.items.filter((i) => i.code === 'PROC-DRESS')).toHaveLength(1);
    expect(after.balance).toBe('1000.00');
  });

  it('flags charges with no price instead of blocking the clinical action', async () => {
    const enc = (await visit()).encounter;
    const row = await ctx.db('encounters').where({ id: enc.id }).first();
    const auth = {
      userId: (await ctx.db('users').where({ username: 'doctor' }).first('id')).id,
      username: 'doctor',
      roles: [],
      facilityId: main.id,
    };
    const line = await ctx.db.transaction((trx) =>
      postCharge(trx, auth, { encounter: row, chargeCode: 'MISC', sourceType: 'test', sourceId: crypto.randomUUID() }),
    );
    expect(line).toMatchObject({ unpriced: true, total_amount: '0.00' });
  });
});

describe('manual charges and voids', () => {
  it('lets the billing office add priced, percentage-covered and unpriced lines', async () => {
    const { bill } = await visit({ scheme: 'SHIF' });
    const items = (await billing.get('/api/v1/charge-items')).body.data;
    const dress = items.find((i) => i.code === 'PROC-DRESS');
    const misc = items.find((i) => i.code === 'MISC');

    const a = (await billing.post(`/api/v1/bills/${bill.id}/items`, { chargeItemId: dress.id, quantity: 2 })).body;
    expect(a.items.find((i) => i.code === 'PROC-DRESS')).toMatchObject({
      quantity: 2,
      totalAmount: '600.00',
      payerAmount: '480.00',
      patientAmount: '120.00',
    });

    expect(
      (await billing.post(`/api/v1/bills/${bill.id}/items`, { chargeItemId: dress.id, unitPrice: '1' })).status,
    ).toBe(400);
    const b = (
      await billing.post(`/api/v1/bills/${bill.id}/items`, {
        chargeItemId: misc.id,
        unitPrice: '150',
        description: 'Medical report',
      })
    ).body;
    expect(b.items.find((i) => i.description === 'Medical report')).toMatchObject({
      totalAmount: '150.00',
      unpriced: false,
    });
    expect(b.balance).toBe('570.00'); // 300 + 120 + 150

    expect((await cashier.post(`/api/v1/bills/${bill.id}/items`, { chargeItemId: dress.id })).status).toBe(403);
  });

  it('voids a line with a reason and recalculates', async () => {
    const { bill } = await visit();
    const reg = bill.items.find((i) => i.code === 'REG-NEW');
    expect((await billing.post(`/api/v1/bill-items/${reg.id}/void`, { reason: 'x' })).status).toBe(400);
    const res = (
      await billing.post(`/api/v1/bill-items/${reg.id}/void`, { reason: 'Returning patient, registered before' })
    ).body;
    expect(res.items.find((i) => i.id === reg.id)).toMatchObject({
      status: 'voided',
      voidReason: 'Returning patient, registered before',
    });
    expect(res.balance).toBe('500.00');
    expect(
      await ctx.db('audit_log').where({ entity_type: 'bill_item', entity_id: reg.id, action: 'update' }).first(),
    ).toBeTruthy();
  });
});

describe('bill lifecycle', () => {
  it('finalises the bill when the visit closes, and closes it when nothing is owed', async () => {
    const cashVisit = await visit();
    await clerk.post(`/api/v1/encounters/${cashVisit.encounter.id}/close`, { reason: 'Seen' });
    expect((await billing.get(`/api/v1/bills/${cashVisit.bill.id}`)).body).toMatchObject({
      status: 'final',
      balance: '700.00',
    });

    const phc = await visit({ scheme: 'PHC' });
    await clerk.post(`/api/v1/encounters/${phc.encounter.id}/close`, {});
    expect((await billing.get(`/api/v1/bills/${phc.bill.id}`)).body.status).toBe('closed');
  });

  it('lists outstanding bills and finds them by MRN', async () => {
    const { patient, bill } = await visit();
    const list = (await billing.get(`/api/v1/bills?status=outstanding&q=${patient.mrn}`)).body.data;
    expect(list.map((b) => b.id)).toEqual([bill.id]);
    expect(list[0].patient.mrn).toBe(patient.mrn);
  });
});

describe('catalogue and price lists', () => {
  it('lets the facility admin price items and set scheme cover', async () => {
    const code = `T${letters(5).toUpperCase()}`;
    const item = (await facadmin.post('/api/v1/charge-items', { code, name: 'Ear syringing', category: 'procedure' }))
      .body;
    expect(item).toMatchObject({ code, cashPrice: null });
    const lists = (await facadmin.get('/api/v1/price-lists')).body.data;
    const cash = lists.find((l) => l.isDefault);
    const shif = lists.find((l) => l.code === 'SHIF');

    expect(
      (
        await facadmin.put(`/api/v1/price-lists/${cash.id}/items`, {
          chargeItemId: item.id,
          unitPrice: '350',
          coverType: 'full',
        })
      ).status,
    ).toBe(400);
    expect(
      (await facadmin.put(`/api/v1/price-lists/${cash.id}/items`, { chargeItemId: item.id, unitPrice: '350' })).body
        .unitPrice,
    ).toBe('350.00');
    expect(
      (
        await facadmin.put(`/api/v1/price-lists/${shif.id}/items`, {
          chargeItemId: item.id,
          unitPrice: '350',
          coverType: 'fixed',
          coverValue: '300',
        })
      ).body,
    ).toMatchObject({ coverType: 'fixed', coverValue: '300.00' });
    expect((await facadmin.get('/api/v1/charge-items')).body.data.find((i) => i.id === item.id).cashPrice).toBe(
      '350.00',
    );

    const second = await facadmin.post('/api/v1/price-lists', {
      code: 'CASH2',
      name: 'Another cash list',
      isDefault: true,
    });
    expect(second.status).toBe(409); // one default cash list per facility
    expect((await cashier.post('/api/v1/charge-items', { code: 'NOPE', name: 'x x', category: 'other' })).status).toBe(
      403,
    );
  });
});
