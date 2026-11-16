import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeApp, signIn, uniq } from '../helpers.js';

let ctx;
let facadmin;
let main;
beforeAll(async () => {
  ctx = makeApp();
  facadmin = await signIn(ctx.app, 'facadmin');
  main = await ctx.db('facilities').where({ kmhfl_code: '99001' }).first('*');
});
afterAll(() => ctx.db.destroy());

describe('audit log', () => {
  it('is append-only at the database level', async () => {
    const [row] = await ctx.db('audit_log').insert({ action: 'create', entity_type: 'test' }).returning('id');
    await expect(ctx.db('audit_log').where({ id: row.id }).update({ action: 'view' })).rejects.toThrow(/append-only/);
    await expect(ctx.db('audit_log').where({ id: row.id }).delete()).rejects.toThrow(/append-only/);
    await expect(ctx.db.raw('TRUNCATE audit_log')).rejects.toThrow(/append-only/);
  });

  it('lets admins filter, page and see field-level changes', async () => {
    const code = uniq('A').toUpperCase().slice(0, 10);
    const d = await facadmin.post('/api/v1/departments', { name: `Physio ${code}`, code, type: 'other' });
    await facadmin.patch(`/api/v1/departments/${d.body.id}`, { name: `Physiotherapy ${code}` });

    const res = await facadmin.get('/api/v1/audit?entityType=department&action=update&limit=1');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].changes.name.to).toBe(`Physiotherapy ${code}`);
    expect(res.body.data[0].actorUsername).toBe('facadmin');
    expect(res.body.data[0].ip).toBeTruthy();

    const first = await facadmin.get('/api/v1/audit?limit=2');
    expect(first.body.nextCursor).toBeTruthy();
    const next = await facadmin.get(`/api/v1/audit?limit=2&cursor=${first.body.nextCursor}`);
    expect(Number(next.body.data[0].id)).toBeLessThan(Number(first.body.data[1].id));
  });

  it('exports CSV and audits the export', async () => {
    const res = await facadmin.get('/api/v1/audit/export?action=create');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text.split('\n')[0]).toMatch(/^id,occurred_at,actor_username/);
    const exp = await ctx.db('audit_log').where({ action: 'export', entity_type: 'audit_log' }).first();
    expect(exp.actor_username).toBe('facadmin');
  });

  it('is hidden from roles without audit access', async () => {
    const doctor = await signIn(ctx.app, 'doctor');
    expect((await doctor.get('/api/v1/audit')).status).toBe(403);
  });
});

describe('outbox event bus', () => {
  it('delivers committed events and drops rolled-back ones', async () => {
    const handler = vi.fn(async () => {});
    const type = `test.${uniq()}`;
    ctx.bus.subscribe(type, handler);
    await ctx.db.transaction((trx) => ctx.bus.publish(trx, { type, aggregateType: 't', aggregateId: 'committed' }));
    await ctx.db
      .transaction(async (trx) => {
        await ctx.bus.publish(trx, { type, aggregateType: 't', aggregateId: 'rolled-back' });
        await trx.rollback();
      })
      .catch(() => {});

    while ((await ctx.bus.dispatchPending(ctx.db)) > 0);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].aggregate_id).toBe('committed');
  });

  it('retries failed handlers with backoff', async () => {
    const type = `test.${uniq()}`;
    ctx.bus.subscribe(type, async () => {
      throw new Error('SMS gateway down');
    });
    await ctx.bus.publish(ctx.db, { type, aggregateType: 't', aggregateId: 'x' });
    await ctx.bus.dispatchPending(ctx.db);
    const e = await ctx.db('outbox_events').where({ event_type: type }).first();
    expect(e).toMatchObject({ status: 'pending', attempts: 1, last_error: 'SMS gateway down' });
    expect(new Date(e.available_at).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('phase 2 schema guarantees', () => {
  async function patientWithEncounter() {
    const [p] = await ctx
      .db('patients')
      .insert({
        facility_id: main.id,
        mrn: uniq('MRN'),
        first_name: 'Akinyi',
        middle_name: 'Atieno',
        last_name: 'Odera',
        sex: 'female',
        date_of_birth: '1990-05-01',
      })
      .returning('*');
    const [e] = await ctx
      .db('encounters')
      .insert({ facility_id: main.id, patient_id: p.id, type: 'opd' })
      .returning('*');
    const doctor = await ctx.db('users').where({ username: 'doctor' }).first('id');
    return { p, e, doctor };
  }

  it('builds the fuzzy-search name and records sync changes', async () => {
    const { p } = await patientWithEncounter();
    expect(p.search_name).toBe('akinyi atieno odera');
    const change = await ctx.db('sync_changes').where({ table_name: 'patients', row_id: p.id }).first();
    expect(change).toMatchObject({ op: 'I', facility_id: main.id });
    const hits = await ctx.db('patients').whereRaw('search_name % ?', ['akinyi odera']).pluck('id');
    expect(hits).toContain(p.id);
  });

  it('locks signed clinical notes and keeps addenda append-only', async () => {
    const { p, e, doctor } = await patientWithEncounter();
    const [note] = await ctx
      .db('clinical_notes')
      .insert({
        facility_id: main.id,
        encounter_id: e.id,
        patient_id: p.id,
        note_type: 'soap',
        subjective: 'Headache x3 days',
        author_id: doctor.id,
      })
      .returning('*');
    await ctx.db('clinical_notes').where({ id: note.id }).update({ subjective: 'Headache x3 days, fever' }); // draft: ok
    await ctx
      .db('clinical_notes')
      .where({ id: note.id })
      .update({ status: 'signed', signed_at: ctx.db.fn.now(), signed_by: doctor.id });
    await expect(ctx.db('clinical_notes').where({ id: note.id }).update({ plan: 'changed later' })).rejects.toThrow(
      /locked/,
    );
    await expect(ctx.db('clinical_notes').where({ id: note.id }).delete()).rejects.toThrow(/cannot be deleted/);

    const [add] = await ctx
      .db('clinical_note_addenda')
      .insert({ facility_id: main.id, note_id: note.id, author_id: doctor.id, body: 'BP rechecked: 120/80' })
      .returning('id');
    await expect(ctx.db('clinical_note_addenda').where({ id: add.id }).update({ body: 'x' })).rejects.toThrow(
      /append-only/,
    );
  });

  it('rejects implausible vitals and cross-facility links', async () => {
    const { p, e, doctor } = await patientWithEncounter();
    await expect(
      ctx
        .db('triage_vitals')
        .insert({ facility_id: main.id, encounter_id: e.id, patient_id: p.id, recorded_by: doctor.id, spo2: 140 }),
    ).rejects.toThrow(/check constraint/);
    const hc = await ctx.db('facilities').where({ kmhfl_code: '99002' }).first('id');
    // Close the first visit so only the cross-facility rule is being tested.
    await ctx.db('encounters').where({ id: e.id }).update({ status: 'closed' });
    await expect(ctx.db('encounters').insert({ facility_id: hc.id, patient_id: p.id, type: 'opd' })).rejects.toThrow(
      /foreign key/,
    );
    await expect(
      ctx.db('encounters').insert({ facility_id: main.id, patient_id: p.id, type: 'opd' }),
    ).resolves.toBeTruthy();
    await expect(ctx.db('encounters').insert({ facility_id: main.id, patient_id: p.id, type: 'opd' })).rejects.toThrow(
      /encounters_one_open_opd/,
    );
  });
});
