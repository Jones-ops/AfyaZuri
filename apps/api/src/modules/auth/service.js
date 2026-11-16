import { authenticator } from 'otplib';
import { checkPassword, effectivePermissions } from '@afyazuri/shared';
import { AppError, badRequest, forbidden, unauthorized } from '../../lib/errors.js';
import { burnVerify, hashPassword, verifyPassword } from '../../lib/passwords.js';
import { sha256 } from '../../lib/crypto.js';
import { recordAudit } from '../audit/service.js';
import { accessibleFacilities, loadGrants, revokeSession, revokeUserSessions } from './repository.js';
import { issueRefreshToken, signAccessToken } from './tokens.js';

authenticator.options = { window: 1 };
const INVALID = () => unauthorized('INVALID_CREDENTIALS', 'Incorrect username or password');

/**
 * @typedef {{db: import('knex').Knex, config: import('../../config.js').Config, crypto: import('../../lib/crypto.js').FieldCrypto}} Deps
 * @typedef {{ip?: string|null, userAgent?: string|null, requestId?: string|null}} Meta
 */

/**
 * Verify credentials (and TOTP when enrolled), apply lockout, and start a session.
 * @param {Deps} deps
 * @param {{username: string, password: string, totp?: string, facilityId?: string}} input
 * @param {Meta} meta
 */
export async function login({ db, config, crypto }, input, meta) {
  const user = await db('users').where({ username: input.username }).whereNull('deleted_at').first();
  const failAudit = (reason, actor = null) =>
    recordAudit(db, actor, meta, {
      action: 'login_failed',
      entityType: 'user',
      entityId: actor?.userId ?? null,
      facilityId: null,
      metadata: { username: input.username, reason },
    });

  if (!user) {
    await burnVerify(input.password);
    await failAudit('unknown_user');
    throw INVALID();
  }
  const actor = { userId: user.id, username: user.username, roles: [], facilityId: null };

  if (user.locked_until && user.locked_until > new Date()) {
    await failAudit('locked', actor);
    throw new AppError(
      423,
      'ACCOUNT_LOCKED',
      'Too many failed attempts. Try again later or ask an administrator to unlock your account.',
      {
        lockedUntil: user.locked_until,
      },
    );
  }
  if (user.locked_until) {
    // The lock has expired: start counting failures afresh.
    await db('users').where({ id: user.id }).update({ failed_login_count: 0, locked_until: null });
  }

  if (!(await verifyPassword(user.password_hash, input.password))) {
    const [row] = await db('users')
      .where({ id: user.id })
      .update({
        failed_login_count: db.raw('failed_login_count + 1'),
        locked_until: db.raw(
          `CASE WHEN failed_login_count + 1 >= ? THEN now() + make_interval(mins => ?) ELSE locked_until END`,
          [config.LOGIN_MAX_ATTEMPTS, config.LOCKOUT_MINUTES],
        ),
      })
      .returning(['failed_login_count', 'locked_until']);
    await failAudit('bad_password', actor);
    if (row.failed_login_count === config.LOGIN_MAX_ATTEMPTS)
      await recordAudit(db, actor, meta, {
        action: 'lockout',
        entityType: 'user',
        entityId: user.id,
        facilityId: null,
      });
    throw INVALID();
  }

  if (user.status !== 'active') {
    await failAudit('disabled', actor);
    throw new AppError(403, 'ACCOUNT_DISABLED', 'This account is disabled. Contact your administrator.');
  }

  if (user.totp_enabled) {
    if (!input.totp) throw new AppError(401, 'MFA_REQUIRED', 'Enter the 6-digit code from your authenticator app');
    if (!authenticator.check(input.totp, crypto.decrypt(user.totp_secret_enc))) {
      await failAudit('bad_totp', actor);
      throw new AppError(401, 'INVALID_TOTP', 'That code is not valid. Check your authenticator app and try again.');
    }
  }

  const grants = await loadGrants(db, user.id);
  const facilities = await accessibleFacilities(db, grants);
  const isGlobal = grants.some((g) => g.facilityId === null);
  let facility = null;
  if (facilities.length) {
    const pickId = input.facilityId ?? user.default_facility_id;
    facility = facilities.find((f) => f.id === pickId) ?? (input.facilityId ? null : facilities[0]);
    if (!facility) throw forbidden('You do not have access to that facility');
  } else if (!isGlobal) {
    throw forbidden('Your account has no facility access. Contact your administrator.');
  }
  // else: a fresh installation — a deployment admin signs in without a facility to create the first one.

  return db.transaction(async (trx) => {
    await trx('users')
      .where({ id: user.id })
      .update({ failed_login_count: 0, locked_until: null, last_login_at: trx.fn.now() });
    const expiresAt = new Date(Date.now() + config.SESSION_MAX_AGE_SEC * 1000);
    const [session] = await trx('sessions')
      .insert({
        user_id: user.id,
        facility_id: facility?.id ?? null,
        expires_at: expiresAt,
        ip: meta.ip ?? null,
        user_agent: meta.userAgent ?? null,
        mfa_verified: user.totp_enabled,
      })
      .returning('*');
    const refresh = await issueRefreshToken(trx, config, { sessionId: session.id, sessionExpiresAt: expiresAt });
    await recordAudit(trx, { ...actor, facilityId: facility?.id ?? null }, meta, {
      action: 'login',
      entityType: 'session',
      entityId: session.id,
    });
    return {
      sessionId: session.id,
      accessToken: signAccessToken(config, { userId: user.id, sessionId: session.id }),
      refreshToken: refresh.token,
      refreshExpiresAt: refresh.expiresAt,
    };
  });
}

/**
 * Rotate a refresh token. Presenting an already-used token means it was
 * copied: the whole session is revoked and the event audited.
 * @param {Deps} deps
 * @param {string|undefined} token
 * @param {Meta} meta
 */
export async function refresh({ db, config }, token, meta) {
  if (!token) throw unauthorized('NO_REFRESH_TOKEN', 'Please sign in');
  // Revocations must commit even though the request fails, so the transaction
  // returns a failure marker instead of throwing (a throw would roll them back).
  const result = await db.transaction(async (trx) => {
    const row = await trx('refresh_tokens as rt')
      .join('sessions as s', 's.id', 'rt.session_id')
      .join('users as u', 'u.id', 's.user_id')
      .where('rt.token_hash', sha256(token))
      .forUpdate('rt')
      .first(
        'rt.id',
        'rt.used_at',
        'rt.expires_at',
        'rt.revoked_at',
        's.id as session_id',
        's.revoked_at as session_revoked_at',
        's.expires_at as session_expires_at',
        's.last_seen_at',
        's.facility_id',
        'u.id as user_id',
        'u.username',
        'u.status',
      );
    if (!row) return { fail: unauthorized('INVALID_REFRESH_TOKEN', 'Please sign in') };

    if (row.used_at) {
      await revokeSession(trx, row.session_id, 'refresh_token_reuse');
      await recordAudit(
        trx,
        { userId: row.user_id, username: row.username, roles: [], facilityId: row.facility_id },
        meta,
        {
          action: 'token_reuse',
          entityType: 'session',
          entityId: row.session_id,
          metadata: { note: 'A previously used refresh token was presented; session revoked' },
        },
      );
      return {
        fail: unauthorized('REFRESH_TOKEN_REUSED', 'For your security this session was ended. Please sign in again.'),
      };
    }
    const idle = Date.now() - new Date(row.last_seen_at).getTime() > config.SESSION_IDLE_MINUTES * 60_000;
    if (row.revoked_at || row.session_revoked_at || row.expires_at < new Date() || row.status !== 'active' || idle) {
      if (idle && !row.session_revoked_at) await revokeSession(trx, row.session_id, 'idle_timeout');
      return { fail: unauthorized('SESSION_ENDED', 'Your session has ended. Please sign in again.') };
    }

    await trx('refresh_tokens').where({ id: row.id }).update({ used_at: trx.fn.now() });
    const next = await issueRefreshToken(trx, config, {
      sessionId: row.session_id,
      sessionExpiresAt: row.session_expires_at,
      parentId: row.id,
    });
    return {
      accessToken: signAccessToken(config, { userId: row.user_id, sessionId: row.session_id }),
      refreshToken: next.token,
      refreshExpiresAt: next.expiresAt,
    };
  });
  if ('fail' in result) throw result.fail;
  return result;
}

/**
 * Profile, facility and effective permissions for the signed-in user.
 * @param {Deps} deps
 * @param {import('../../middleware/auth.js').AuthContext} auth
 */
export async function me({ db, config }, auth) {
  const user = await db('users').where({ id: auth.userId }).first();
  const facilities = await accessibleFacilities(db, auth.grants);
  const facility = facilities.find((f) => f.id === auth.facilityId) ?? null;
  return {
    user: {
      id: user.id,
      username: user.username,
      fullName: user.full_name,
      email: user.email,
      cadre: user.cadre,
      licenceBody: user.licence_body,
      licenceNumber: user.licence_number,
      mustChangePassword: user.must_change_password,
      totpEnabled: user.totp_enabled,
    },
    facility: facility && { id: facility.id, name: facility.name, kmhflCode: facility.kmhfl_code },
    facilities: facilities.map((f) => ({ id: f.id, name: f.name, kmhflCode: f.kmhfl_code })),
    roles: auth.roles,
    permissions: effectivePermissions(auth.grants, auth.facilityId),
    session: { idleMinutes: config.SESSION_IDLE_MINUTES, require2fa: config.REQUIRE_2FA_PRIVILEGED },
  };
}

/**
 * @param {Deps} deps
 * @param {import('../../middleware/auth.js').AuthContext} auth
 * @param {{currentPassword: string, newPassword: string}} input
 * @param {Meta} meta
 */
export async function changePassword({ db }, auth, input, meta) {
  const user = await db('users').where({ id: auth.userId }).first();
  if (!(await verifyPassword(user.password_hash, input.currentPassword)))
    throw badRequest('Your current password is incorrect');
  const problems = checkPassword(input.newPassword, { username: user.username });
  if (problems.length) throw new AppError(400, 'WEAK_PASSWORD', 'Password does not meet the policy', { problems });
  if (await verifyPassword(user.password_hash, input.newPassword))
    throw new AppError(400, 'WEAK_PASSWORD', 'Choose a password you have not used before', {
      problems: ['Must differ from the current password'],
    });

  const hash = await hashPassword(input.newPassword);
  await db.transaction(async (trx) => {
    await trx('users').where({ id: user.id }).update({
      password_hash: hash,
      must_change_password: false,
      password_changed_at: trx.fn.now(),
      updated_by: user.id,
    });
    await revokeUserSessions(trx, user.id, 'password_changed', auth.sessionId);
    await recordAudit(trx, actorFrom(auth), meta, {
      action: 'update',
      entityType: 'user',
      entityId: user.id,
      metadata: { field: 'password' },
    });
  });
}

/**
 * Move the session to another facility the user has access to.
 * @param {Deps} deps
 * @param {import('../../middleware/auth.js').AuthContext} auth
 * @param {string} facilityId
 * @param {Meta} meta
 */
export async function switchFacility({ db }, auth, facilityId, meta) {
  const facilities = await accessibleFacilities(db, auth.grants);
  if (!facilities.some((f) => f.id === facilityId)) throw forbidden('You do not have access to that facility');
  await db('sessions').where({ id: auth.sessionId }).update({ facility_id: facilityId });
  await recordAudit(db, { ...actorFrom(auth), facilityId }, meta, {
    action: 'update',
    entityType: 'session',
    entityId: auth.sessionId,
    metadata: { switchedFrom: auth.facilityId },
  });
}

/**
 * Begin TOTP enrolment: store a pending secret and return the otpauth URL.
 * @param {Deps} deps
 * @param {import('../../middleware/auth.js').AuthContext} auth
 */
export async function totpSetup({ db, crypto }, auth) {
  const user = await db('users').where({ id: auth.userId }).first();
  if (user.totp_enabled) throw badRequest('Two-factor authentication is already enabled');
  const secret = authenticator.generateSecret();
  await db('users')
    .where({ id: user.id })
    .update({ totp_secret_enc: crypto.encrypt(secret) });
  return { secret, otpauthUrl: authenticator.keyuri(user.username, 'Afyazuri', secret) };
}

/**
 * Confirm enrolment with a code from the app.
 * @param {Deps} deps
 * @param {import('../../middleware/auth.js').AuthContext} auth
 * @param {string} code
 * @param {Meta} meta
 */
export async function totpEnable({ db, crypto }, auth, code, meta) {
  const user = await db('users').where({ id: auth.userId }).first();
  if (user.totp_enabled) throw badRequest('Two-factor authentication is already enabled');
  if (!user.totp_secret_enc) throw badRequest('Start setup first');
  if (!authenticator.check(code, crypto.decrypt(user.totp_secret_enc)))
    throw new AppError(400, 'INVALID_TOTP', 'That code is not valid');
  await db.transaction(async (trx) => {
    await trx('users').where({ id: user.id }).update({ totp_enabled: true });
    await recordAudit(trx, actorFrom(auth), meta, {
      action: 'update',
      entityType: 'user',
      entityId: user.id,
      metadata: { field: 'totp', enabled: true },
    });
  });
}

/**
 * @param {Deps} deps
 * @param {import('../../middleware/auth.js').AuthContext} auth
 * @param {string} code
 * @param {Meta} meta
 */
export async function totpDisable({ db, crypto }, auth, code, meta) {
  const user = await db('users').where({ id: auth.userId }).first();
  if (!user.totp_enabled) throw badRequest('Two-factor authentication is not enabled');
  if (!authenticator.check(code, crypto.decrypt(user.totp_secret_enc)))
    throw new AppError(400, 'INVALID_TOTP', 'That code is not valid');
  await db.transaction(async (trx) => {
    await trx('users').where({ id: user.id }).update({ totp_enabled: false, totp_secret_enc: null });
    await recordAudit(trx, actorFrom(auth), meta, {
      action: 'update',
      entityType: 'user',
      entityId: user.id,
      metadata: { field: 'totp', enabled: false },
    });
  });
}

/** @param {import('../../middleware/auth.js').AuthContext} auth */
const actorFrom = (auth) => ({
  userId: auth.userId,
  username: auth.username,
  roles: auth.roles,
  facilityId: auth.facilityId,
});
