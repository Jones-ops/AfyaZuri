import jwt from 'jsonwebtoken';
import { TWO_FACTOR_ROLES, hasPermission } from '@afyazuri/shared';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import { ACCESS_COOKIE, verifyAccessToken } from '../modules/auth/tokens.js';
import { loadGrants, revokeSession } from '../modules/auth/repository.js';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const CSRF_HEADER = 'x-afyazuri-client';

/**
 * Reject state-changing requests that lack the client header. Browsers cannot
 * add custom headers to cross-site requests without a CORS preflight, which
 * our strict CORS policy refuses, so this blocks CSRF on cookie-auth routes.
 * @type {import('express').RequestHandler}
 */
export function csrfGuard(req, _res, next) {
  if (UNSAFE.has(req.method) && req.get(CSRF_HEADER) !== '1')
    throw new AppError(403, 'CSRF_HEADER_MISSING', `Missing ${CSRF_HEADER} header`);
  next();
}

/**
 * @typedef {Object} AuthContext
 * @property {string} userId
 * @property {string} username
 * @property {string} fullName
 * @property {string} sessionId
 * @property {string|null} facilityId active facility for this session
 * @property {import('@afyazuri/shared').Grant[]} grants
 * @property {string[]} roles role codes that apply at the active facility
 * @property {boolean} mustChangePassword
 * @property {boolean} totpEnabled
 */

/**
 * Authenticate the request from the access-token cookie and load the live
 * session, user and grants. Revoked, idle or disabled sessions are refused
 * on every request, so force-logout and disabling take effect immediately.
 * @param {{db: import('knex').Knex, config: import('../config.js').Config}} deps
 * @param {{allowPending?: boolean}} [opts] allowPending lets users who must change
 *   their password or enrol 2FA reach the endpoints that let them do so.
 * @returns {import('express').RequestHandler}
 */
export function authenticate({ db, config }, opts = {}) {
  return async (req, _res, next) => {
    const token = req.cookies?.[ACCESS_COOKIE];
    if (!token) throw unauthorized();
    let claims;
    try {
      claims = verifyAccessToken(config, token);
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) throw unauthorized('TOKEN_EXPIRED', 'Session token expired');
      throw unauthorized('INVALID_TOKEN', 'Invalid session token');
    }

    const session = await db('sessions').where({ id: claims.sid, user_id: claims.sub }).first();
    if (!session || session.revoked_at || session.expires_at < new Date())
      throw unauthorized('SESSION_ENDED', 'Your session has ended. Please sign in again.');

    const idleMs = Date.now() - new Date(session.last_seen_at).getTime();
    if (idleMs > config.SESSION_IDLE_MINUTES * 60_000) {
      await revokeSession(db, session.id, 'idle_timeout');
      throw unauthorized('SESSION_IDLE', 'You were signed out after a period of inactivity.');
    }

    const user = await db('users').where({ id: session.user_id }).whereNull('deleted_at').first();
    if (!user || user.status !== 'active') {
      await revokeSession(db, session.id, 'user_disabled');
      throw unauthorized('ACCOUNT_DISABLED', 'This account is disabled.');
    }

    const grants = await loadGrants(db, user.id);
    if (idleMs > 60_000) await db('sessions').where({ id: session.id }).update({ last_seen_at: db.fn.now() });

    const roles = [
      ...new Set(
        grants.filter((g) => g.facilityId === null || g.facilityId === session.facility_id).map((g) => g.role),
      ),
    ];
    /** @type {AuthContext} */
    req.auth = {
      userId: user.id,
      username: user.username,
      fullName: user.full_name,
      sessionId: session.id,
      facilityId: session.facility_id,
      grants,
      roles,
      mustChangePassword: user.must_change_password,
      totpEnabled: user.totp_enabled,
    };

    if (!opts.allowPending) {
      if (user.must_change_password)
        throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'Change your password to continue.');
      if (config.REQUIRE_2FA_PRIVILEGED && !user.totp_enabled && roles.some((r) => TWO_FACTOR_ROLES.includes(r)))
        throw new AppError(403, 'MFA_ENROLMENT_REQUIRED', 'Set up two-factor authentication to continue.');
    }
    next();
  };
}

/**
 * Require at least one of the given permissions at the session's facility.
 * @param {string | string[]} permissions
 * @param {{department?: (req: import('express').Request) => string|undefined}} [opts]
 * @returns {import('express').RequestHandler}
 */
export function requirePermission(permissions, opts = {}) {
  const list = Array.isArray(permissions) ? permissions : [permissions];
  return (req, _res, next) => {
    const { grants, facilityId } = req.auth;
    const departmentId = opts.department?.(req);
    if (!list.some((p) => hasPermission(grants, p, { facilityId, departmentId })))
      throw forbidden('You do not have permission to do that', { required: list });
    next();
  };
}

/**
 * Audit actor derived from the request.
 * @param {import('express').Request} req
 */
export const actorOf = (req) =>
  req.auth
    ? { userId: req.auth.userId, username: req.auth.username, roles: req.auth.roles, facilityId: req.auth.facilityId }
    : null;
