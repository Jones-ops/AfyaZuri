import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { changePasswordBody, loginBody, switchFacilityBody, totpVerifyBody } from '@afyazuri/shared';
import { requestMeta, validate } from '../../lib/http.js';
import { sha256 } from '../../lib/crypto.js';
import { authenticate } from '../../middleware/auth.js';
import { recordAudit } from '../audit/service.js';
import { revokeSession } from './repository.js';
import * as svc from './service.js';
import { ACCESS_COOKIE, REFRESH_COOKIE, clearAuthCookies, setAuthCookies, verifyAccessToken } from './tokens.js';

/** @param {import('../../app.js').Deps} deps */
export function authRoutes(deps) {
  const { db, config } = deps;
  const r = Router();
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: config.AUTH_RATE_LIMIT_PER_MIN,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) =>
      res.status(429).json({
        error: { code: 'RATE_LIMITED', message: 'Too many attempts. Wait a minute and try again.', details: null },
      }),
  });
  const auth = authenticate(deps);
  const authPending = authenticate(deps, { allowPending: true });

  r.post('/login', limiter, validate({ body: loginBody }), async (req, res) => {
    const t = await svc.login(deps, req.valid.body, requestMeta(req));
    setAuthCookies(res, config, t);
    res.json({ ok: true, accessTokenExpiresIn: config.ACCESS_TOKEN_TTL_SEC });
  });

  r.post('/refresh', limiter, async (req, res) => {
    try {
      const t = await svc.refresh(deps, req.cookies?.[REFRESH_COOKIE], requestMeta(req));
      setAuthCookies(res, config, t);
      res.json({ ok: true, accessTokenExpiresIn: config.ACCESS_TOKEN_TTL_SEC });
    } catch (err) {
      clearAuthCookies(res, config);
      throw err;
    }
  });

  // Logout works even with an expired access token, falling back to the refresh token.
  r.post('/logout', async (req, res) => {
    let sessionId = null;
    let userId = null;
    const at = req.cookies?.[ACCESS_COOKIE];
    if (at) {
      try {
        const c = verifyAccessToken(config, at, { ignoreExpiration: true });
        sessionId = c.sid;
        userId = c.sub;
      } catch {
        /* fall through */
      }
    }
    if (!sessionId && req.cookies?.[REFRESH_COOKIE]) {
      const row = await db('refresh_tokens as rt')
        .join('sessions as s', 's.id', 'rt.session_id')
        .where('rt.token_hash', sha256(req.cookies[REFRESH_COOKIE]))
        .first('s.id', 's.user_id');
      sessionId = row?.id ?? null;
      userId = row?.user_id ?? null;
    }
    if (sessionId) {
      const n = await revokeSession(db, sessionId, 'logout');
      if (n) {
        const u = await db('users').where({ id: userId }).first('username');
        await recordAudit(db, { userId, username: u?.username, roles: [], facilityId: null }, requestMeta(req), {
          action: 'logout',
          entityType: 'session',
          entityId: sessionId,
        });
      }
    }
    clearAuthCookies(res, config);
    res.json({ ok: true });
  });

  r.get('/me', authPending, async (req, res) => res.json(await svc.me(deps, req.auth)));

  r.post('/change-password', authPending, validate({ body: changePasswordBody }), async (req, res) => {
    await svc.changePassword(deps, req.auth, req.valid.body, requestMeta(req));
    res.json({ ok: true });
  });

  r.post('/switch-facility', auth, validate({ body: switchFacilityBody }), async (req, res) => {
    await svc.switchFacility(deps, req.auth, req.valid.body.facilityId, requestMeta(req));
    res.json({ ok: true });
  });

  r.post('/totp/setup', authPending, async (req, res) => res.json(await svc.totpSetup(deps, req.auth)));
  r.post('/totp/enable', authPending, validate({ body: totpVerifyBody }), async (req, res) => {
    await svc.totpEnable(deps, req.auth, req.valid.body.code, requestMeta(req));
    res.json({ ok: true });
  });
  r.post('/totp/disable', auth, validate({ body: totpVerifyBody }), async (req, res) => {
    await svc.totpDisable(deps, req.auth, req.valid.body.code, requestMeta(req));
    res.json({ ok: true });
  });

  return r;
}
