import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, signIn } from '../helpers.js';

let ctx;
let dir;
let clerk;
let doctor;
let radiographer;
let radiologist;
let billing;
let studies;

const letters = (n) =>
  Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const key = () => `k-${crypto.randomUUID()}`;
// A tiny valid PNG (1×1 pixel).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'afyazuri-att-'));
  ctx = makeApp({ ATTACHMENTS_DIR: dir });
  [clerk, doctor, radiographer, radiologist, billing] = await Promise.all(
    ['records', 'doctor', 'radiographer', 'radiologist', 'billing'].map((u) => signIn(ctx.app, u)),
  );
  studies = Object.fromEntries((await doctor.get('/api/v1/imaging/studies')).body.data.map((s) => [s.code, s]));
});
afterAll(async () => {
  await ctx.db.destroy();
  rmSync(dir, { recursive: true, force: true });
});

async function visit() {
  const p = (
    await clerk.post('/api/v1/patients', {
      firstName: cap(letters(7)),
      lastName: cap(letters(8)),
      sex: 'female',
      dateOfBirth: '1985-04-04',
      phone: `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
    })
  ).body;
  const e = (await clerk.post('/api/v1/encounters', { patientId: p.id })).body;
  return { patient: p, encounter: e };
}
const order = (encounterId, code, clinicalIndication = 'Productive cough for 3 weeks, night sweats') =>
  doctor
    .post(`/api/v1/encounters/${encounterId}/imaging-orders`, { studyId: studies[code].id, clinicalIndication })
    .set('Idempotency-Key', key());
const upload = (who, orderId, buf, name = 'cxr.png') =>
  who.agent
    .post(`/api/v1/imaging-orders/${orderId}/attachments`)
    .set('X-Afyazuri-Client', '1')
    .set('Content-Type', 'application/octet-stream')
    .set('X-File-Name', encodeURIComponent(name))
    .send(buf);

describe('imaging', () => {
  it('needs a clinical indication, and bills the study', async () => {
    const { encounter } = await visit();
    const bad = await order(encounter.id, 'CXR', 'cxr');
    expect(bad.status).toBe(400);
    const ok = await order(encounter.id, 'CXR');
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ status: 'ordered', orderNumber: expect.stringMatching(/^IMG-\d{4}-\d{6}$/) });
    const bill = (await billing.get(`/api/v1/encounters/${encounter.id}/bill`)).body;
    expect(bill.items.find((i) => i.sourceType === 'imaging_order')).toMatchObject({
      description: 'Chest X-ray (PA)',
      totalAmount: '1000.00',
    });
  });

  it('runs ordered → scheduled → performed → reported → released, with the report hidden until release', async () => {
    const { encounter, patient } = await visit();
    const o = (await order(encounter.id, 'CXR')).body;
    const when = new Date(Date.now() + 3600_000).toISOString();
    expect(
      (await radiographer.post(`/api/v1/imaging-orders/${o.id}/schedule`, { scheduledFor: when })).body.status,
    ).toBe('scheduled');
    const done = await radiographer.post(`/api/v1/imaging-orders/${o.id}/perform`, {
      techniqueNotes: 'PA erect',
      studyInstanceUid: '1.2.840.10008.1.2',
    });
    expect(done.body).toMatchObject({
      status: 'performed',
      accessionNumber: expect.stringMatching(/^ACC-\d{4}-\d{6}$/),
    });
    expect(done.body.accessionNumber.length).toBeLessThanOrEqual(16); // DICOM accession limit

    const report = {
      findings: 'Patchy consolidation in the right upper zone with cavitation.',
      impression: 'Features suggestive of pulmonary TB.',
    };
    expect((await radiographer.post(`/api/v1/imaging-orders/${o.id}/report`, report)).status).toBe(403);
    expect((await radiologist.post(`/api/v1/imaging-orders/${o.id}/report`, report)).body.status).toBe('reported');
    expect((await doctor.get(`/api/v1/imaging-orders/${o.id}`)).body.report).toBeNull();
    expect((await radiologist.get(`/api/v1/imaging-orders/${o.id}`)).body.report.impression).toMatch(/TB/);

    const released = await radiologist.post(`/api/v1/imaging-orders/${o.id}/release`);
    expect(released.body).toMatchObject({ status: 'released', releasedBy: 'Dr. Amina Hassan' });
    const seen = (await doctor.get(`/api/v1/imaging-orders/${o.id}`)).body;
    expect(seen.report).toMatchObject({ version: 1, impression: 'Features suggestive of pulmonary TB.' });
    const inbox = (await doctor.get('/api/v1/notifications')).body.data;
    expect(inbox.some((n) => n.type === 'imaging.released' && n.body.includes(patient.mrn))).toBe(true);

    const amended = await radiologist.post(`/api/v1/imaging-orders/${o.id}/amend`, {
      ...report,
      impression: 'Features suggestive of pulmonary TB. Recommend sputum GeneXpert.',
      reason: 'Added recommendation',
    });
    expect(amended.body).toMatchObject({ amended: true, report: { version: 2 } });
    expect(amended.body.history).toEqual([expect.objectContaining({ version: 1 })]);
    expect((await doctor.post(`/api/v1/imaging-orders/${o.id}/cancel`, { reason: 'Too late' })).status).toBe(409);
  });

  it('stores attachments encrypted, checks their type, and shows them to clinicians only once released', async () => {
    const { encounter } = await visit();
    const o = (await order(encounter.id, 'US-ABD', 'Right upper quadrant pain, ?gallstones')).body;
    expect((await upload(radiographer, o.id, PNG)).status).toBe(409); // not done yet
    await radiographer.post(`/api/v1/imaging-orders/${o.id}/perform`, {});

    const fake = await upload(radiographer, o.id, Buffer.from('<script>alert(1)</script>'), 'evil.png');
    expect(fake.status).toBe(415);
    const att = await upload(radiographer, o.id, PNG, '../../etc/passwd scan.png');
    expect(att.status).toBe(201);
    expect(att.body).toMatchObject({ mimeType: 'image/png', fileName: 'passwd scan.png', sizeBytes: PNG.length });

    // On disk it is ciphertext with a random name.
    const files = readdirSync(dir);
    expect(files.every((f) => /^[0-9a-f-]{36}\.azf$/.test(f))).toBe(true);
    expect(files.some((f) => readFileSync(join(dir, f)).includes(PNG.subarray(0, 8)))).toBe(false);

    // Hidden from the doctor until the report is released.
    expect((await doctor.get(`/api/v1/imaging-orders/${o.id}/attachments/${att.body.id}`)).status).toBe(404);
    await radiologist.post(`/api/v1/imaging-orders/${o.id}/report`, {
      findings: 'Multiple gallstones, no duct dilatation.',
      impression: 'Cholelithiasis.',
    });
    await radiologist.post(`/api/v1/imaging-orders/${o.id}/release`);
    const dl = await doctor
      .get(`/api/v1/imaging-orders/${o.id}/attachments/${att.body.id}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toBe('image/png');
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(dl.body, PNG)).toBe(0);
  });

  it('cancels before the study is done and voids the charge', async () => {
    const { encounter } = await visit();
    const o = (await order(encounter.id, 'CT-HEAD', 'Head injury, GCS 14, vomiting')).body;
    const c = await doctor.post(`/api/v1/imaging-orders/${o.id}/cancel`, {
      reason: 'Transferred to referral hospital',
    });
    expect(c.body).toMatchObject({ status: 'cancelled', cancelReason: 'Transferred to referral hospital' });
    const bill = (await billing.get(`/api/v1/encounters/${encounter.id}/bill`)).body;
    expect(bill.items.find((i) => i.description === 'CT head (plain)').status).toBe('voided');
  });

  it('lists the worklist by stage with STAT first', async () => {
    const a = await visit();
    const b = await visit();
    const routine = (await order(a.encounter.id, 'XR-LIMB', 'Fall on outstretched hand, wrist pain')).body;
    const stat = (
      await doctor
        .post(`/api/v1/encounters/${b.encounter.id}/imaging-orders`, {
          studyId: studies['XR-LIMB'].id,
          clinicalIndication: 'Open fracture suspected',
          priority: 'stat',
        })
        .set('Idempotency-Key', key())
    ).body;
    const wl = (await radiographer.get('/api/v1/imaging/worklist?stage=perform')).body.data.map((w) => w.id);
    expect(wl.indexOf(stat.id)).toBeLessThan(wl.indexOf(routine.id));
  });
});
