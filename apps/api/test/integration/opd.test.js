import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, signIn } from '../helpers.js';

let ctx;
let clerk;
let triage;
let doctor;
let main;

const letters = (n) =>
  Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');
const cap = (s) => s[0].toUpperCase() + s.slice(1);

beforeAll(async () => {
  ctx = makeApp();
  [clerk, triage, doctor] = await Promise.all([
    signIn(ctx.app, 'records'),
    signIn(ctx.app, 'triage'),
    signIn(ctx.app, 'doctor'),
  ]);
  main = await ctx.db('facilities').where({ kmhfl_code: '99001' }).first('*');
});
afterAll(() => ctx.db.destroy());

/** Register a fresh patient, optionally on SHA. */
async function newPatient({ sha = false } = {}) {
  const scheme = sha ? await ctx.db('schemes').where({ code: 'SHIF' }).first('id') : null;
  const res = await clerk.post('/api/v1/patients', {
    firstName: cap(letters(7)),
    lastName: cap(letters(8)),
    sex: 'male',
    dateOfBirth: `19${50 + Math.floor(Math.random() * 49)}-0${1 + Math.floor(Math.random() * 8)}-1${Math.floor(Math.random() * 9)}`,
    ...(scheme ? { payerScheme: { schemeId: scheme.id, memberNumber: `SHA-${letters(6).toUpperCase()}` } } : {}),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

const queueOf = (type) =>
  ctx
    .db('queues as q')
    .join('service_points as sp', 'sp.id', 'q.service_point_id')
    .where({ 'q.facility_id': main.id, 'sp.type': type })
    .orderBy('sp.name')
    .first('q.id', 'sp.id as service_point_id', 'q.name');

async function checkIn(patient, extra = {}) {
  const res = await clerk.post('/api/v1/encounters', { patientId: patient.id, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

describe('check-in and routing', () => {
  it('sends cash patients to the cashier first (pay before service)', async () => {
    const enc = await checkIn(await newPatient());
    expect(enc).toMatchObject({ type: 'opd', status: 'open', billingMode: 'pay_first', payerType: 'cash' });
    expect(enc.currentTicket).toMatchObject({ status: 'waiting', queueName: 'Cashier' });
    expect(enc.currentTicket.label).toMatch(/^C-\d{3}$/);
  });

  it('sends SHA patients straight to triage and bills at exit', async () => {
    const p = await newPatient({ sha: true });
    const enc = await checkIn(p, { patientPayerSchemeId: p.payerSchemes[0].id });
    expect(enc).toMatchObject({
      billingMode: 'bill_at_exit',
      payerType: 'sha',
      schemeName: 'Social Health Insurance Fund',
    });
    expect(enc.currentTicket.queueName).toBe('Triage');
  });

  it('refuses a second open visit for the same patient', async () => {
    const p = await newPatient();
    const enc = await checkIn(p);
    const again = await clerk.post('/api/v1/encounters', { patientId: p.id });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'ALREADY_CHECKED_IN', details: { encounterId: enc.id } });
  });

  it('numbers tickets sequentially per queue and day, even concurrently', async () => {
    const patients = await Promise.all(Array.from({ length: 6 }, () => newPatient({ sha: true })));
    const encs = await Promise.all(
      patients.map((p) =>
        clerk.post('/api/v1/encounters', { patientId: p.id, patientPayerSchemeId: p.payerSchemes[0].id }),
      ),
    );
    const numbers = encs.map((e) => e.body.currentTicket.number);
    expect(new Set(numbers).size).toBe(6);
  });

  it('is idempotent on clientId', async () => {
    const p = await newPatient();
    const clientId = crypto.randomUUID();
    const a = await checkIn(p, { clientId });
    const b = await clerk.post('/api/v1/encounters', { patientId: p.id, clientId });
    expect(b.body.id).toBe(a.id);
  });
});

describe('queue work', () => {
  it('calls emergencies first, then the longest waiting', async () => {
    const triageQ = await queueOf('triage');
    // Clear anything already waiting so the order is deterministic.
    await ctx
      .db('queue_tickets')
      .where({ queue_id: triageQ.id })
      .whereIn('status', ['waiting', 'called', 'in_service'])
      .update({ status: 'done' });
    const [a, b] = [await newPatient({ sha: true }), await newPatient({ sha: true })];
    const routine = await checkIn(a, { patientPayerSchemeId: a.payerSchemes[0].id });
    const emergency = await checkIn(b, { patientPayerSchemeId: b.payerSchemes[0].id, type: 'emergency' });

    const board = (await triage.get(`/api/v1/queues/${triageQ.id}/board`)).body;
    expect(board.waiting.map((t) => t.encounterId)).toEqual([emergency.id, routine.id]);
    expect(board.waiting[0]).toMatchObject({ priority: 2, encounterType: 'emergency', nextStep: 'consultation' });

    const called = await triage.post(`/api/v1/queues/${triageQ.id}/call-next`);
    expect(called.body).toMatchObject({ encounterId: emergency.id, status: 'called' });
  });

  it('walks a patient along the route and through a lab detour to exit', async () => {
    const p = await newPatient({ sha: true });
    const enc = await checkIn(p, { patientPayerSchemeId: p.payerSchemes[0].id });
    const t1 = enc.currentTicket;

    expect((await triage.post(`/api/v1/queue-tickets/${t1.id}/start`)).body.status).toBe('in_service');
    const toConsult = (await triage.post(`/api/v1/queue-tickets/${t1.id}/complete`, { next: { kind: 'route' } })).body;
    expect(toConsult.nextTicket.queueName).toMatch(/Consultation Room/);

    const t2 = toConsult.nextTicket;
    await doctor.post(`/api/v1/queue-tickets/${t2.id}/start`);
    const lab = await queueOf('laboratory');
    const toLab = (
      await doctor.post(`/api/v1/queue-tickets/${t2.id}/complete`, {
        next: { kind: 'service_point', servicePointId: lab.service_point_id },
      })
    ).body;
    expect(toLab.ticket.status).toBe('referred');
    expect(toLab.nextTicket.queueName).toBe('Laboratory');

    const labtech = await signIn(ctx.app, 'labtech');
    const t3 = toLab.nextTicket;
    await labtech.post(`/api/v1/queue-tickets/${t3.id}/start`);
    const back = (await labtech.post(`/api/v1/queue-tickets/${t3.id}/complete`, { next: { kind: 'route' } })).body;
    expect(back.nextTicket.queueId).toBe(t2.queueId); // back to the same consultation room

    const t4 = back.nextTicket;
    await doctor.post(`/api/v1/queue-tickets/${t4.id}/start`);
    const out = (await doctor.post(`/api/v1/queue-tickets/${t4.id}/complete`, { next: { kind: 'route' } })).body;
    expect(out).toMatchObject({ encounterClosed: true, nextTicket: null });

    const visit = (await clerk.get(`/api/v1/encounters/${enc.id}`)).body;
    expect(visit.status).toBe('closed');
    expect(visit.tickets.map((t) => t.queueName)).toEqual(['Triage', t2.queueName, 'Laboratory', t2.queueName]);
    const attending = await ctx.db('encounters').where({ id: enc.id }).first('attending_user_id');
    expect(attending.attending_user_id).toBeTruthy();
  });

  it('rejects impossible transitions', async () => {
    const p = await newPatient({ sha: true });
    const enc = await checkIn(p, { patientPayerSchemeId: p.payerSchemes[0].id });
    const t = enc.currentTicket;
    const res = await triage.post(`/api/v1/queue-tickets/${t.id}/complete`, { next: { kind: 'route' } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
    expect((await triage.post(`/api/v1/queue-tickets/${t.id}/no-show`)).body.status).toBe('no_show');
    expect((await triage.post(`/api/v1/queue-tickets/${t.id}/call`)).status).toBe(409);
  });

  it('keeps department-scoped staff to their own queues', async () => {
    const labtech = await signIn(ctx.app, 'labtech');
    const triageQ = await queueOf('triage');
    const labQ = await queueOf('laboratory');
    expect((await labtech.post(`/api/v1/queues/${triageQ.id}/call-next`)).status).toBe(403);
    const queues = (await labtech.get('/api/v1/queues')).body.data;
    expect(queues.find((q) => q.id === labQ.id).canManage).toBe(true);
    expect(queues.find((q) => q.id === triageQ.id).canManage).toBe(false);
  });

  it('shows only ticket numbers on the public display', async () => {
    const triageQ = await queueOf('triage');
    const res = await triage.get(`/api/v1/queues/${triageQ.id}/display`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('waiting');
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/mrn|fullName|first_name|patient/i);
  });

  it('closes a visit and its ticket', async () => {
    const p = await newPatient();
    const enc = await checkIn(p);
    const closed = (await clerk.post(`/api/v1/encounters/${enc.id}/close`, { reason: 'Left before being seen' })).body;
    expect(closed.status).toBe('closed');
    expect(closed.currentTicket).toBeNull();
    expect((await clerk.post('/api/v1/encounters', { patientId: p.id })).status).toBe(201); // can check in again
  });
});

describe('merging patients with visits', () => {
  it('refuses to merge two records that both have an open visit', async () => {
    const facadmin = await signIn(ctx.app, 'facadmin');
    const [a, b] = [await newPatient(), await newPatient()];
    await checkIn(a);
    await checkIn(b);
    const res = await facadmin.post('/api/v1/patients/merge', {
      survivorId: a.id,
      mergedId: b.id,
      reason: 'Same person registered twice',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/Close one of the visits/);
  });
});

describe('route configuration', () => {
  it('lets facility admins change a route and validates it', async () => {
    const facadmin = await signIn(ctx.app, 'facadmin');
    const routes = (await facadmin.get('/api/v1/opd-routes')).body.data;
    expect(routes.find((r) => r.payerType === 'cash').steps).toEqual([
      'registration',
      'cashier',
      'triage',
      'consultation',
      'exit',
    ]);

    const bad = await facadmin.put('/api/v1/opd-routes', { payerType: 'private_insurer', steps: ['triage', 'exit'] });
    expect(bad.status).toBe(400);
    const ok = await facadmin.put('/api/v1/opd-routes', {
      payerType: 'private_insurer',
      steps: ['registration', 'consultation', 'exit'],
    });
    expect(ok.body.data.find((r) => r.payerType === 'private_insurer').steps).toEqual([
      'registration',
      'consultation',
      'exit',
    ]);
    expect((await clerk.put('/api/v1/opd-routes', { payerType: null, steps: ['registration', 'exit'] })).status).toBe(
      403,
    );
  });
});
