import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STRONG, makeApp, signIn, uniq } from '../helpers.js';

let ctx;
let facadmin;
let main;
let hc;
beforeAll(async () => {
  ctx = makeApp();
  facadmin = await signIn(ctx.app, 'facadmin');
  main = await ctx.db('facilities').where({ kmhfl_code: '99001' }).first('id');
  hc = await ctx.db('facilities').where({ kmhfl_code: '99002' }).first('id');
});
afterAll(() => ctx.db.destroy());

const newUser = (roles, extra = {}) => ({
  username: uniq('staff'),
  fullName: 'Wanjiku Test',
  password: STRONG,
  licenceBody: 'NCK',
  licenceNumber: 'NCK-1',
  roles,
  ...extra,
});

describe('user administration', () => {
  it('lists users at the admin’s facility only, with cursor pagination', async () => {
    const all = [];
    let cursor;
    do {
      const res = await facadmin.get(`/api/v1/users?limit=5${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      all.push(...res.body.data);
      cursor = res.body.nextCursor;
    } while (cursor);
    const names = all.map((u) => u.username);
    expect(names).toContain('doctor');
    expect(names).not.toContain('admin'); // deployment-wide account, no facility grant
    expect(new Set(names).size).toBe(names.length);
    expect(all[0]).not.toHaveProperty('passwordHash');
  });

  it('filters by search text and role', async () => {
    const res = await facadmin.get('/api/v1/users?q=mwangi&role=doctor');
    expect(res.body.data.map((u) => u.username)).toEqual(['doctor']);
  });

  it('creates a user with licence details and audits it without secrets', async () => {
    const body = newUser([{ role: 'triage_nurse', facilityId: main.id, departmentId: null }]);
    const res = await facadmin.post('/api/v1/users', body);
    expect(res.status).toBe(201);
    expect(res.body.roles[0]).toMatchObject({ role: 'triage_nurse', facilityId: main.id });
    expect(res.body.licenceBody).toBe('NCK');
    expect(res.body.mustChangePassword).toBe(true);

    const entry = await ctx
      .db('audit_log')
      .where({ entity_type: 'user', entity_id: res.body.id, action: 'create' })
      .first();
    expect(entry.actor_username).toBe('facadmin');
    expect(entry.after.password_hash).toBe('[redacted]');
    expect(JSON.stringify(entry)).not.toContain('$argon2');
  });

  it('stops facility admins from escalating or reaching other facilities', async () => {
    const sa = await facadmin.post(
      '/api/v1/users',
      newUser([{ role: 'super_admin', facilityId: main.id, departmentId: null }]),
    );
    expect(sa.status).toBe(403);
    const other = await facadmin.post(
      '/api/v1/users',
      newUser([{ role: 'doctor', facilityId: hc.id, departmentId: null }]),
    );
    expect(other.status).toBe(403);
    const global = await facadmin.post(
      '/api/v1/users',
      newUser([{ role: 'doctor', facilityId: null, departmentId: null }]),
    );
    expect(global.status).toBe(403);
    const adminUser = await ctx.db('users').where({ username: 'admin' }).first('id');
    expect((await facadmin.post(`/api/v1/users/${adminUser.id}/disable`, { reason: 'try it' })).status).toBe(404);
  });

  it('rejects a department from another facility', async () => {
    const hcLab = await ctx.db('departments').where({ facility_id: hc.id, code: 'LAB' }).first('id');
    const res = await facadmin.post(
      '/api/v1/users',
      newUser([{ role: 'lab_technologist', facilityId: main.id, departmentId: hcLab.id }]),
    );
    expect(res.status).toBe(400);
  });

  it('enforces the password policy and unique usernames', async () => {
    const weak = await facadmin.post(
      '/api/v1/users',
      newUser([{ role: 'cashier', facilityId: main.id, departmentId: null }], { password: 'password12' }),
    );
    expect(weak.body.error.code).toBe('WEAK_PASSWORD');
    const dup = await facadmin.post(
      '/api/v1/users',
      newUser([{ role: 'cashier', facilityId: main.id, departmentId: null }], { username: 'doctor' }),
    );
    expect(dup.status).toBe(409);
  });

  it('denies user management to roles without the permission', async () => {
    const cashier = await signIn(ctx.app, 'cashier');
    const res = await cashier.post(
      '/api/v1/users',
      newUser([{ role: 'cashier', facilityId: main.id, departmentId: null }]),
    );
    expect(res.status).toBe(403);
    expect(res.body.error.details.required).toEqual(['users.manage']);
    expect((await cashier.get('/api/v1/users')).status).toBe(403);
  });

  it('replays an idempotent create and rejects key reuse with a different body', async () => {
    const body = newUser([{ role: 'cashier', facilityId: main.id, departmentId: null }]);
    const key = `idem-${uniq()}`;
    const a = await facadmin.post('/api/v1/users', body).set('Idempotency-Key', key);
    const b = await facadmin.post('/api/v1/users', body).set('Idempotency-Key', key);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.body.id).toBe(a.body.id);
    const c = await facadmin.post('/api/v1/users', { ...body, fullName: 'Someone Else' }).set('Idempotency-Key', key);
    expect(c.status).toBe(422);
    expect(await ctx.db('users').where({ username: body.username }).count({ n: '*' }).first()).toEqual({ n: '1' });
  });

  it('replaces roles, edits profile, force-logs-out and resets passwords', async () => {
    const created = await facadmin.post(
      '/api/v1/users',
      newUser([{ role: 'cashier', facilityId: main.id, departmentId: null }], { mustChangePassword: false }),
    );
    const id = created.body.id;
    const bill = await ctx.db('departments').where({ facility_id: main.id, code: 'BILL' }).first('id');

    const roles = await facadmin.put(`/api/v1/users/${id}/roles`, {
      roles: [{ role: 'billing_officer', facilityId: main.id, departmentId: bill.id }],
    });
    expect(roles.body.roles.map((r) => r.role)).toEqual(['billing_officer']);

    const patched = await facadmin.patch(`/api/v1/users/${id}`, { fullName: 'Renamed Person', phone: '0712 000 111' });
    expect(patched.body).toMatchObject({ fullName: 'Renamed Person', phone: '+254712000111' });
    const audit = await ctx
      .db('audit_log')
      .where({ entity_id: id, action: 'update', entity_type: 'user' })
      .orderBy('id', 'desc')
      .first();
    expect(audit.changes.full_name).toEqual({ from: 'Wanjiku Test', to: 'Renamed Person' });

    const session = await signIn(ctx.app, created.body.username, STRONG);
    expect((await facadmin.post(`/api/v1/users/${id}/force-logout`)).body.sessionsEnded).toBe(1);
    expect((await session.get('/api/v1/auth/me')).status).toBe(401);

    expect((await facadmin.post(`/api/v1/users/${id}/reset-password`, { password: 'Res3t!Password' })).status).toBe(
      200,
    );
    const after = await signIn(ctx.app, created.body.username, 'Res3t!Password');
    expect((await after.get('/api/v1/auth/me')).body.user.mustChangePassword).toBe(true);
  });

  it('lists roles with their permissions', async () => {
    const res = await facadmin.get('/api/v1/roles');
    expect(res.body.data).toHaveLength(19);
    const cashier = res.body.data.find((r) => r.code === 'cashier');
    expect(cashier.permissions).toContain('billing.payment.receive');
    expect(cashier.clinical).toBe(false);
  });
});
