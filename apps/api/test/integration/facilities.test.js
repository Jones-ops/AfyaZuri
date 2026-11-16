import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STRONG, makeApp, signIn, uniq } from '../helpers.js';

let ctx;
let facadmin;
let admin;
beforeAll(async () => {
  ctx = makeApp();
  facadmin = await signIn(ctx.app, 'facadmin');
  admin = await signIn(ctx.app, 'admin');
});
afterAll(() => ctx.db.destroy());

describe('facility setup', () => {
  it('shows the current facility and its seeded structure', async () => {
    expect((await facadmin.get('/api/v1/facilities/current')).body).toMatchObject({
      kmhflCode: '99001',
      level: 'level_4',
    });
    const codes = (await facadmin.get('/api/v1/departments')).body.data.map((d) => d.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'ADMIN',
        'REC',
        'OPD',
        'EMER',
        'IPD',
        'MAT',
        'PHARM',
        'LAB',
        'RAD',
        'BILL',
        'CLAIMS',
        'STORES',
      ]),
    );
    const wards = (await facadmin.get('/api/v1/wards')).body.data;
    expect(wards.find((w) => w.code === 'MMW')).toMatchObject({ bedCount: 20, available: 20, occupied: 0 });
  });

  it('creates departments, service points, wards and beds', async () => {
    const code = uniq('D').toUpperCase().slice(0, 12);
    const dept = await facadmin.post('/api/v1/departments', { name: `Dental ${code}`, code, type: 'opd' });
    expect(dept.status).toBe(201);
    expect(dept.body.code).toBe(code);

    const sp = await facadmin.post('/api/v1/service-points', {
      departmentId: dept.body.id,
      name: `Dental chair ${code}`,
      type: 'consultation',
    });
    expect(sp.status).toBe(201);

    const ward = await facadmin.post('/api/v1/wards', {
      departmentId: dept.body.id,
      name: `HDU ${code}`,
      code: `H${code}`.slice(0, 16),
    });
    expect(ward.status).toBe(201);
    const bed = await facadmin.post(`/api/v1/wards/${ward.body.id}/beds`, { label: 'HDU-01' });
    expect(bed.status).toBe(201);
    expect(bed.body.status).toBe('available');

    const dupe = await facadmin.post(`/api/v1/wards/${ward.body.id}/beds`, { label: 'HDU-01' });
    expect(dupe.status).toBe(409);

    const renamed = await facadmin.patch(`/api/v1/departments/${dept.body.id}`, { name: 'Dental Unit' });
    expect(renamed.body.name).toBe('Dental Unit');
  });

  it('manages bed housekeeping status but never occupancy', async () => {
    const bed = await ctx
      .db('beds as b')
      .join('facilities as f', 'f.id', 'b.facility_id')
      .where('f.kmhfl_code', '99001')
      .andWhere('b.status', 'available')
      .first('b.id');
    const nurse = await signIn(ctx.app, 'wardnurse');
    expect((await nurse.patch(`/api/v1/beds/${bed.id}/status`, { status: 'cleaning' })).body.status).toBe('cleaning');
    expect((await nurse.patch(`/api/v1/beds/${bed.id}/status`, { status: 'occupied' })).status).toBe(400);
    expect((await nurse.patch(`/api/v1/beds/${bed.id}/status`, { status: 'available' })).body.status).toBe('available');
  });

  it('only lets deployment admins add facilities', async () => {
    const body = {
      name: 'New Dispensary',
      kmhflCode: String(10000 + Math.floor(Math.random() * 89999)),
      level: 'level_2',
      ownership: 'moh',
      countyCode: '047',
    };
    expect((await facadmin.post('/api/v1/facilities', body)).status).toBe(403);
    const res = await admin.post('/api/v1/facilities', body);
    expect(res.status).toBe(201);
    expect(res.body.mrnFormat).toBe('{facility_code}-{year}-{seq}');
    const evt = await ctx
      .db('outbox_events')
      .where({ event_type: 'facility.created', aggregate_id: res.body.id })
      .first();
    expect(evt).toBeTruthy();
  });

  it('denies setup changes to clinical roles', async () => {
    const doctor = await signIn(ctx.app, 'doctor');
    expect((await doctor.post('/api/v1/departments', { name: 'X Dept', code: 'XX', type: 'opd' })).status).toBe(403);
    expect((await doctor.get('/api/v1/wards')).status).toBe(200); // ipd.read
  });

  it('stores facility settings over deployment defaults', async () => {
    const before = (await facadmin.get('/api/v1/settings')).body;
    expect(before['opd.billing_mode.cash']).toBe('pay_first');
    expect((await facadmin.put('/api/v1/settings/ipd.bed_charge_cutoff', { value: '23:59' })).status).toBe(200);
    expect((await facadmin.get('/api/v1/settings')).body['ipd.bed_charge_cutoff']).toBe('23:59');
  });
});

describe('multi-facility isolation', () => {
  it('keeps another facility’s admin out of this facility’s data', async () => {
    const hc = await ctx.db('facilities').where({ kmhfl_code: '99002' }).first('id');
    const username = uniq('hcadmin');
    const created = await admin.post('/api/v1/users', {
      username,
      fullName: 'HC Admin',
      password: STRONG,
      mustChangePassword: false,
      roles: [{ role: 'facility_admin', facilityId: hc.id, departmentId: null }],
    });
    expect(created.status).toBe(201);
    const hcAdmin = await signIn(ctx.app, username, STRONG);

    const depts = (await hcAdmin.get('/api/v1/departments')).body.data;
    expect(depts.every((d) => d.facilityId === hc.id)).toBe(true);

    const mainDept = await ctx
      .db('departments as d')
      .join('facilities as f', 'f.id', 'd.facility_id')
      .where('f.kmhfl_code', '99001')
      .first('d.id');
    expect((await hcAdmin.patch(`/api/v1/departments/${mainDept.id}`, { name: 'Hijacked' })).status).toBe(404);

    const mainWard = await ctx
      .db('wards as w')
      .join('facilities as f', 'f.id', 'w.facility_id')
      .where('f.kmhfl_code', '99001')
      .first('w.id');
    expect((await hcAdmin.get(`/api/v1/wards/${mainWard.id}/beds`)).status).toBe(404);

    const users = (await hcAdmin.get('/api/v1/users?limit=100')).body.data.map((u) => u.username);
    expect(users).toContain('locum');
    expect(users).not.toContain('doctor');

    const mainId = (await ctx.db('facilities').where({ kmhfl_code: '99001' }).first('id')).id;
    expect((await hcAdmin.post('/api/v1/auth/switch-facility', { facilityId: mainId })).status).toBe(403);
  });
});
