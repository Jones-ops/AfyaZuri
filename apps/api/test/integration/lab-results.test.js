import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, signIn } from '../helpers.js';

let ctx;
let clerk;
let doctor;
let labtech;
let labsup;
let tests;

const letters = (n) =>
  Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const key = () => `k-${crypto.randomUUID()}`;

beforeAll(async () => {
  ctx = makeApp();
  [clerk, doctor, labtech, labsup] = await Promise.all(
    ['records', 'doctor', 'labtech', 'labsup'].map((u) => signIn(ctx.app, u)),
  );
  tests = Object.fromEntries((await doctor.get('/api/v1/lab/orderable-tests')).body.data.map((t) => [t.code, t]));
});
afterAll(() => ctx.db.destroy());

/** A female adult's visit with tests ordered, collected and received. */
async function received(codes) {
  const p = (
    await clerk.post('/api/v1/patients', {
      firstName: cap(letters(7)),
      lastName: cap(letters(8)),
      sex: 'female',
      dateOfBirth: '1988-06-15',
      phone: `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
    })
  ).body;
  const e = (await clerk.post('/api/v1/encounters', { patientId: p.id })).body;
  const order = (
    await doctor
      .post(`/api/v1/encounters/${e.id}/lab-orders`, { tests: codes.map((c) => tests[c].id) })
      .set('Idempotency-Key', key())
  ).body;
  const labels = (await labtech.post(`/api/v1/lab-orders/${order.id}/collect`, {})).body.data;
  for (const l of labels) await labtech.post('/api/v1/lab-samples/receive', { accession: l.accession });
  const items = Object.fromEntries(order.items.map((i) => [i.code, i.id]));
  return { patient: p, encounter: e, order, items };
}
const comps = async (itemId) =>
  Object.fromEntries(
    (await labtech.get(`/api/v1/lab-order-items/${itemId}/results`)).body.components.map((c) => [c.code, c]),
  );
const enter = (who, itemId, values, comment) =>
  who.post(`/api/v1/lab-order-items/${itemId}/results`, { values, comment });

describe('result entry and release', () => {
  it('flags values, keeps them from clinicians until verified, and alerts on critical results', async () => {
    const { items, encounter, patient } = await received(['FBC']);
    const c = await comps(items.FBC);
    const res = await enter(labtech, items.FBC, [
      { componentId: c.HB.id, value: 6.04 },
      { componentId: c.WBC.id, value: '7.2' },
      { componentId: c.PLT.id, value: 250 },
    ]);
    expect(res.status).toBe(200);
    const byCode = Object.fromEntries(res.body.components.map((x) => [x.code, x.current]));
    expect(byCode.HB).toMatchObject({ value: 6, flag: 'LL', critical: true, rangeText: '12.0–15.0', unit: 'g/dL' });
    expect(byCode.WBC).toMatchObject({ value: 7.2, flag: 'N' });
    expect(res.body).toMatchObject({ status: 'resulted', critical: true });

    // Not on the record yet: the doctor sees nothing; the supervisor is alerted to verify.
    const docView = (await doctor.get(`/api/v1/lab-order-items/${items.FBC}/results`)).body;
    expect(docView.components.every((x) => x.current === null)).toBe(true);
    const supInbox = (await labsup.get('/api/v1/notifications')).body;
    expect(supInbox.data.find((n) => n.title.includes('Critical result to verify'))).toMatchObject({
      severity: 'critical',
    });

    expect((await labtech.post(`/api/v1/lab-order-items/${items.FBC}/verify`)).status).toBe(403); // no verify permission
    const verified = await labsup.post(`/api/v1/lab-order-items/${items.FBC}/verify`);
    expect(verified.body).toMatchObject({ status: 'verified' });

    const after = (await doctor.get(`/api/v1/lab-order-items/${items.FBC}/results`)).body;
    expect(after.components.find((x) => x.code === 'HB').current).toMatchObject({ value: 6, flag: 'LL' });
    const inbox = (await doctor.get('/api/v1/notifications')).body;
    const crit = inbox.data.find((n) => n.type === 'lab.critical' && n.body.includes(patient.mrn));
    expect(crit).toMatchObject({ severity: 'critical', link: `/encounters/${encounter.id}` });
    expect(crit.body).toMatch(/Haemoglobin 6 g\/dL \(Critically low\)/);
    expect(inbox.unread).toBeGreaterThan(0);

    // Only the owner can acknowledge a notification.
    expect((await labsup.post(`/api/v1/notifications/${crit.id}/read`)).status).toBe(404);
    const read = (await doctor.post(`/api/v1/notifications/${crit.id}/read`)).body;
    expect(read.data.find((n) => n.id === crit.id).readAt).toBeTruthy();

    const record = (await doctor.get(`/api/v1/patients/${patient.id}/lab-results`)).body.data;
    expect(record.map((r) => r.test.code)).toEqual(['FBC']);
  });

  it('refuses self-verification and invalid values', async () => {
    const { items } = await received(['MRDT', 'UE']);
    const m = await comps(items.MRDT);
    expect((await enter(labsup, items.MRDT, [{ componentId: m.MRDT.id, value: 'Maybe' }])).status).toBe(400);
    await enter(labsup, items.MRDT, [{ componentId: m.MRDT.id, value: 'Positive (P. falciparum)' }]);
    const self = await labsup.post(`/api/v1/lab-order-items/${items.MRDT}/verify`);
    expect(self.body.error.code).toBe('SELF_VERIFICATION');

    const u = await comps(items.UE);
    const missing = await enter(labtech, items.UE, [{ componentId: u.NA.id, value: 140 }]);
    expect(missing.status).toBe(400);
    expect(missing.body.error.details.issues.map((i) => i.path)).toEqual(['values.K', 'values.UREA', 'values.CREAT']);
    const words = await enter(labtech, items.UE, [
      { componentId: u.NA.id, value: 'high' },
      { componentId: u.K.id, value: 4 },
      { componentId: u.UREA.id, value: 5 },
      { componentId: u.CREAT.id, value: 70 },
    ]);
    expect(words.body.error.details.issues[0]).toMatchObject({ path: 'values.NA' });
  });

  it('amends released results as a new version, keeping the old one, and tells the clinician', async () => {
    const { items } = await received(['RBS']);
    const r = await comps(items.RBS);
    await enter(labtech, items.RBS, [{ componentId: r.GLU.id, value: 28 }]);
    await labsup.post(`/api/v1/lab-order-items/${items.RBS}/verify`);
    expect((await enter(labtech, items.RBS, [{ componentId: r.GLU.id, value: 8 }])).status).toBe(409);

    const amended = await labsup.post(`/api/v1/lab-order-items/${items.RBS}/amend`, {
      values: [{ componentId: r.GLU.id, value: 8.2 }],
      reason: 'Transcription error: 28 entered for 8.2',
    });
    expect(amended.body).toMatchObject({ version: 2, amended: true, critical: false });
    const glu = amended.body.components[0];
    expect(glu.current).toMatchObject({ value: 8.2, flag: 'H' });
    expect(glu.history).toEqual([expect.objectContaining({ version: 1, value: 28, flag: 'HH' })]);
    expect(amended.body.verifications.map((v) => v.action)).toEqual(['verified', 'amended']);
    const inbox = (await doctor.get('/api/v1/notifications')).body.data;
    expect(inbox.some((n) => n.type === 'lab.amended' && n.body.includes('Transcription error'))).toBe(true);
  });

  it('records cultures with organism and sensitivities', async () => {
    const { items } = await received(['URINE-CS']);
    const c = await comps(items['URINE-CS']);
    expect(
      (await enter(labtech, items['URINE-CS'], [{ componentId: c.CS.id, culture: { growth: 'growth' } }])).status,
    ).toBe(400);
    const ok = await enter(labtech, items['URINE-CS'], [
      {
        componentId: c.CS.id,
        culture: {
          growth: 'growth',
          organism: 'Escherichia coli',
          colonyCount: '>10⁵ CFU/mL',
          sensitivities: [
            { antibiotic: 'Nitrofurantoin', result: 'S' },
            { antibiotic: 'Amoxicillin', result: 'R' },
          ],
        },
      },
    ]);
    expect(ok.body.components[0].current).toMatchObject({ flag: 'A', culture: { organism: 'Escherichia coli' } });
  });

  it('will not take results before the sample reaches the lab', async () => {
    const p = (
      await clerk.post('/api/v1/patients', {
        firstName: cap(letters(7)),
        lastName: cap(letters(8)),
        sex: 'male',
        dateOfBirth: '1979-01-01',
        phone: `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
      })
    ).body;
    const e = (await clerk.post('/api/v1/encounters', { patientId: p.id })).body;
    const o = (
      await doctor
        .post(`/api/v1/encounters/${e.id}/lab-orders`, { tests: [tests.CRP.id] })
        .set('Idempotency-Key', key())
    ).body;
    const c = await comps(o.items[0].id);
    expect((await enter(labtech, o.items[0].id, [{ componentId: c.CRP.id, value: 3 }])).status).toBe(409);
  });
});

describe('result report', () => {
  it('shows released tests only, with turnaround time, on the letterhead', async () => {
    const { order, items } = await received(['UPT', 'CRP']);
    const u = await comps(items.UPT);
    await enter(
      labtech,
      items.UPT,
      [{ componentId: u.HCG.id, value: 'Negative' }],
      'Repeat in 1 week if symptoms persist',
    );
    await labsup.post(`/api/v1/lab-order-items/${items.UPT}/verify`);
    const rep = (await doctor.get(`/api/v1/lab-orders/${order.id}/report`)).body;
    expect(rep.facility.kmhflCode).toBe('99001');
    expect(rep.tests.map((t) => t.test.code)).toEqual(['UPT']); // CRP not released
    expect(rep.tests[0]).toMatchObject({ verifiedBy: 'Agnes Mutua', comment: 'Repeat in 1 week if symptoms persist' });
    expect(rep.tests[0].turnaroundMinutes).toBeGreaterThanOrEqual(0);
    expect(rep.tests[0].accession).toMatch(/^L-/);
  });
});
