import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayNairobi } from '@afyazuri/shared';
import { makeApp, signIn } from '../helpers.js';

let ctx;
let nurse;
let storekeeper;
let pharmacist;
let accountant;
let admin;
let stores;
let items;

const key = () => `k-${crypto.randomUUID()}`;
const today = todayNairobi();
const usable = async (storeId, code) =>
  Number(
    (await storekeeper.get(`/api/v1/stores/${storeId}/stock`)).body.items.find((i) => i.code === code)?.usable ?? 0,
  );

beforeAll(async () => {
  ctx = makeApp();
  [nurse, storekeeper, pharmacist, accountant, admin] = await Promise.all(
    ['wardnurse', 'storekeeper', 'pharmacist', 'accountant', 'admin'].map((u) => signIn(ctx.app, u)),
  );
  stores = Object.fromEntries((await storekeeper.get('/api/v1/stores')).body.data.map((s) => [s.code, s]));
  items = Object.fromEntries((await storekeeper.get('/api/v1/items?limit=200')).body.data.map((i) => [i.code, i]));
});
afterAll(() => ctx.db.destroy());

describe('requisitions', () => {
  it('ward requests, the store approves (cutting a line), issues FEFO, and the ward receives with a variance', async () => {
    const body = {
      fromStoreId: stores.WARD.id,
      toStoreId: stores.MAIN.id,
      notes: 'Weekly ward top-up',
      lines: [
        { itemId: items.PARA500.id, quantity: 100 },
        { itemId: items['GLOVE-M'].id, quantity: 50 },
      ],
    };
    expect((await nurse.post('/api/v1/requisitions', body)).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const created = await nurse.post('/api/v1/requisitions', body).set('Idempotency-Key', key());
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'requested', fromStore: 'Ward Store', toStore: 'Main Store' });
    expect(created.body.reqNumber).toMatch(/^REQ-\d{4}-\d{6}$/);
    const id = created.body.id;

    // The ward cannot approve, nor can the pharmacist; the storekeeper can, and may cut quantities.
    expect((await nurse.post(`/api/v1/requisitions/${id}/decision`, { approve: true })).status).toBe(403);
    expect((await pharmacist.post(`/api/v1/requisitions/${id}/decision`, { approve: true })).status).toBe(403);
    expect(
      (
        await storekeeper.post(`/api/v1/requisitions/${id}/decision`, {
          approve: true,
          lines: [{ itemId: items['GLOVE-M'].id, approvedQty: 60 }],
        })
      ).status,
    ).toBe(400); // more than requested
    const approved = await storekeeper.post(`/api/v1/requisitions/${id}/decision`, {
      approve: true,
      note: 'Gloves are short',
      lines: [{ itemId: items['GLOVE-M'].id, approvedQty: 20 }],
    });
    expect(approved.body.status).toBe('approved');

    const mainBefore = await usable(stores.MAIN.id, 'PARA500');
    const issued = await storekeeper.post(`/api/v1/requisitions/${id}/issue`);
    expect(issued.body.status).toBe('issued');
    expect(issued.body.lines.map((l) => [l.code, l.issuedQty])).toEqual([
      ['GLOVE-M', '20'],
      ['PARA500', '100'],
    ]);
    expect(await usable(stores.MAIN.id, 'PARA500')).toBe(mainBefore - 100);

    // The ward counts what arrived: two pairs of gloves missing needs a reason.
    const lines = issued.body.issued;
    const recv = (gloveQty, reason) =>
      nurse.post(`/api/v1/requisitions/${id}/receive`, {
        lines: lines.map((l) =>
          l.name.startsWith('Examination')
            ? { issueLineId: l.id, receivedQty: gloveQty, varianceReason: reason }
            : { issueLineId: l.id, receivedQty: l.quantity },
        ),
      });
    expect((await recv(18)).status).toBe(400);
    expect((await recv(25, 'x')).status).toBe(400); // more than issued
    const wardBefore = await usable(stores.WARD.id, 'GLOVE-M');
    const done = await recv(18, 'Torn packet, two pairs unusable');
    expect(done.body).toMatchObject({ status: 'received', receivedBy: 'Esther Njeri' });
    expect(done.body.lines.find((l) => l.code === 'GLOVE-M').receivedQty).toBe('18');
    expect(await usable(stores.WARD.id, 'GLOVE-M')).toBe(wardBefore + 18);
    expect((await nurse.post(`/api/v1/requisitions/${id}/receive`, { lines: [] })).status).toBe(400);

    const ledger = (await storekeeper.get(`/api/v1/stock-movements?itemId=${items['GLOVE-M'].id}&limit=5`)).body.data;
    expect(ledger.slice(0, 2).map((m) => [m.type, m.quantity])).toEqual([
      ['issue_in', '18'],
      ['issue_out', '-20'],
    ]);
    expect(ledger[0].reason).toMatch(/Short by 2/);
  });

  it('refuses self-approval, and lets the requester cancel before issue', async () => {
    const r = await admin
      .post('/api/v1/requisitions', {
        fromStoreId: stores.WARD.id,
        toStoreId: stores.MAIN.id,
        lines: [{ itemId: items.ORS.id, quantity: 5 }],
      })
      .set('Idempotency-Key', key());
    const self = await admin.post(`/api/v1/requisitions/${r.body.id}/decision`, { approve: true });
    expect(self.body.error.code).toBe('SELF_APPROVAL');
    expect((await admin.post(`/api/v1/requisitions/${r.body.id}/cancel`)).body.status).toBe('cancelled');
    expect((await storekeeper.post(`/api/v1/requisitions/${r.body.id}/issue`)).status).toBe(409);
  });
});

describe('stock takes', () => {
  it('posts approved variances to the ledger; the counter cannot approve', async () => {
    const start = await pharmacist.post('/api/v1/stock-takes', { storeId: stores.PHARM.id });
    expect(start.status).toBe(201);
    expect(start.body.stNumber).toMatch(/^ST-/);
    expect((await pharmacist.post('/api/v1/stock-takes', { storeId: stores.PHARM.id })).status).toBe(409);
    const id = start.body.id;
    const amox = start.body.lines.find((l) => l.code === 'AMOX500');
    const before = await usable(stores.PHARM.id, 'AMOX500');

    // Count everything as the system says, except 10 capsules short on amoxicillin.
    const counts = start.body.lines.map((l) => ({
      lineId: l.id,
      countedQty: l.id === amox.id ? Number(amox.systemQty) - 10 : l.systemQty,
    }));
    await pharmacist.put(`/api/v1/stock-takes/${id}/counts`, { lines: counts });
    expect((await pharmacist.post(`/api/v1/stock-takes/${id}/submit`)).body.error.code).toBe('VARIANCE_UNEXPLAINED');
    await pharmacist.put(`/api/v1/stock-takes/${id}/counts`, {
      lines: [{ lineId: amox.id, countedQty: Number(amox.systemQty) - 10, reason: 'Broken blister strip' }],
    });
    const submitted = await pharmacist.post(`/api/v1/stock-takes/${id}/submit`);
    expect(submitted.body).toMatchObject({ status: 'submitted', lossValue: '25.00', gainValue: '0.00' });

    expect((await pharmacist.post(`/api/v1/stock-takes/${id}/decision`, { approve: true })).status).toBe(403);
    const ok = await accountant.post(`/api/v1/stock-takes/${id}/decision`, { approve: true, note: 'Agreed' });
    expect(ok.body.status).toBe('approved');
    expect(await usable(stores.PHARM.id, 'AMOX500')).toBe(before - 10);
    const m = (
      await storekeeper.get(`/api/v1/stock-movements?storeId=${stores.PHARM.id}&itemId=${items.AMOX500.id}&limit=1`)
    ).body.data[0];
    expect(m).toMatchObject({ type: 'stocktake', quantity: '-10', reason: 'Broken blister strip' });
  });

  it('refuses approval by anyone who took part in the count', async () => {
    const t = await admin.post('/api/v1/stock-takes', { storeId: stores.LAB.id });
    await admin.put(`/api/v1/stock-takes/${t.body.id}/counts`, {
      lines: t.body.lines.map((l) => ({ lineId: l.id, countedQty: l.systemQty })),
    });
    await admin.post(`/api/v1/stock-takes/${t.body.id}/submit`);
    expect((await admin.post(`/api/v1/stock-takes/${t.body.id}/decision`, { approve: true })).body.error.code).toBe(
      'SELF_APPROVAL',
    );
    expect((await admin.post(`/api/v1/stock-takes/${t.body.id}/cancel`)).body.status).toBe('cancelled');
  });

  it('writes off only expired batches', async () => {
    // Its own expired batch (as if left over from an old delivery), so other tests' seed data is untouched.
    const itemId = items.METRO400.id;
    const [batch] = await ctx
      .db('item_batches')
      .insert({
        facility_id:
          stores.PHARM.facilityId ?? (await ctx.db('stores').where({ id: stores.PHARM.id }).first()).facility_id,
        item_id: itemId,
        batch_number: `OLD${Date.now()}`,
        expiry_date: '2024-01-31',
        unit_cost: '0.70',
      })
      .returning('*');
    await ctx
      .db('stock_levels')
      .insert({ store_id: stores.PHARM.id, batch_id: batch.id, item_id: itemId, quantity: 12 });
    const good = (await pharmacist.get(`/api/v1/stores/${stores.PHARM.id}/stock/${itemId}`)).body.data.find(
      (b) => !b.expired,
    );
    const wo = (who, batchId) =>
      who
        .post(`/api/v1/stores/${stores.PHARM.id}/expiry-writeoff`, { batchId, reason: 'Expired, sent for destruction' })
        .set('Idempotency-Key', key());
    expect((await wo(pharmacist, good.batchId)).status).toBe(409);
    expect((await wo(storekeeper, batch.id)).status).toBe(403); // not the storekeeper's store
    const res = await wo(pharmacist, batch.id);
    expect(res.body).toMatchObject({ writtenOff: '12', value: '8.40' });
    const after = (await pharmacist.get(`/api/v1/stores/${stores.PHARM.id}/stock/${itemId}`)).body.data;
    expect(after.some((b) => b.batchId === batch.id)).toBe(false);
  });
});

describe('inventory reports', () => {
  it('reports consumption by department and losses, and values stock at average cost', async () => {
    const c = (await storekeeper.get(`/api/v1/inventory/reports/consumption?from=${today}&to=${today}`)).body;
    const ipd = c.departments.find((d) => d.department === 'Inpatient');
    expect(ipd.items.find((i) => i.code === 'PARA500').quantity).toBe('100');
    expect(c.losses.map((l) => l.type)).toEqual(expect.arrayContaining(['stocktake', 'expiry_writeoff']));
    expect(Number(c.lossValue)).toBeLessThan(0);

    const v = (await storekeeper.get('/api/v1/inventory/reports/valuation')).body;
    const sum = v.byStore.reduce((s, x) => s + Number(x.value), 0);
    expect(sum).toBeCloseTo(Number(v.totalValue), 1);
    expect(v.byCategory.map((x) => x.category)).toEqual(expect.arrayContaining(['drug', 'consumable']));

    const csv = await storekeeper.get(`/api/v1/inventory/reports/valuation?format=csv`);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.slice(1).split('\r\n')[0]).toMatch(/^Store,Item code,Item,Category,Usable/);
    expect((await pharmacist.get(`/api/v1/inventory/reports/valuation?format=csv`)).status).toBe(403); // no export
    expect((await nurse.get('/api/v1/inventory/reports/valuation')).status).toBe(403);
  });
});
