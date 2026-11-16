import jwt from 'jsonwebtoken';
import { randomToken, sha256 } from '../../lib/crypto.js';

export const ACCESS_COOKIE = 'az_at';
export const REFRESH_COOKIE = 'az_rt';
const ISSUER = 'afyazuri';

/**
 * @param {import('../../config.js').Config} config
 * @param {{userId: string, sessionId: string}} claims
 */
export const signAccessToken = (config, { userId, sessionId }) =>
  jwt.sign({ sid: sessionId }, config.JWT_SECRET, {
    algorithm: 'HS256',
    subject: userId,
    issuer: ISSUER,
    expiresIn: config.ACCESS_TOKEN_TTL_SEC,
  });

/**
 * @param {import('../../config.js').Config} config
 * @param {string} token
 * @param {{ignoreExpiration?: boolean}} [opts]
 * @returns {{sub: string, sid: string}}
 */
export const verifyAccessToken = (config, token, opts = {}) =>
  /** @type {any} */ (jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'], issuer: ISSUER, ...opts }));

/**
 * Issue a refresh token for a session, optionally rotating from a parent token.
 * Only the SHA-256 of the token is stored.
 * @param {import('knex').Knex | import('knex').Knex.Transaction} db
 * @param {import('../../config.js').Config} config
 * @param {{sessionId: string, sessionExpiresAt: Date, parentId?: string|null}} args
 */
export async function issueRefreshToken(db, config, { sessionId, sessionExpiresAt, parentId = null }) {
  const token = randomToken(32);
  const ttlEnd = new Date(Date.now() + config.REFRESH_TOKEN_TTL_SEC * 1000);
  const expiresAt = ttlEnd < sessionExpiresAt ? ttlEnd : sessionExpiresAt;
  await db('refresh_tokens').insert({
    session_id: sessionId,
    token_hash: sha256(token),
    parent_id: parentId,
    expires_at: expiresAt,
  });
  return { token, expiresAt };
}

/**
 * Set both auth cookies on a response.
 * @param {import('express').Response} res
 * @param {import('../../config.js').Config} config
 * @param {{accessToken: string, refreshToken: string, refreshExpiresAt: Date}} t
 */
export function setAuthCookies(res, config, t) {
  const base = { httpOnly: true, secure: config.cookieSecure, sameSite: /** @type {const} */ ('strict') };
  res.cookie(ACCESS_COOKIE, t.accessToken, { ...base, path: '/api', maxAge: config.ACCESS_TOKEN_TTL_SEC * 1000 });
  res.cookie(REFRESH_COOKIE, t.refreshToken, {
    ...base,
    path: '/api/v1/auth',
    maxAge: Math.max(0, t.refreshExpiresAt.getTime() - Date.now()),
  });
}

/** @param {import('express').Response} res @param {import('../../config.js').Config} config */
export function clearAuthCookies(res, config) {
  const base = { httpOnly: true, secure: config.cookieSecure, sameSite: /** @type {const} */ ('strict') };
  res.clearCookie(ACCESS_COOKIE, { ...base, path: '/api' });
  res.clearCookie(REFRESH_COOKIE, { ...base, path: '/api/v1/auth' });
}
