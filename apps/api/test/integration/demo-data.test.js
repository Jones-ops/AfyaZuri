import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, signIn } from '../helpers.js';

let ctx;
let doctor;
let main;
beforeAll(async () => {
  ctx = makeApp();
  doctor = await signIn(ctx.app, 'doctor');
  main = await ctx.db('facilities').where({ kmhfl_code: '99001' }).first('id');
});
afterAll(() => ctx.db.destroy());

describe('demo dataset', () => {
  it('has 500 demo patients whose encrypted fields decrypt with the app keys', async () => {
    const { n } = await ctx
      .db('patients')
      .where({ facility_id: main.id })
      .where('created_by', ctx.db('users').where({ username: 'records' }).select('id'))
      .count({ n: '*' })
      .first();
    expect(Number(n)).toBeGreaterThanOrEqual(500);

    const withPhone = await ctx
      .db('patients as p')
      .join('patient_identifiers as i', 'i.patient_id', 'p.id')
      .where('p.facility_id', main.id)
      .whereNotNull('p.phone_enc')
      .andWhere('i.type', 'national_id')
      .first('p.id');
    const p = (await doctor.get(`/api/v1/patients/${withPhone.id}`)).body;
    expect(p.phone).toMatch(/^\+2547\d{8}$/);
    expect(p.identifiers.find((i) => i.type === 'national_id').value).toMatch(/^\d{8}$/);
    expect((await doctor.get(`/api/v1/patients?q=${p.identifiers[0].value}`)).body.data[0].id).toBe(p.id);
  });

  it('includes past visits with signed notes and coded diagnoses, and patients on SHA', async () => {
    const closed = await ctx
      .db('encounters')
      .where({ facility_id: main.id, status: 'closed' })
      .count({ n: '*' })
      .first();
    expect(Number(closed.n)).toBeGreaterThanOrEqual(60);
    const dx = await ctx.db('diagnoses').where({ facility_id: main.id }).countDistinct({ n: 'icd_code' }).first();
    expect(Number(dx.n)).toBeGreaterThanOrEqual(8);
    const sha = await ctx.db('patient_payer_schemes').where({ facility_id: main.id }).count({ n: '*' }).first();
    expect(Number(sha.n)).toBeGreaterThan(150);

    const enc = await ctx.db('encounters').where({ facility_id: main.id, status: 'closed' }).first('patient_id');
    const tl = (await doctor.get(`/api/v1/patients/${enc.patient_id}/timeline`)).body.data;
    expect(tl.map((e) => e.kind)).toEqual(expect.arrayContaining(['encounter', 'vitals', 'note', 'diagnosis']));
  });

  it('seeds open visits in today’s queues', async () => {
    const open = await ctx
      .db('queue_tickets')
      .where({ facility_id: main.id })
      .whereNotNull('enqueued_at')
      .count({ n: '*' })
      .first();
    expect(Number(open.n)).toBeGreaterThanOrEqual(8);
  });
});
