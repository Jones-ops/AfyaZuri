import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, signIn } from '../helpers.js';

let ctx;
let clerk;
let triage;
let doctor;
let facadmin;

const letters = (n) =>
  Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');
const cap = (s) => s[0].toUpperCase() + s.slice(1);

beforeAll(async () => {
  ctx = makeApp();
  [clerk, triage, doctor, facadmin] = await Promise.all(
    ['records', 'triage', 'doctor', 'facadmin'].map((u) => signIn(ctx.app, u)),
  );
});
afterAll(() => ctx.db.destroy());

/** A checked-in patient with an open visit. */
async function visit({ dob = '1980-04-12' } = {}) {
  const p = await clerk.post('/api/v1/patients', {
    firstName: cap(letters(7)),
    lastName: cap(letters(8)),
    sex: 'female',
    dateOfBirth: dob,
  });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  const e = await clerk.post('/api/v1/encounters', { patientId: p.body.id });
  expect(e.status, JSON.stringify(e.body)).toBe(201);
  return { patient: p.body, encounter: e.body };
}

describe('vitals', () => {
  it('records vitals with BMI and flags, and raises an event for critical values', async () => {
    const { encounter } = await visit();
    const res = await triage.post(`/api/v1/encounters/${encounter.id}/vitals`, {
      systolic: 186,
      diastolic: 112,
      pulse: 96,
      temperatureC: 37.2,
      respRate: 18,
      spo2: 97,
      weightKg: 82,
      heightCm: 168,
    });
    expect(res.status).toBe(201);
    expect(res.body.bmi).toBe(29.1);
    expect(res.body.flags.map((f) => `${f.field}:${f.level}`)).toEqual([
      'systolic:critical',
      'diastolic:high',
      'bmi:high',
    ]);
    expect(res.body.recordedBy).toBeNull(); // names are resolved on read
    const evt = await ctx
      .db('outbox_events')
      .where({ event_type: 'vitals.critical', aggregate_id: encounter.id })
      .first();
    expect(evt.payload.flags[0].field).toBe('systolic');
  });

  it('applies child rules (MUAC, fast breathing)', async () => {
    const twoYearsAgo = new Date(Date.now() - 2 * 365 * 86_400_000).toISOString().slice(0, 10);
    const { encounter } = await visit({ dob: twoYearsAgo });
    const res = await triage.post(`/api/v1/encounters/${encounter.id}/vitals`, {
      respRate: 48,
      muacCm: 11.1,
      weightKg: 9.2,
    });
    expect(res.body.flags.map((f) => f.field)).toEqual(['respRate', 'muacCm']);
  });

  it('validates and enforces permissions', async () => {
    const { encounter } = await visit();
    expect((await triage.post(`/api/v1/encounters/${encounter.id}/vitals`, { systolic: 120 })).status).toBe(400);
    const cashier = await signIn(ctx.app, 'cashier');
    expect((await cashier.post(`/api/v1/encounters/${encounter.id}/vitals`, { pulse: 80 })).status).toBe(403);
  });
});

describe('clinical notes', () => {
  it('signs on save, locks the note and allows addenda', async () => {
    const { encounter } = await visit();
    const note = await doctor.post(`/api/v1/encounters/${encounter.id}/notes`, {
      templateCode: 'opd_general',
      subjective: 'Headache 3 days',
      objective: 'BP 150/95',
      assessment: 'Hypertension',
      plan: 'Start amlodipine',
    });
    expect(note.status).toBe(201);
    expect(note.body).toMatchObject({
      status: 'signed',
      author: { name: 'Dr. James Mwangi', licence: 'KMPDC KMPDC-DEMO-2001' },
    });

    const edit = await doctor.patch(`/api/v1/notes/${note.body.id}`, { plan: 'changed' });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('NOTE_SIGNED');

    const add = await doctor.post(`/api/v1/notes/${note.body.id}/addenda`, {
      body: 'BP rechecked after 15 min: 142/90',
    });
    expect(add.status).toBe(201);
    expect(add.body.addenda).toHaveLength(1);
    expect(add.body.plan).toBe('Start amlodipine');
    expect(await ctx.db('audit_log').where({ entity_id: note.body.id, action: 'amend' }).first()).toBeTruthy();
  });

  it('keeps drafts private to their author until signed', async () => {
    const { encounter } = await visit();
    const draft = (await doctor.post(`/api/v1/encounters/${encounter.id}/notes`, { subjective: 'Cough', sign: false }))
      .body;
    expect(draft.status).toBe('draft');
    expect((await triage.patch(`/api/v1/notes/${draft.id}`, { subjective: 'x' })).status).toBe(403);
    expect(
      (await doctor.patch(`/api/v1/notes/${draft.id}`, { subjective: 'Cough 2 weeks, night sweats' })).body.subjective,
    ).toMatch(/night sweats/);
    expect((await triage.post(`/api/v1/notes/${draft.id}/sign`)).status).toBe(403);
    expect((await doctor.post(`/api/v1/notes/${draft.id}/sign`)).body.status).toBe('signed');
    expect((await doctor.post(`/api/v1/encounters/${encounter.id}/notes`, { subjective: '' })).status).toBe(400);
  });
});

describe('diagnoses and ICD-11', () => {
  it('searches codes by text and by code prefix', async () => {
    const malaria = (await doctor.get('/api/v1/icd?q=malaria')).body.data;
    expect(malaria.map((c) => c.code)).toEqual(expect.arrayContaining(['1F40', '1F4Z']));
    const byCode = (await doctor.get('/api/v1/icd?q=ba0')).body.data;
    expect(byCode[0]).toMatchObject({ code: 'BA00', title: 'Essential hypertension', icd10: 'I10' });
    expect((await doctor.get('/api/v1/icd?q=hypertensoin')).body.data[0].code).toBe('BA00'); // typo-tolerant
  });

  it('records coded diagnoses with one primary per visit', async () => {
    const { encounter } = await visit();
    const a = await doctor.post(`/api/v1/encounters/${encounter.id}/diagnoses`, {
      icdCode: '1f40',
      rank: 'primary',
      certainty: 'confirmed',
    });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({
      icdCode: '1F40',
      description: 'Malaria due to Plasmodium falciparum',
      icd10: 'B50',
      rank: 'primary',
    });
    await doctor.post(`/api/v1/encounters/${encounter.id}/diagnoses`, { icdCode: 'CA02', rank: 'primary' });
    const ws = (await doctor.get(`/api/v1/encounters/${encounter.id}/clinical`)).body;
    expect(ws.diagnoses.filter((d) => d.rank === 'primary').map((d) => d.icdCode)).toEqual(['CA02']);
    expect((await doctor.post(`/api/v1/encounters/${encounter.id}/diagnoses`, { icdCode: 'CA02' })).status).toBe(409);
    expect((await doctor.post(`/api/v1/encounters/${encounter.id}/diagnoses`, { icdCode: 'ZZ99' })).status).toBe(400);
  });
});

describe('allergies and problem list', () => {
  it('records allergies once, shows them on the banner, and can retire them', async () => {
    const { patient } = await visit();
    const a = await triage.post(`/api/v1/patients/${patient.id}/allergies`, {
      category: 'drug',
      allergen: 'Penicillin',
      severity: 'severe',
      reaction: 'Rash',
    });
    expect(a.status).toBe(201);
    expect(
      (
        await doctor.post(`/api/v1/patients/${patient.id}/allergies`, {
          category: 'drug',
          allergen: 'penicillin',
          severity: 'mild',
        })
      ).status,
    ).toBe(409);
    expect((await doctor.get(`/api/v1/patients/${patient.id}`)).body.allergies[0].allergen).toBe('Penicillin');
    expect((await doctor.patch(`/api/v1/allergies/${a.body.id}`, { status: 'inactive' })).body.status).toBe('inactive');
    expect((await doctor.get(`/api/v1/patients/${patient.id}`)).body.allergies).toEqual([]);
  });

  it('tracks chronic problems', async () => {
    const { patient } = await visit();
    const p = await doctor.post(`/api/v1/patients/${patient.id}/problems`, {
      icdCode: 'BA00',
      description: 'Hypertension',
      onsetDate: '2020-01-01',
    });
    expect(p.body).toMatchObject({ status: 'active', icdCode: 'BA00', onsetDate: '2020-01-01' });
    expect((await doctor.patch(`/api/v1/problems/${p.body.id}`, { status: 'resolved' })).body.status).toBe('resolved');
  });
});

describe('timeline, corrections and access', () => {
  it('shows a chronological record, pages it, and audits the view', async () => {
    const { patient, encounter } = await visit();
    const v = (await triage.post(`/api/v1/encounters/${encounter.id}/vitals`, { pulse: 88, temperatureC: 38.5 })).body;
    await doctor.post(`/api/v1/encounters/${encounter.id}/notes`, { subjective: 'Fever', assessment: 'Malaria' });
    await doctor.post(`/api/v1/encounters/${encounter.id}/diagnoses`, { icdCode: '1F4Z' });

    const corrected = await triage.post(`/api/v1/clinical/vitals/${v.id}/entered-in-error`, {
      reason: 'Wrong patient',
    });
    expect(corrected.body.enteredInError.reason).toBe('Wrong patient');

    const tl = (await doctor.get(`/api/v1/patients/${patient.id}/timeline`)).body;
    expect(tl.data.map((e) => e.kind)).toEqual(expect.arrayContaining(['encounter', 'vitals', 'note', 'diagnosis']));
    expect(tl.data.find((e) => e.kind === 'vitals').data.enteredInError.reason).toBe('Wrong patient');
    const times = tl.data.map((e) => new Date(e.at).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    const first = (await doctor.get(`/api/v1/patients/${patient.id}/timeline?limit=2`)).body;
    expect(first.data).toHaveLength(2);
    const second = (
      await doctor.get(
        `/api/v1/patients/${patient.id}/timeline?limit=10&before=${encodeURIComponent(first.nextBefore)}`,
      )
    ).body;
    expect(second.data.length).toBeGreaterThan(0);
    expect(second.data.every((e) => new Date(e.at) < new Date(first.nextBefore))).toBe(true);

    const views = await ctx
      .db('audit_log')
      .where({ action: 'view', entity_type: 'clinical_record', patient_id: patient.id })
      .pluck('actor_username');
    expect(views).toContain('doctor');
  });

  it('keeps clinical records from non-clinical roles and from restricted-record snoopers', async () => {
    const { patient, encounter } = await visit();
    for (const u of ['cashier', 'billing', 'claims', 'facadmin']) {
      const c = u === 'facadmin' ? facadmin : await signIn(ctx.app, u);
      expect((await c.get(`/api/v1/patients/${patient.id}/timeline`)).status, u).toBe(403);
      expect((await c.get(`/api/v1/encounters/${encounter.id}/clinical`)).status, u).toBe(403);
    }
    await facadmin.post(`/api/v1/patients/${patient.id}/restrict`, {
      restricted: true,
      reason: 'Staff member, confidential care',
    });
    const blocked = await doctor.get(`/api/v1/patients/${patient.id}/timeline`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('BREAK_GLASS_REQUIRED');
    expect((await doctor.post(`/api/v1/encounters/${encounter.id}/notes`, { subjective: 'x' })).body.error.code).toBe(
      'BREAK_GLASS_REQUIRED',
    );
    await doctor.post(`/api/v1/patients/${patient.id}/break-glass`, { reason: 'Seen in emergency, needs history' });
    expect((await doctor.get(`/api/v1/patients/${patient.id}/timeline`)).status).toBe(200);
  });

  it('returns the clinical summary for the chart', async () => {
    const { patient, encounter } = await visit();
    await triage.post(`/api/v1/encounters/${encounter.id}/vitals`, { weightKg: 64, heightCm: 160 });
    await triage.post(`/api/v1/patients/${patient.id}/allergies`, {
      category: 'food',
      allergen: 'Groundnuts',
      severity: 'life_threatening',
    });
    const s = (await doctor.get(`/api/v1/patients/${patient.id}/clinical-summary`)).body;
    expect(s.allergies[0].allergen).toBe('Groundnuts');
    expect(s.lastVitals.bmi).toBe(25);
  });
});
