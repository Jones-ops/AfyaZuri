import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, signIn } from '../helpers.js';

let ctx;
let clerk;
let doctor;
let pharmacist;
let pharmtech;
let storekeeper;
let stores;
let items;

const letters = (n) =>
  Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const key = () => `k-${crypto.randomUUID()}`;

beforeAll(async () => {
  ctx = makeApp();
  [clerk, doctor, pharmacist, pharmtech, storekeeper] = await Promise.all(
    ['records', 'doctor', 'pharmacist', 'pharmtech', 'storekeeper'].map((u) => signIn(ctx.app, u)),
  );
  stores = Object.fromEntries((await storekeeper.get('/api/v1/stores')).body.data.map((s) => [s.code, s]));
  items = Object.fromEntries((await storekeeper.get('/api/v1/items?limit=200')).body.data.map((i) => [i.code, i]));
});
afterAll(() => ctx.db.destroy());

async function visit({ allergy, dob } = {}) {
  const p = (
    await clerk.post('/api/v1/patients', {
      firstName: cap(letters(7)),
      lastName: cap(letters(8)),
      sex: 'female',
      dateOfBirth:
        dob ??
        `19${60 + Math.floor(Math.random() * 30)}-0${1 + Math.floor(Math.random() * 8)}-1${Math.floor(Math.random() * 9)}`,
      phone: `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
    })
  ).body;
  if (allergy)
    expect((await doctor.post(`/api/v1/patients/${p.id}/allergies`, { category: 'drug', ...allergy })).status).toBe(
      201,
    );
  const e = (await clerk.post('/api/v1/encounters', { patientId: p.id })).body;
  return { patient: p, encounter: e };
}

const line = (code, over = {}) => ({
  itemId: items[code].id,
  doseValue: 500,
  doseUnit: 'mg',
  route: 'oral',
  frequency: 'TDS',
  durationDays: 5,
  ...over,
});
const prescribe = (encounterId, lines, overrides = []) =>
  doctor
    .post(`/api/v1/encounters/${encounterId}/prescriptions`, { items: lines, overrides })
    .set('Idempotency-Key', key());

describe('prescribing checks', () => {
  it('blocks a drug the patient is severely allergic to, including by drug class', async () => {
    const { encounter } = await visit({
      allergy: { allergen: 'Penicillin', severity: 'severe', reaction: 'Anaphylaxis' },
    });
    const res = await prescribe(encounter.id, [line('AMOX500')]);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RX_BLOCKED');
    expect(res.body.error.details.warnings[0]).toMatchObject({ code: 'ALLERGY', severity: 'block' });
    expect(res.body.error.details.warnings[0].message).toMatch(/same drug class/);
    // Overriding does not help.
    const again = await prescribe(
      encounter.id,
      [line('AMOX500')],
      [{ itemId: items.AMOX500.id, code: 'ALLERGY', reason: 'I know' }],
    );
    expect(again.body.error.code).toBe('RX_BLOCKED');
  });

  it('makes the prescriber acknowledge a mild allergy, and keeps the reason', async () => {
    const { encounter } = await visit({ allergy: { allergen: 'Ibuprofen', severity: 'mild', reaction: 'Rash' } });
    const l = line('IBU400', { doseValue: 400 });
    const warned = await prescribe(encounter.id, [l]);
    expect(warned.body.error.code).toBe('RX_WARNINGS');
    const ok = await prescribe(
      encounter.id,
      [l],
      [{ itemId: items.IBU400.id, code: 'ALLERGY', reason: 'Mild rash only; benefits outweigh' }],
    );
    expect(ok.status).toBe(201);
    expect(ok.body.items[0].warnings[0]).toMatchObject({
      code: 'ALLERGY',
      overrideReason: 'Mild rash only; benefits outweigh',
    });
    expect(ok.body.items[0].quantity).toBe('15'); // 1 tablet × 3 a day × 5 days

    // Diclofenac on top of active ibuprofen: duplicate NSAID therapy.
    const dup = await prescribe(encounter.id, [line('DICLO50', { doseValue: 50 })]);
    expect(dup.body.error.details.warnings.map((w) => w.code)).toContain('DUPLICATE');
  });

  it('checks doses against the rules and suggests quantities', async () => {
    const { encounter } = await visit();
    const check = await doctor.post(`/api/v1/encounters/${encounter.id}/prescriptions/check`, {
      items: [
        line('PARA500', { doseValue: 1500, frequency: 'QID' }),
        line('AMLO5', { doseValue: 5, frequency: 'OD', durationDays: 30 }),
      ],
    });
    expect(check.status).toBe(200);
    expect(check.body.items).toEqual([
      { itemId: items.PARA500.id, quantity: '60' },
      { itemId: items.AMLO5.id, quantity: '30' },
    ]);
    expect(check.body.warnings).toEqual([
      expect.objectContaining({
        itemId: items.PARA500.id,
        code: 'DOSE_HIGH',
        message: expect.stringMatching(/1500 mg per dose/),
      }),
    ]);
    // A syrup dose in mg cannot be turned into bottles: the quantity must be given.
    const syrup = await doctor.post(`/api/v1/encounters/${encounter.id}/prescriptions/check`, {
      items: [line('AMOX125S', { doseValue: 250 })],
    });
    expect(syrup.status).toBe(400);
    expect(syrup.body.error.details.issues[0].path).toBe('items.0.quantity');
  });

  it('checks mg/kg limits for children and asks for a weight when none is recorded', async () => {
    const dob = new Date(Date.now() - 4 * 365.25 * 86_400_000).toISOString().slice(0, 10);
    const { encounter } = await visit({ dob });
    const res = await doctor.post(`/api/v1/encounters/${encounter.id}/prescriptions/check`, {
      items: [line('PARA500', { doseValue: 250, frequency: 'QID' })],
    });
    expect(res.body.warnings[0].message).toMatch(/No weight recorded/);
  });

  it('only prescribers prescribe', async () => {
    const { encounter } = await visit();
    expect(
      (
        await pharmacist
          .post(`/api/v1/encounters/${encounter.id}/prescriptions`, { items: [line('PARA500')] })
          .set('Idempotency-Key', key())
      ).status,
    ).toBe(403);
  });
});

describe('dispensing', () => {
  it('dispenses FEFO in parts, moves stock and bills in one go', async () => {
    const { encounter } = await visit();
    const rx = (
      await prescribe(encounter.id, [line('PARA500', { doseValue: 1000, frequency: 'QID', durationDays: 5 })])
    ).body;
    expect(rx.rxNumber).toMatch(/^RX-\d{4}-\d{6}$/);
    expect(rx.items[0].quantity).toBe('40');

    // The pharmacy technician (no clinical-record access) can still see and dispense it.
    const wl = (await pharmtech.get('/api/v1/pharmacy/worklist')).body.data;
    expect(wl.map((w) => w.id)).toContain(rx.id);
    const view = (await pharmtech.get(`/api/v1/prescriptions/${rx.id}?storeId=${stores.PHARM.id}`)).body;
    const before = Number(view.items[0].inStock);
    expect(before).toBeGreaterThan(40);

    const give = (who, qty, storeId = stores.PHARM.id) =>
      who
        .post(`/api/v1/prescriptions/${rx.id}/dispense`, {
          storeId,
          lines: [{ prescriptionItemId: rx.items[0].id, quantity: qty }],
        })
        .set('Idempotency-Key', key());
    expect((await give(storekeeper, 20)).status).toBe(403);
    expect((await give(pharmacist, 20, stores.MAIN.id)).status).toBe(403); // not their store

    const first = await give(pharmtech, 20);
    expect(first.status).toBe(200);
    expect(first.body.dispensed[0]).toMatchObject({ quantity: '20', billed: true });
    expect(first.body.dispensed[0].batches[0].batchNumber).toBe('PCM2390'); // earliest expiry first
    expect(first.body.prescription.status).toBe('partially_dispensed');
    expect((await give(pharmtech, 30)).body.error.details.issues[0].message).toMatch(/Only 20 left/);
    const second = await give(pharmtech, 20);
    expect(second.body.prescription).toMatchObject({ status: 'dispensed' });
    expect(
      Number((await pharmtech.get(`/api/v1/prescriptions/${rx.id}?storeId=${stores.PHARM.id}`)).body.items[0].inStock),
    ).toBe(before - 40);

    // Billed on the visit: 40 tablets at KES 5.
    const billing = await signIn(ctx.app, 'billing');
    const bill = (await billing.get(`/api/v1/encounters/${encounter.id}/bill`)).body;
    const drugLines = bill.items.filter((i) => i.sourceType === 'dispensation');
    expect(drugLines.map((i) => [i.description, i.quantity, i.totalAmount])).toEqual([
      ['Paracetamol 500 mg tablets', 20, '100.00'],
      ['Paracetamol 500 mg tablets', 20, '100.00'],
    ]);
    const ledger = (
      await storekeeper.get(`/api/v1/stock-movements?storeId=${stores.PHARM.id}&itemId=${items.PARA500.id}&limit=2`)
    ).body.data;
    expect(ledger.map((x) => [x.type, x.quantity])).toEqual([
      ['dispense', '-20'],
      ['dispense', '-20'],
    ]);
  });

  it('substitutes with a reason, and never to a drug the patient is severely allergic to', async () => {
    const { encounter } = await visit({
      allergy: { allergen: 'Sulfa drugs', severity: 'life_threatening', reaction: 'Stevens-Johnson' },
    });
    const rx = (await prescribe(encounter.id, [line('METRO400', { doseValue: 400 })])).body;
    const sub = (substituteItemId, substitutionReason) =>
      pharmacist
        .post(`/api/v1/prescriptions/${rx.id}/dispense`, {
          storeId: stores.PHARM.id,
          lines: [{ prescriptionItemId: rx.items[0].id, quantity: 15, substituteItemId, substitutionReason }],
        })
        .set('Idempotency-Key', key());
    expect((await sub(items.CTX960.id)).status).toBe(400); // no reason
    const blocked = await sub(items.CTX960.id, 'Metronidazole out of stock');
    expect(blocked.body.error.code).toBe('RX_BLOCKED');
    const ok = await sub(items.OMEP20.id, 'Demonstration substitute');
    expect(ok.status).toBe(200);
    expect(ok.body.dispensed[0]).toMatchObject({ item: 'Omeprazole 20 mg capsules', substituted: true });
    expect(ok.body.prescription.dispensations[0].substitutionReason).toBe('Demonstration substitute');
  });

  it('hides restricted patients from pharmacy staff without emergency access', async () => {
    const { patient, encounter } = await visit();
    const rx = (await prescribe(encounter.id, [line('AMLO5', { doseValue: 5, frequency: 'OD', durationDays: 7 })]))
      .body;
    await ctx.db('patients').where({ id: patient.id }).update({ is_restricted: true });
    const wl = (await pharmtech.get('/api/v1/pharmacy/worklist')).body.data.find((w) => w.id === rx.id);
    expect(wl.patient).toBe('Restricted patient');
    const view = await pharmtech.get(`/api/v1/prescriptions/${rx.id}`);
    expect(view.body.error.code).toBe('BREAK_GLASS_REQUIRED');
  });

  it('lets the prescriber stop what has not been supplied', async () => {
    const { encounter } = await visit();
    const rx = (await prescribe(encounter.id, [line('AMLO5', { doseValue: 5, frequency: 'OD', durationDays: 30 })]))
      .body;
    await pharmacist
      .post(`/api/v1/prescriptions/${rx.id}/dispense`, {
        storeId: stores.PHARM.id,
        lines: [{ prescriptionItemId: rx.items[0].id, quantity: 10 }],
      })
      .set('Idempotency-Key', key());
    const stopped = await doctor.post(`/api/v1/prescriptions/${rx.id}/cancel`, {
      reason: 'Changed to another antihypertensive',
    });
    expect(stopped.body).toMatchObject({ status: 'dispensed' });
    expect(stopped.body.items[0]).toMatchObject({
      dispensedQty: '10',
      status: 'dispensed',
      cancelReason: 'Changed to another antihypertensive',
    });
    expect((await doctor.post(`/api/v1/prescriptions/${rx.id}/cancel`, { reason: 'Again please' })).status).toBe(409);
  });
});
