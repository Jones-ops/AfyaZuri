import { authenticator } from 'otplib';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_PASSWORD, STRONG, client, makeApp, signIn, uniq } from '../helpers.js';

let ctx;
let admin;
beforeAll(async () => {
  ctx = makeApp();
  admin = await signIn(ctx.app, 'admin');
});
afterAll(() => ctx.db.destroy());

/** Create a user at the demo hospital through the API. */
async function createUser(role = 'cashier', extra = {}) {
  const facility = await ctx.db('facilities').where({ kmhfl_code: '99001' }).first('id');
  const username = uniq('u');
  const res = await admin.post('/api/v1/users', {
    username, fullName: 'Test User', password: STRONG, mustChangePassword: false,
    roles: [{ role, facilityId: facility.id, departmentId: null }], ...extra,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { username, id: res.body.id };
}

/** Pull a cookie value out of a Set-Cookie header list. */
const cookie = (res, name) => res.headers['set-cookie']?.find((c) => c.startsWith(`${name}=`))?.split(';')[0];

describe('health', () => {
  it('reports liveness and readiness', async () => {
    expect((await request(ctx.app).get('/health')).body).toEqual({ status: 'ok' });
    expect((await request(ctx.app).get('/ready')).body).toEqual({ status: 'ready' });
    const m = await request(ctx.app).get('/metrics');
    expect(m.text).toContain('afyazuri_http_requests_total');
  });
});

describe('login', () => {
  it('signs in, sets httpOnly cookies and returns the profile', async () => {
    const c = client(ctx.app);
    const res = await c.post('/api/v1/auth/login', { username: 'doctor', password: DEMO_PASSWORD });
    expect(res.status).toBe(200);
    const cookies = res.headers['set-cookie'].join(';');
    expect(cookies).toMatch(/az_at=.*HttpOnly/);
    expect(cookies).toMatch(/SameSite=Strict/);
    expect(res.body).not.toHaveProperty('accessToken');

    const me = await c.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.username).toBe('doctor');
    expect(me.body.facility.kmhflCode).toBe('99001');
    expect(me.body.permissions).toContain('emr.read');
    expect(me.body.permissions).not.toContain('users.manage');
  });

  it('gives the same answer for a wrong password and an unknown user', async () => {
    const a = await client(ctx.app).post('/api/v1/auth/login', { username: 'doctor', password: 'wrong-password' });
    const b = await client(ctx.app).post('/api/v1/auth/login', { username: 'nobody-here', password: 'wrong-password' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(b.body.error).toEqual(a.body.error);
    const failed = await ctx.db('audit_log').where({ action: 'login_failed' }).count({ n: '*' }).first();
    expect(Number(failed.n)).toBeGreaterThanOrEqual(2);
  });

  it('validates the body with the standard error shape', async () => {
    const res = await client(ctx.app).post('/api/v1/auth/login', { username: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.issues.map((i) => i.path)).toEqual(expect.arrayContaining(['username', 'password']));
  });

  it('locks the account after 5 failures and an admin can unlock it', async () => {
    const { username, id } = await createUser();
    for (let i = 0; i < 5; i++)
      expect((await client(ctx.app).post('/api/v1/auth/login', { username, password: 'Wrong!pass1' })).status).toBe(401);
    const locked = await client(ctx.app).post('/api/v1/auth/login', { username, password: STRONG });
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
    expect(await ctx.db('audit_log').where({ action: 'lockout', entity_id: id }).first()).toBeTruthy();

    expect((await admin.post(`/api/v1/users/${id}/unlock`)).status).toBe(200);
    expect((await client(ctx.app).post('/api/v1/auth/login', { username, password: STRONG })).status).toBe(200);
  });

  it('rate-limits login attempts', async () => {
    const limited = makeApp({ AUTH_RATE_LIMIT_PER_MIN: '3' });
    const statuses = [];
    for (let i = 0; i < 4; i++)
      statuses.push((await client(limited.app).post('/api/v1/auth/login', { username: 'nobody', password: 'x' })).status);
    expect(statuses).toEqual([401, 401, 401, 429]);
    await limited.db.destroy();
  });

  it('refuses state-changing requests without the CSRF header', async () => {
    const res = await request(ctx.app).post('/api/v1/auth/login').send({ username: 'doctor', password: DEMO_PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_HEADER_MISSING');
  });
});

describe('sessions', () => {
  it('rotates refresh tokens and revokes the session when an old one is replayed', async () => {
    const c = client(ctx.app);
    const login = await c.post('/api/v1/auth/login', { username: 'triage', password: DEMO_PASSWORD });
    const firstRefresh = cookie(login, 'az_rt');

    const r1 = await c.post('/api/v1/auth/refresh');
    expect(r1.status).toBe(200);
    expect(cookie(r1, 'az_rt')).not.toBe(firstRefresh);
    expect((await c.get('/api/v1/auth/me')).status).toBe(200);

    const replay = await request(ctx.app).post('/api/v1/auth/refresh').set('X-AfyaZuri-Client', '1').set('Cookie', firstRefresh);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('REFRESH_TOKEN_REUSED');
    expect((await c.get('/api/v1/auth/me')).body.error.code).toBe('SESSION_ENDED');
    expect(await ctx.db('audit_log').where({ action: 'token_reuse' }).first()).toBeTruthy();
  });

  it('signs out idle sessions', async () => {
    const c = await signIn(ctx.app, 'records');
    const me = await c.get('/api/v1/auth/me');
    await ctx.db('sessions').where({ user_id: me.body.user.id }).whereNull('revoked_at')
      .update({ last_seen_at: ctx.db.raw(`now() - interval '1 hour'`) });
    const res = await c.get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_IDLE');
  });

  it('logs out', async () => {
    const c = await signIn(ctx.app, 'cashier');
    expect((await c.post('/api/v1/auth/logout')).status).toBe(200);
    expect((await c.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('switches facility only to facilities the user can access', async () => {
    const hc = await ctx.db('facilities').where({ kmhfl_code: '99002' }).first('id');
    const locum = await signIn(ctx.app, 'locum');
    expect((await locum.get('/api/v1/auth/me')).body.facilities).toHaveLength(2);
    expect((await locum.post('/api/v1/auth/switch-facility', { facilityId: hc.id })).status).toBe(200);
    expect((await locum.get('/api/v1/auth/me')).body.facility.kmhflCode).toBe('99002');

    const doctor = await signIn(ctx.app, 'doctor');
    expect((await doctor.post('/api/v1/auth/switch-facility', { facilityId: hc.id })).status).toBe(403);
  });
});

describe('account state', () => {
  it('forces a password change before anything else', async () => {
    const { username } = await createUser('cashier', { mustChangePassword: true });
    const c = await signIn(ctx.app, username, STRONG);
    expect((await c.get('/api/v1/auth/me')).body.user.mustChangePassword).toBe(true);
    const blocked = await c.get('/api/v1/users');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const weak = await c.post('/api/v1/auth/change-password', { currentPassword: STRONG, newPassword: 'aaaaaaaaaa' });
    expect(weak.body.error.code).toBe('WEAK_PASSWORD');
    expect(weak.body.error.details.problems.length).toBeGreaterThan(0);

    const ok = await c.post('/api/v1/auth/change-password', { currentPassword: STRONG, newPassword: 'N3w!Password#x' });
    expect(ok.status).toBe(200);
    expect((await c.get('/api/v1/auth/me')).body.user.mustChangePassword).toBe(false);
  });

  it('enrols TOTP and then requires it at login', async () => {
    const { username } = await createUser('accountant');
    const c = await signIn(ctx.app, username, STRONG);
    const setup = await c.post('/api/v1/auth/totp/setup');
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\/AfyaZuri:/);
    expect((await c.post('/api/v1/auth/totp/enable', { code: '000000' })).status).toBe(400);
    expect((await c.post('/api/v1/auth/totp/enable', { code: authenticator.generate(setup.body.secret) })).status).toBe(200);

    const noCode = await client(ctx.app).post('/api/v1/auth/login', { username, password: STRONG });
    expect(noCode.body.error.code).toBe('MFA_REQUIRED');
    const badCode = await client(ctx.app).post('/api/v1/auth/login', { username, password: STRONG, totp: '123456' });
    expect(badCode.body.error.code).toBe('INVALID_TOTP');
    const good = await client(ctx.app).post('/api/v1/auth/login', {
      username, password: STRONG, totp: authenticator.generate(setup.body.secret),
    });
    expect(good.status).toBe(200);

    const row = await ctx.db('users').where({ username }).first('totp_secret_enc');
    expect(row.totp_secret_enc).toMatch(/^v1:/);
    expect(row.totp_secret_enc).not.toContain(setup.body.secret);
  });

  it('can require 2FA enrolment for privileged roles', async () => {
    const strict = makeApp({ REQUIRE_2FA_PRIVILEGED: 'true' });
    const fa = await signIn(strict.app, 'facadmin');
    const res = await fa.get('/api/v1/users');
    expect(res.body.error.code).toBe('MFA_ENROLMENT_REQUIRED');
    const doc = await signIn(strict.app, 'doctor');
    expect((await doc.get('/api/v1/facilities')).status).toBe(403); // not privileged: normal permission check
    expect((await doc.get('/api/v1/facilities')).body.error.code).toBe('FORBIDDEN');
    await strict.db.destroy();
  });

  it('ends sessions immediately when a user is disabled', async () => {
    const { username, id } = await createUser();
    const c = await signIn(ctx.app, username, STRONG);
    expect((await c.get('/api/v1/auth/me')).status).toBe(200);
    expect((await admin.post(`/api/v1/users/${id}/disable`, { reason: 'Left employment' })).status).toBe(200);
    expect((await c.get('/api/v1/auth/me')).status).toBe(401);
    const again = await client(ctx.app).post('/api/v1/auth/login', { username, password: STRONG });
    expect(again.body.error.code).toBe('ACCOUNT_DISABLED');
  });
});
