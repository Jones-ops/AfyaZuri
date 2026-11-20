import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, signIn, uniq } from '../helpers.js';

let ctx;
let pharmtech;
let cashier;
let storekeeper;
let stores;
let items;

const key = () => `k-${crypto.randomUUID()}`;
const usable = async (code) =>
  Number(
    (await storekeeper.get(`/api/v1/stores/${stores.PHARM.id}/stock`)).body.items.find((i) => i.code === code).usable,
  );

beforeAll(async () => {
  ctx = makeApp();
  [pharmtech, cashier, storekeeper] = await Promise.all(
    ['pharmtech', 'cashier', 'storekeeper'].map((u) => signIn(ctx.app, u)),
  );
  stores = Object.fromEntries((await storekeeper.get('/api/v1/stores')).body.data.map((s) => [s.code, s]));
  items = Object.fromEntries((await storekeeper.get('/api/v1/items?limit=200')).body.data.map((i) => [i.code, i]));
  const u = await ctx.db('users').where({ username: 'cashier' }).first('id');
  await ctx
    .db('cashier_shifts')
    .where({ cashier_id: u.id, status: 'open' })
    .update({ status: 'closed', closed_at: ctx.db.fn.now() });
  await cashier.post('/api/v1/shifts', { openingFloat: '0' });
});
afterAll(async () => {
  await cashier.post('/api/v1/shifts/current/close', { declared: { cash: '0', mpesa: '0', card: '0', bank: '0' } });
  await ctx.db.destroy();
});

const sell = (lines, over = {}) =>
  pharmtech
    .post('/api/v1/otc-sales', {
      storeId: stores.PHARM.id,
      customerName: 'Wanjiku Walk-in',
      customerPhone: '0722000111',
      lines,
      ...over,
    })
    .set('Idempotency-Key', key());

describe('over-the-counter sales', () => {
  it('rings up, is paid at the cashier, then hands over FEFO', async () => {
    const before = await usable('ORS');
    const sale = await sell([
      { itemId: items.ORS.id, quantity: 2 },
      { itemId: items.PARA500.id, quantity: 10 },
    ]);
    expect(sale.status).toBe(201);
    expect(sale.body).toMatchObject({
      status: 'awaiting_payment',
      total: '90.00',
      balance: '90.00',
      customerPhone: '+254722…111',
    });
    expect(sale.body.saleNumber).toMatch(/^OTC-\d{4}-\d{6}$/);
    expect(await usable('ORS')).toBe(before); // nothing leaves the shelf before payment

    const early = await pharmtech.post(`/api/v1/otc-sales/${sale.body.id}/hand-over`);
    expect(early.body.error).toMatchObject({ code: 'NOT_PAID', details: { balance: '90.00' } });

    // The cashier finds the bill by the customer's name and takes the money.
    const found = (await cashier.get('/api/v1/bills?status=outstanding&q=Wanjiku')).body.data;
    expect(found.map((b) => b.billNumber)).toContain(sale.body.billNumber);
    const paid = await cashier
      .post(`/api/v1/bills/${sale.body.billId}/payments`, { method: 'cash', amount: '90', tendered: '100' })
      .set('Idempotency-Key', key());
    expect(paid.body).toMatchObject({ changeDue: '10.00', bill: { balance: '0.00', status: 'closed' } });

    const done = await pharmtech.post(`/api/v1/otc-sales/${sale.body.id}/hand-over`);
    expect(done.body).toMatchObject({ status: 'completed', paid: true, completedBy: 'Lucy Akinyi' });
    expect(await usable('ORS')).toBe(before - 2);
    const m = (
      await storekeeper.get(`/api/v1/stock-movements?storeId=${stores.PHARM.id}&itemId=${items.ORS.id}&limit=1`)
    ).body.data[0];
    expect(m).toMatchObject({ type: 'otc_sale', quantity: '-2', referenceType: 'otc_sale' });
    expect((await pharmtech.post(`/api/v1/otc-sales/${sale.body.id}/hand-over`)).status).toBe(409);
  });

  it('sells only OTC medicines and consumables that are on the shelf', async () => {
    const rx = await sell([{ itemId: items.AMOX500.id, quantity: 10 }]);
    expect(rx.status).toBe(400);
    expect(rx.body.error.details.issues[0].message).toMatch(/needs a prescription/);
    const tooMany = await sell([{ itemId: items.ORS.id, quantity: 100000 }]);
    expect(tooMany.body.error.details.issues[0].message).toMatch(/on the shelf/);
    expect((await sell([{ itemId: items.SYR5.id, quantity: 1 }])).status).toBe(400); // syringes are in the main store, not the pharmacy
    expect(
      (
        await storekeeper
          .post('/api/v1/otc-sales', {
            storeId: stores.PHARM.id,
            customerName: 'X Y',
            lines: [{ itemId: items.ORS.id, quantity: 1 }],
          })
          .set('Idempotency-Key', key())
      ).status,
    ).toBe(403);
  });

  it('cancels an unpaid sale (and its bill), never a paid one', async () => {
    const a = await sell([{ itemId: items.ZINC20.id, quantity: 10 }]);
    const cancelled = await pharmtech.post(`/api/v1/otc-sales/${a.body.id}/cancel`, {
      reason: 'Customer changed their mind',
    });
    expect(cancelled.body.status).toBe('cancelled');
    expect((await ctx.db('bills').where({ id: a.body.billId }).first()).status).toBe('cancelled');

    const b = await sell([{ itemId: items.ZINC20.id, quantity: 10 }]);
    await cashier
      .post(`/api/v1/bills/${b.body.billId}/payments`, { method: 'cash', amount: '50' })
      .set('Idempotency-Key', key());
    expect((await pharmtech.post(`/api/v1/otc-sales/${b.body.id}/cancel`, { reason: 'Too late now' })).status).toBe(
      409,
    );
  });

  it('never lets a controlled drug be sold over the counter', async () => {
    const res = await storekeeper.post('/api/v1/items', {
      code: uniq('CD').toUpperCase().slice(0, 20),
      name: 'Morphine 10 mg tablets',
      category: 'drug',
      baseUnit: 'tablet',
      drug: { genericName: 'Morphine', form: 'tablet', strength: '10 mg', controlled: true, otcAllowed: true },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/controlled drug/);
  });
});
