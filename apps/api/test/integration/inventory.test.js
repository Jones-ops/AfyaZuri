import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayNairobi } from '@afyazuri/shared';
import { allocateFefo } from '../../src/modules/inventory/stock.js';
import { makeApp, signIn, uniq } from '../helpers.js';

let ctx;
let storekeeper;
let pharmacist;
let clerk;
let stores;
let items;
let suppliers;

const key = () => `k-${crypto.randomUUID()}`;
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const stockOf = async (who, storeId, code) =>
  (await who.get(`/api/v1/stores/${storeId}/stock`)).body.items.find((i) => i.code === code);

beforeAll(async () => {
  ctx = makeApp();
  [storekeeper, pharmacist, clerk] = await Promise.all(
    ['storekeeper', 'pharmacist', 'records'].map((u) => signIn(ctx.app, u)),
  );
  stores = Object.fromEntries((await storekeeper.get('/api/v1/stores')).body.data.map((s) => [s.code, s]));
  items = Object.fromEntries((await storekeeper.get('/api/v1/items?limit=200')).body.data.map((i) => [i.code, i]));
  suppliers = (await storekeeper.get('/api/v1/suppliers')).body.data;
});
afterAll(() => ctx.db.destroy());

describe('stock on hand', () => {
  it('shows usable stock, quarantines expired batches and flags low stock', async () => {
    const ibu = await stockOf(pharmacist, stores.PHARM.id, 'IBU400');
    expect(ibu).toMatchObject({ usable: '400', expired: '100' });
    const met = await stockOf(pharmacist, stores.PHARM.id, 'MET500');
    expect(met).toMatchObject({ status: 'low', usable: '200', reorderLevel: '300' });
    // Suggest topping up to the maximum (1,200), which is more than the reorder quantity (600).
    expect(met.suggestedOrder).toBe('1000');
    const para = await stockOf(pharmacist, stores.PHARM.id, 'PARA500');
    expect(para.nextExpiry).toBe(day(20));

    const batches = (await pharmacist.get(`/api/v1/stores/${stores.PHARM.id}/stock/${items.IBU400.id}`)).body.data;
    expect(batches.map((b) => [b.batchNumber, b.expired])).toEqual([
      ['IBU2380', true],
      ['IBU2406', false],
    ]);
    const low = (await storekeeper.get('/api/v1/inventory/low-stock')).body.data;
    expect(low.map((l) => `${l.store}/${l.code}`)).toEqual(
      expect.arrayContaining(['Pharmacy/MET500', 'Main Store/GLOVE-M']),
    );
  });

  it('picks the earliest expiry first and never hands out expired stock', async () => {
    await ctx.db
      .transaction(async (trx) => {
        const picks = await allocateFefo(trx, { storeId: stores.PHARM.id, itemId: items.PARA500.id, quantity: 350 });
        expect(picks.map((p) => [p.batchNumber, p.quantity])).toEqual([
          ['PCM2390', 300],
          ['PCM2401', 50],
        ]);
        await expect(
          allocateFefo(trx, { storeId: stores.PHARM.id, itemId: items.IBU400.id, quantity: 450 }),
        ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK', details: { available: '400' } });
        throw new Error('rollback');
      })
      .catch((e) => {
        if (e.message !== 'rollback') throw e;
      });
  });

  it('reports expiry in 30/60/90-day bands', async () => {
    const r = (await pharmacist.get(`/api/v1/inventory/expiry?storeId=${stores.PHARM.id}`)).body;
    const band = (b) => r.batches.filter((x) => x.band === b).map((x) => x.batchNumber);
    expect(band('expired')).toContain('IBU2380');
    expect(band('30')).toContain('PCM2390');
    expect(band('60')).toContain('ALU2390');
    expect(r.bands.map((b) => b.band)).toEqual(['expired', '30', '60', '90']);
  });
});

describe('receiving goods', () => {
  it('receives packs into base units, updates average cost and writes the ledger', async () => {
    const before = await stockOf(storekeeper, stores.MAIN.id, 'AMLO5');
    const box = items.AMLO5.packSizes[0];
    const batch = uniq('B').toUpperCase();
    const res = await storekeeper
      .post('/api/v1/grns', {
        storeId: stores.MAIN.id,
        supplierId: suppliers[0].id,
        deliveryNote: 'DN-1001',
        lines: [
          {
            itemId: items.AMLO5.id,
            batchNumber: batch,
            expiryDate: day(400),
            quantity: 2,
            packSizeId: box.id,
            unitCost: '110',
          },
        ],
      })
      .set('Idempotency-Key', key());
    expect(res.status).toBe(201);
    expect(res.body.grnNumber).toMatch(/^GRN-\d{4}-\d{6}$/);
    expect(res.body.lines[0]).toMatchObject({ quantity: '200', unitCost: '1.1000', total: '220.00' });
    const after = await stockOf(storekeeper, stores.MAIN.id, 'AMLO5');
    expect(Number(after.usable) - Number(before.usable)).toBe(200);

    // Average cost blends the new price with what is on hand across the facility.
    const item = (await storekeeper.get(`/api/v1/items/${items.AMLO5.id}`)).body;
    expect(Number(item.averageCost)).toBeGreaterThan(0.7);
    expect(Number(item.averageCost)).toBeLessThan(1.1);

    const ledger = (await storekeeper.get(`/api/v1/stock-movements?storeId=${stores.MAIN.id}&itemId=${items.AMLO5.id}`))
      .body.data;
    expect(ledger[0]).toMatchObject({ type: 'grn', quantity: '200', batchNumber: batch, referenceType: 'grn' });
    expect(Number(ledger[0].balanceAfter)).toBe(200);
  });

  it('refuses expired stock and receiving into a store you do not work in', async () => {
    const line = { itemId: items.ORS.id, batchNumber: 'X1', expiryDate: todayNairobi(), quantity: 10, unitCost: '6' };
    const expired = await storekeeper
      .post('/api/v1/grns', { storeId: stores.MAIN.id, supplierId: suppliers[0].id, lines: [line] })
      .set('Idempotency-Key', key());
    expect(expired.status).toBe(400);
    expect(expired.body.error.details.issues[0].path).toBe('lines.0.expiryDate');

    const ok = { ...line, expiryDate: day(300) };
    const pharmInMain = await pharmacist
      .post('/api/v1/grns', { storeId: stores.MAIN.id, supplierId: suppliers[0].id, lines: [ok] })
      .set('Idempotency-Key', key());
    expect(pharmInMain.status).toBe(403); // the pharmacist's grants are for the pharmacy department
    const keeperInPharm = await storekeeper
      .post('/api/v1/grns', { storeId: stores.PHARM.id, supplierId: suppliers[0].id, lines: [ok] })
      .set('Idempotency-Key', key());
    expect(keeperInPharm.status).toBe(403);
    expect((await clerk.get('/api/v1/stores')).status).toBe(403);
  });

  it('receives against a purchase order, never more than ordered', async () => {
    const po = await storekeeper.post('/api/v1/purchase-orders', {
      supplierId: suppliers[1].id,
      storeId: stores.MAIN.id,
      lines: [
        { itemId: items.SYR5.id, quantity: 1000, unitCost: '5.5' },
        { itemId: items.CANN20.id, quantity: 100, unitCost: '24' },
      ],
    });
    expect(po.status).toBe(201);
    expect(po.body).toMatchObject({ status: 'draft', totalAmount: '7900.00' });
    const receive = (lines) =>
      storekeeper
        .post('/api/v1/grns', { storeId: stores.MAIN.id, supplierId: suppliers[1].id, poId: po.body.id, lines })
        .set('Idempotency-Key', key());
    expect(
      (
        await receive([
          { itemId: items.SYR5.id, batchNumber: 'S1', expiryDate: day(900), quantity: 10, unitCost: '5.5' },
        ])
      ).body.error.message,
    ).toMatch(/only sent orders/);

    await storekeeper.post(`/api/v1/purchase-orders/${po.body.id}/send`);
    const part = await receive([
      {
        itemId: items.SYR5.id,
        batchNumber: uniq('S').toUpperCase(),
        expiryDate: day(900),
        quantity: 600,
        unitCost: '5.5',
      },
    ]);
    expect(part.status).toBe(201);
    let order = (await storekeeper.get(`/api/v1/purchase-orders/${po.body.id}`)).body;
    expect(order.status).toBe('partially_received');
    expect(order.lines.find((l) => l.code === 'SYR5').outstanding).toBe('400');

    const over = await receive([
      {
        itemId: items.SYR5.id,
        batchNumber: uniq('S').toUpperCase(),
        expiryDate: day(900),
        quantity: 401,
        unitCost: '5.5',
      },
    ]);
    expect(over.status).toBe(400);
    const notOnOrder = await receive([
      { itemId: items.ORS.id, batchNumber: uniq('O').toUpperCase(), expiryDate: day(900), quantity: 1, unitCost: '6' },
    ]);
    expect(notOnOrder.status).toBe(400);

    await receive([
      {
        itemId: items.SYR5.id,
        batchNumber: uniq('S').toUpperCase(),
        expiryDate: day(900),
        quantity: 400,
        unitCost: '5.5',
      },
      {
        itemId: items.CANN20.id,
        batchNumber: uniq('C').toUpperCase(),
        expiryDate: day(700),
        quantity: 100,
        unitCost: '24',
      },
    ]);
    order = (await storekeeper.get(`/api/v1/purchase-orders/${po.body.id}`)).body;
    expect(order.status).toBe('received');
    expect(order.grns).toHaveLength(2);
    expect((await storekeeper.post(`/api/v1/purchase-orders/${po.body.id}/cancel`)).status).toBe(409);
  });
});

describe('item master and the ledger', () => {
  it('creates drugs with pack sizes; only stock managers may', async () => {
    const code = uniq('NEW').toUpperCase().slice(0, 20);
    const body = {
      code,
      name: 'Prednisolone 5 mg tablets',
      category: 'drug',
      baseUnit: 'tablet',
      drug: {
        genericName: 'Prednisolone',
        form: 'tablet',
        strength: '5 mg',
        strengthValue: 5,
        strengthUnit: 'mg',
        keml: true,
        atcCode: 'h02ab06',
      },
      packSizes: [{ name: 'Box of 100', baseQty: 100 }],
    };
    expect((await pharmacist.post('/api/v1/items', body)).status).toBe(403);
    const res = await storekeeper.post('/api/v1/items', body);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ code, drug: { genericName: 'Prednisolone', atcCode: 'H02AB06', keml: true } });
    expect((await storekeeper.post('/api/v1/items', body)).status).toBe(409);
    expect((await storekeeper.post('/api/v1/items', { ...body, code: `${code}X`, drug: null })).status).toBe(400);
    const found = (await pharmacist.get('/api/v1/items?q=predniso')).body.data;
    expect(found.map((i) => i.code)).toContain(code);
  });

  it('sets reorder levels per store', async () => {
    const r = await storekeeper.put(`/api/v1/stores/${stores.MAIN.id}/reorder-levels/${items.ORS.id}`, {
      reorderLevel: 100,
      reorderQty: 200,
      maxLevel: 50,
    });
    expect(r.status).toBe(400);
    const ok = await storekeeper.put(`/api/v1/stores/${stores.MAIN.id}/reorder-levels/${items.ORS.id}`, {
      reorderLevel: 100,
      reorderQty: 200,
      maxLevel: 600,
    });
    expect(ok.body).toEqual({ reorderLevel: '100', reorderQty: '200', maxLevel: '600' });
  });

  it('keeps the ledger append-only and stock never negative', async () => {
    await expect(ctx.db('stock_movements').update({ quantity: 1 }).where('id', '>', 0)).rejects.toThrow();
    await expect(ctx.db('stock_movements').where('id', '>', 0).delete()).rejects.toThrow();
    await expect(ctx.db('stock_levels').update({ quantity: -1 }).where({ store_id: stores.PHARM.id })).rejects.toThrow(
      /check/,
    );
  });
});
