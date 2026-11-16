import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, signIn, uniq } from '../helpers.js';

let ctx;
let clerk;
let doctor;
let facadmin;
let main;

beforeAll(async () => {
  ctx = makeApp();
  [clerk, doctor, facadmin] = await Promise.all([
    signIn(ctx.app, 'records'),
    signIn(ctx.app, 'doctor'),
    signIn(ctx.app, 'facadmin'),
  ]);
  main = await ctx.db('facilities').where({ kmhfl_code: '99001' }).first('*');
});
afterAll(() => ctx.db.destroy());

/** Random letters, so generated names don't resemble each other. */
const letters = (len) =>
  Array.from({ length: len }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');
const cap = (s) => s[0].toUpperCase() + s.slice(1);

/** A unique, valid person unlike any other generated one. */
function person(over = {}) {
  const n = Math.floor(Math.random() * 1e7);
  const year = 1950 + Math.floor(Math.random() * 60);
  const month = String(1 + Math.floor(Math.random() * 12)).padStart(2, '0');
  const day = String(1 + Math.floor(Math.random() * 28)).padStart(2, '0');
  return {
    firstName: cap(letters(7)),
    middleName: cap(letters(6)),
    lastName: cap(letters(8)),
    sex: 'female',
    dateOfBirth: `${year}-${month}-${day}`,
    phone: `07${String(10000000 + n).slice(0, 8)}`,
    identifiers: [{ type: 'national_id', value: String(20000000 + n) }],
    ...over,
  };
}

async function register(body, client = clerk) {
  const res = await client.post('/api/v1/patients', body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

describe('registration', () => {
  it('assigns an MRN, encrypts phone and identifiers, records consent and audits', async () => {
    const scheme = await ctx.db('schemes').where({ code: 'SHIF' }).first('id');
    const body = person({
      payerScheme: { schemeId: scheme.id, memberNumber: 'SHA-123456' },
      consents: [{ consentType: 'data_processing', granted: true, method: 'verbal' }],
      nextOfKin: { name: 'Otieno Odera', relationship: 'spouse', phone: '0722000111' },
    });
    const p = await register(body);
    expect(p.mrn).toMatch(/^99001-\d{4}-\d{6}$/);
    expect(p.phone).toBe(`+254${body.phone.slice(1)}`);
    expect(p.age).toMatch(/ y$/);
    expect(p.identifiers[0]).toMatchObject({ type: 'national_id', value: body.identifiers[0].value });
    expect(p.payerSchemes[0]).toMatchObject({ schemeCode: 'SHIF', payerCode: 'SHA', memberNumber: 'SHA-123456' });
    expect(p.consents[0]).toMatchObject({ consentType: 'data_processing', granted: true, version: '2026-01' });
    expect(p.nextOfKin.phone).toBe('+254722000111');

    const row = await ctx.db('patients').where({ id: p.id }).first();
    expect(row.phone_enc).toMatch(/^v1:/);
    expect(row.phone_enc).not.toContain(body.phone.slice(-6));
    const ident = await ctx.db('patient_identifiers').where({ patient_id: p.id }).first();
    expect(ident.value_enc).not.toContain(body.identifiers[0].value);

    const audit = await ctx
      .db('audit_log')
      .where({ entity_type: 'patient', entity_id: p.id, action: 'create' })
      .first();
    expect(audit.patient_id).toBe(p.id);
    expect(audit.after.phone_enc).toBe('[redacted]');
  });

  it('accepts an estimated age', async () => {
    const p = await register(person({ dateOfBirth: undefined, estimatedAge: { years: 4, months: 3 } }));
    expect(p.dobEstimated).toBe(true);
    expect(p.age).toBe('4 y');
  });

  it('gives concurrent registrations distinct MRNs', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => clerk.post('/api/v1/patients', person())));
    const mrns = results.map((r) => r.body.mrn);
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(mrns).size).toBe(8);
  });

  it('is idempotent on clientId (offline registration)', async () => {
    const body = person({ clientId: randomUUID() });
    const a = await register(body);
    const b = await clerk.post('/api/v1/patients', body);
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.id);
  });

  it('validates input', async () => {
    const bad = await clerk.post(
      '/api/v1/patients',
      person({ dateOfBirth: '2999-01-01', identifiers: [{ type: 'national_id', value: 'X1' }] }),
    );
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.issues.map((i) => i.path)).toEqual(
      expect.arrayContaining(['dateOfBirth', 'identifiers.0.value']),
    );
  });

  it('is limited to roles that register patients', async () => {
    const cashier = await signIn(ctx.app, 'cashier');
    expect((await cashier.post('/api/v1/patients', person())).status).toBe(403);
  });
});

describe('duplicate detection', () => {
  it('stops a likely duplicate until a reason is given', async () => {
    const first = await register(person());
    const again = {
      ...person(),
      firstName: first.firstName,
      middleName: first.middleName,
      lastName: first.lastName,
      dateOfBirth: first.dateOfBirth,
    };

    const blocked = await clerk.post('/api/v1/patients', again);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('POSSIBLE_DUPLICATE');
    const cand = blocked.body.error.details.candidates.find((c) => c.id === first.id);
    expect(cand.reasons).toEqual(expect.arrayContaining(['Same name', 'Same date of birth']));
    expect(cand.phoneMasked).toMatch(/^07•• ••• \d{3}$/);

    const check = await clerk.post('/api/v1/patients/duplicates', again);
    expect(check.body.data.map((c) => c.id)).toContain(first.id);

    const forced = await register({
      ...again,
      duplicateOverrideReason: 'Different person: confirmed with ID card at desk',
    });
    const row = await ctx.db('patients').where({ id: forced.id }).first('duplicate_override_reason');
    expect(row.duplicate_override_reason).toMatch(/confirmed with ID card/);
  });

  it('flags a reused national ID even under a different name', async () => {
    const first = await register(person());
    const res = await clerk.post(
      '/api/v1/patients',
      person({
        firstName: 'Kamau',
        lastName: 'Njoroge',
        dateOfBirth: '1970-01-01',
        identifiers: first.identifiers.map(({ type, value }) => ({ type, value })),
      }),
    );
    expect(res.status).toBe(409);
    const cand = res.body.error.details.candidates[0];
    expect(cand).toMatchObject({ id: first.id, score: 100 });
    expect(cand.reasons).toContain('Same national id');
  });
});

describe('search', () => {
  let p;
  beforeAll(async () => {
    p = await register(
      person({ firstName: 'Wanjiku', middleName: null, lastName: `Kariuki${uniq('z').replace(/\d/g, 'k')}` }),
    );
  });

  it('finds by MRN, phone (any format), national ID and partial name', async () => {
    const by = async (q) => (await clerk.get(`/api/v1/patients?q=${encodeURIComponent(q)}`)).body.data;
    expect((await by(p.mrn))[0]).toMatchObject({ id: p.id, matchedBy: 'mrn' });
    expect((await by(`254${p.phone.slice(4)}`))[0]).toMatchObject({ id: p.id, matchedBy: 'phone' });
    expect((await by(p.identifiers[0].value))[0]).toMatchObject({ id: p.id, matchedBy: 'identifier' });
    const byName = await by(`wanj ${p.lastName.slice(0, 5)}`);
    expect(byName.map((x) => x.id)).toContain(p.id);
    expect(byName[0]).not.toHaveProperty('phone');
  });

  it('explains short queries', async () => {
    const res = await clerk.get('/api/v1/patients?q=wa');
    expect(res.body.data).toEqual([]);
    expect(res.body.hint).toMatch(/3 letters/);
  });

  it('never returns another facility’s patients', async () => {
    const locum = await signIn(ctx.app, 'locum');
    const hc = await ctx.db('facilities').where({ kmhfl_code: '99002' }).first('id');
    await locum.post('/api/v1/auth/switch-facility', { facilityId: hc.id });
    expect((await locum.get(`/api/v1/patients?q=${encodeURIComponent(p.mrn)}`)).body.data).toEqual([]);
    expect((await locum.get(`/api/v1/patients/${p.id}`)).status).toBe(404);
  });
});

describe('viewing and editing', () => {
  it('audits each view and shows allergies only to clinical roles', async () => {
    const p = await register(person());
    await ctx
      .db('allergies')
      .insert({ facility_id: main.id, patient_id: p.id, category: 'drug', allergen: 'Penicillin', severity: 'severe' });

    const asDoctor = (await doctor.get(`/api/v1/patients/${p.id}`)).body;
    expect(asDoctor.clinical.canView).toBe(true);
    expect(asDoctor.allergies[0].allergen).toBe('Penicillin');

    const cashier = await signIn(ctx.app, 'cashier');
    const asCashier = (await cashier.get(`/api/v1/patients/${p.id}`)).body;
    expect(asCashier.clinical).toMatchObject({ canView: false, reason: 'no_permission' });
    expect(asCashier.allergies).toBeNull();

    const views = await ctx.db('audit_log').where({ action: 'view', entity_type: 'patient', patient_id: p.id });
    expect(views.map((v) => v.actor_username)).toEqual(expect.arrayContaining(['doctor', 'cashier']));
  });

  it('updates demographics and identifiers, logging which sensitive fields changed', async () => {
    const p = await register(person());
    const res = await clerk.patch(`/api/v1/patients/${p.id}`, {
      phone: '0799 888 777',
      village: 'Kondele',
      identifiers: [{ type: 'sha_number', value: 'CR-998877' }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ phone: '+254799888777', village: 'Kondele' });
    expect(res.body.identifiers.map((i) => i.type)).toEqual(['sha_number']);

    const a = await ctx.db('audit_log').where({ entity_id: p.id, action: 'update' }).orderBy('id', 'desc').first();
    expect(a.metadata.sensitiveFieldsChanged).toEqual(
      expect.arrayContaining(['phone', 'identifier.national_id', 'identifier.sha_number']),
    );
    expect(a.changes.village).toEqual({ from: null, to: 'Kondele' });
    expect((await clerk.get('/api/v1/patients?q=0799888777')).body.data[0].id).toBe(p.id);
    expect((await clerk.get('/api/v1/patients?q=CR-998877')).body.data[0].id).toBe(p.id);
  });

  it('records consent withdrawal', async () => {
    const p = await register(person({ consents: [{ consentType: 'sms', granted: true }] }));
    const res = await clerk.post(`/api/v1/patients/${p.id}/consents`, { consentType: 'sms', granted: false });
    expect(res.body.consents.find((c) => c.consentType === 'sms').granted).toBe(false);
  });
});

describe('merge and unmerge', () => {
  it('moves every linked record to the survivor and back again', async () => {
    const survivor = await register(person());
    const dup = await register({
      ...person(),
      firstName: survivor.firstName,
      lastName: survivor.lastName,
      dateOfBirth: survivor.dateOfBirth,
      duplicateOverrideReason: 'Registered quickly at emergency desk',
    });
    const doc = await ctx.db('users').where({ username: 'doctor' }).first('id');
    const [enc] = await ctx
      .db('encounters')
      .insert({ facility_id: main.id, patient_id: dup.id, type: 'opd' })
      .returning('id');
    const [note] = await ctx
      .db('clinical_notes')
      .insert({
        facility_id: main.id,
        encounter_id: enc.id,
        patient_id: dup.id,
        note_type: 'soap',
        subjective: 'Cough',
        author_id: doc.id,
        status: 'signed',
        signed_at: ctx.db.fn.now(),
        signed_by: doc.id,
      })
      .returning('id');

    expect(
      (
        await clerk.post('/api/v1/patients/merge', {
          survivorId: survivor.id,
          mergedId: dup.id,
          reason: 'Same person, two registrations',
        })
      ).status,
    ).toBe(403);

    const res = await facadmin.post('/api/v1/patients/merge', {
      survivorId: survivor.id,
      mergedId: dup.id,
      reason: 'Same person, two registrations',
    });
    expect(res.status).toBe(200);
    expect((await ctx.db('clinical_notes').where({ id: note.id }).first()).patient_id).toBe(survivor.id); // signed note moved
    expect((await ctx.db('encounters').where({ id: enc.id }).first()).patient_id).toBe(survivor.id);
    const gone = await clerk.get(`/api/v1/patients/${dup.id}`);
    expect(gone.status).toBe(410);
    expect(gone.body.error.details.survivorId).toBe(survivor.id);
    expect((await clerk.get(`/api/v1/patients?q=${dup.mrn}`)).body.data).toEqual([]);

    // The signed-note lock still applies outside a merge.
    await expect(ctx.db('clinical_notes').where({ id: note.id }).update({ patient_id: dup.id })).rejects.toThrow(
      /locked/,
    );

    const history = (await facadmin.get(`/api/v1/patients/${survivor.id}/merges`)).body.data[0];
    expect(history.moved).toMatchObject({ encounters: 1, clinical_notes: 1 });

    const un = await facadmin.post(`/api/v1/patient-merges/${res.body.mergeId}/unmerge`, {
      reason: 'Merged in error — twins',
    });
    expect(un.status).toBe(200);
    expect((await ctx.db('clinical_notes').where({ id: note.id }).first()).patient_id).toBe(dup.id);
    expect((await clerk.get(`/api/v1/patients/${dup.id}`)).status).toBe(200);
    const actions = await ctx
      .db('audit_log')
      .where({ patient_id: dup.id })
      .whereIn('action', ['merge', 'unmerge'])
      .pluck('action');
    expect(actions).toEqual(expect.arrayContaining(['merge', 'unmerge']));
  });
});

describe('restricted records and break-the-glass', () => {
  it('requires a reasoned, reviewed emergency grant to see a restricted record', async () => {
    const p = await register(person());
    expect(
      (
        await facadmin.post(`/api/v1/patients/${p.id}/restrict`, {
          restricted: true,
          reason: 'Public figure, VIP protocol',
        })
      ).status,
    ).toBe(200);

    const before = (await doctor.get(`/api/v1/patients/${p.id}`)).body;
    expect(before.clinical).toMatchObject({ canView: false, reason: 'restricted' });
    expect(before.allergies).toBeNull();
    expect(before.fullName).toBeTruthy(); // demographics still visible

    expect((await doctor.post(`/api/v1/patients/${p.id}/break-glass`, { reason: 'short' })).status).toBe(400);
    const grant = await doctor.post(`/api/v1/patients/${p.id}/break-glass`, {
      reason: 'Collapsed in OPD, needs urgent assessment',
    });
    expect(grant.status).toBe(201);
    const after = (await doctor.get(`/api/v1/patients/${p.id}`)).body;
    expect(after.clinical.canView).toBe(true);
    expect(after.clinical.breakGlassUntil).toBeTruthy();

    const fa = await ctx.db('users').where({ username: 'facadmin' }).first('id');
    const note = await ctx
      .db('notifications')
      .where({ user_id: fa.id, template: 'break_glass.used' })
      .orderBy('created_at', 'desc')
      .first();
    expect(note.payload.patientId).toBe(p.id);

    const queue = (await facadmin.get('/api/v1/break-glass')).body.data;
    expect(queue.find((g) => g.id === grant.body.grantId)).toMatchObject({ username: 'doctor', reviewedAt: null });
    expect(
      (await facadmin.post(`/api/v1/break-glass/${grant.body.grantId}/review`, { outcome: 'justified' })).status,
    ).toBe(200);
    expect((await doctor.get('/api/v1/break-glass')).status).toBe(403);

    const cashier = await signIn(ctx.app, 'cashier');
    expect(
      (
        await cashier.post(`/api/v1/patients/${p.id}/break-glass`, {
          reason: 'Collapsed in OPD, needs urgent assessment',
        })
      ).status,
    ).toBe(403);
  });
});

describe('reference data', () => {
  it('lists schemes and admin units for the registration form', async () => {
    expect((await clerk.get('/api/v1/schemes')).body.data.map((s) => s.code)).toEqual(
      expect.arrayContaining(['SHIF', 'CASH']),
    );
    const counties = (await clerk.get('/api/v1/admin-units/counties')).body.data;
    expect(counties).toHaveLength(47);
    const subs = (await clerk.get('/api/v1/admin-units/counties/042/sub-counties')).body.data;
    const central = subs.find((s) => s.name === 'Kisumu Central');
    expect(
      (await clerk.get(`/api/v1/admin-units/sub-counties/${central.id}/wards`)).body.data.map((w) => w.name),
    ).toContain('Kondele');
  });
});
