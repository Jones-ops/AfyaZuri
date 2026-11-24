import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, signIn, uniq } from '../helpers.js';

let ctx;
let clerk;
let doctor;
let labtech;
let labsup;
let billing;
let tests;

const letters = (n) =>
  Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const key = () => `k-${crypto.randomUUID()}`;

beforeAll(async () => {
  ctx = makeApp();
  [clerk, doctor, labtech, labsup, billing] = await Promise.all(
    ['records', 'doctor', 'labtech', 'labsup', 'billing'].map((u) => signIn(ctx.app, u)),
  );
  tests = Object.fromEntries((await doctor.get('/api/v1/lab/orderable-tests')).body.data.map((t) => [t.code, t]));
});
afterAll(() => ctx.db.destroy());

async function visit() {
  const p = (
    await clerk.post('/api/v1/patients', {
      firstName: cap(letters(7)),
      lastName: cap(letters(8)),
      sex: 'male',
      dateOfBirth: `19${60 + Math.floor(Math.random() * 30)}-0${1 + Math.floor(Math.random() * 8)}-1${Math.floor(Math.random() * 9)}`,
      phone: `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
    })
  ).body;
  const e = (await clerk.post('/api/v1/encounters', { patientId: p.id })).body;
  return { patient: p, encounter: e };
}
const order = (encounterId, codes, over = {}) =>
  doctor
    .post(`/api/v1/encounters/${encounterId}/lab-orders`, { tests: codes.map((c) => tests[c].id), ...over })
    .set('Idempotency-Key', key());

describe('ordering', () => {
  it('orders tests in a visit and bills them', async () => {
    const { encounter } = await visit();
    const res = await order(encounter.id, ['FBC', 'MRDT', 'RBS'], { clinicalNotes: 'Fever for 3 days' });
    expect(res.status).toBe(201);
    expect(res.body.orderNumber).toMatch(/^LAB-\d{4}-\d{6}$/);
    expect(res.body.items.map((i) => [i.code, i.status])).toEqual([
      ['FBC', 'ordered'],
      ['MRDT', 'ordered'],
      ['RBS', 'ordered'],
    ]);
    const bill = (await billing.get(`/api/v1/encounters/${encounter.id}/bill`)).body;
    expect(
      bill.items
        .filter((i) => i.sourceType === 'lab_order_item')
        .map((i) => i.totalAmount)
        .sort(),
    ).toEqual(['200.00', '300.00', '800.00']);
    expect(
      (
        await clerk
          .post(`/api/v1/encounters/${encounter.id}/lab-orders`, { tests: [tests.FBC.id] })
          .set('Idempotency-Key', key())
      ).status,
    ).toBe(403);
  });

  it('cancels a test before collection (voiding its charge), not after', async () => {
    const { encounter } = await visit();
    const o = (await order(encounter.id, ['CRP', 'RBS'])).body;
    const crp = o.items.find((i) => i.code === 'CRP');
    const res = await doctor.post(`/api/v1/lab-order-items/${crp.id}/cancel`, { reason: 'Ordered in error' });
    expect(res.body.items.find((i) => i.code === 'CRP')).toMatchObject({
      status: 'cancelled',
      cancelReason: 'Ordered in error',
    });
    const bill = (await billing.get(`/api/v1/encounters/${encounter.id}/bill`)).body;
    expect(bill.items.find((i) => i.description === 'C-reactive protein').status).toBe('voided');

    await labtech.post(`/api/v1/lab-orders/${o.id}/collect`, {});
    const rbs = o.items.find((i) => i.code === 'RBS');
    expect((await doctor.post(`/api/v1/lab-order-items/${rbs.id}/cancel`, { reason: 'Too late' })).status).toBe(409);
  });
});

describe('samples', () => {
  it('collects one tube per container, labels it, receives by barcode and handles rejection', async () => {
    const { patient, encounter } = await visit();
    const o = (await order(encounter.id, ['FBC', 'MRDT', 'RBS'], { priority: 'urgent' })).body;
    const wl = (await labtech.get('/api/v1/lab/worklist?stage=collect')).body.data;
    expect(wl.find((w) => w.orderId === o.id)).toMatchObject({ priority: 'urgent', mrn: patient.mrn });

    const labels = (await labtech.post(`/api/v1/lab-orders/${o.id}/collect`, {})).body.data;
    expect(labels).toHaveLength(2); // EDTA (FBC + malaria RDT) and fluoride (glucose)
    const edta = labels.find((l) => l.container.startsWith('EDTA'));
    const grey = labels.find((l) => l.container.startsWith('Fluoride'));
    expect(edta.tests.sort()).toEqual(['FBC', 'MRDT']);
    expect(edta).toMatchObject({ patient: { mrn: patient.mrn }, orderNumber: o.orderNumber, status: 'collected' });
    expect(edta.accession).toMatch(/^L-\d{4}-\d{6}$/);
    expect((await labtech.post(`/api/v1/lab-orders/${o.id}/collect`, {})).status).toBe(409); // nothing left

    const recv = await labtech.post('/api/v1/lab-samples/receive', { accession: edta.accession.toLowerCase() });
    expect(recv.body).toMatchObject({ status: 'received' });
    expect((await labtech.post('/api/v1/lab-samples/receive', { accession: edta.accession })).status).toBe(409);
    expect((await labtech.post('/api/v1/lab-samples/receive', { accession: 'L-1999-000001' })).status).toBe(404);

    // The glucose tube is haemolysed: rejected, and its test goes back for recollection.
    const rej = await labtech.post(`/api/v1/lab-samples/${grey.id}/reject`, { reason: 'Haemolysed' });
    expect(rej.body.items.find((i) => i.code === 'RBS')).toMatchObject({ status: 'ordered', accession: null });
    expect(rej.body.samples.find((s) => s.id === grey.id)).toMatchObject({
      status: 'rejected',
      rejectionReason: 'Haemolysed',
    });
    const again = (await labtech.post(`/api/v1/lab-orders/${o.id}/collect`, {})).body.data;
    expect(again).toHaveLength(1);
    expect(again[0].accession).not.toBe(grey.accession);

    const view = (await doctor.get(`/api/v1/lab-orders/${o.id}`)).body;
    expect(view.items.map((i) => [i.code, i.status])).toEqual([
      ['FBC', 'received'],
      ['MRDT', 'received'],
      ['RBS', 'collected'],
    ]);
  });

  it('lists STAT orders first and hides restricted patients from lab staff', async () => {
    const a = await visit();
    const b = await visit();
    const routine = (await order(a.encounter.id, ['UPT'])).body;
    const stat = (await order(b.encounter.id, ['UPT'], { priority: 'stat' })).body;
    const wl = (await labtech.get('/api/v1/lab/worklist?stage=collect')).body.data.map((w) => w.orderId);
    expect(wl.indexOf(stat.id)).toBeLessThan(wl.indexOf(routine.id));

    await ctx.db('patients').where({ id: b.patient.id }).update({ is_restricted: true });
    const row = (await labtech.get('/api/v1/lab/worklist?stage=collect')).body.data.find((w) => w.orderId === stat.id);
    expect(row.patient).toBe('Restricted patient');
    expect((await labtech.post(`/api/v1/lab-orders/${stat.id}/collect`, {})).body.error.code).toBe(
      'BREAK_GLASS_REQUIRED',
    );
  });
});

describe('catalogue', () => {
  it('lets the lab supervisor add tests, validating answers and ranges', async () => {
    const body = {
      code: uniq('T').toUpperCase().slice(0, 12),
      name: 'Hepatitis B surface antigen',
      section: 'serology',
      specimenType: 'serum',
      container: 'Plain (red top)',
      tatMinutes: 60,
      components: [
        {
          code: 'HBSAG',
          name: 'HBsAg',
          resultType: 'options',
          options: ['Non-reactive', 'Reactive'],
          abnormalOptions: ['Positive'],
        },
      ],
    };
    expect((await labsup.post('/api/v1/lab/tests', body)).status).toBe(400); // abnormal answer not among answers
    body.components[0].abnormalOptions = ['Reactive'];
    expect((await labtech.post('/api/v1/lab/tests', body)).status).toBe(403);
    const res = await labsup.post('/api/v1/lab/tests', body);
    expect(res.status).toBe(201);
    expect(res.body.components[0]).toMatchObject({ resultType: 'options', abnormalOptions: ['Reactive'] });
    const fbc = (await labsup.get('/api/v1/lab/tests?q=full blood')).body.data[0];
    expect(fbc.components.find((c) => c.code === 'HB').ranges).toHaveLength(3);
  });
});
