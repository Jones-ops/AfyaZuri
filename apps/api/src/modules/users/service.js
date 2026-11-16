import { checkPassword, hasGlobalPermission } from '@afyazuri/shared';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors.js';
import { decodeCursor, page } from '../../lib/http.js';
import { hashPassword } from '../../lib/passwords.js';
import { recordAudit } from '../audit/service.js';
import { revokeUserSessions } from '../auth/repository.js';

/**
 * @typedef {import('../../middleware/auth.js').AuthContext} AuthContext
 * @typedef {{ip?: string|null, userAgent?: string|null, requestId?: string|null}} Meta
 * @typedef {{role: string, facilityId: string|null, departmentId: string|null}} RoleAssignment
 */

const PUBLIC_COLS = [
  'id',
  'username',
  'full_name',
  'email',
  'phone',
  'status',
  'must_change_password',
  'failed_login_count',
  'locked_until',
  'last_login_at',
  'totp_enabled',
  'licence_body',
  'licence_number',
  'cadre',
  'default_facility_id',
  'disabled_at',
  'disabled_reason',
  'created_at',
  'updated_at',
];

/** @param {any} u @param {any[]} [roles] */
export const toUser = (u, roles) => ({
  id: u.id,
  username: u.username,
  fullName: u.full_name,
  email: u.email,
  phone: u.phone,
  status: u.status,
  mustChangePassword: u.must_change_password,
  locked: !!(u.locked_until && u.locked_until > new Date()),
  lastLoginAt: u.last_login_at,
  totpEnabled: u.totp_enabled,
  licenceBody: u.licence_body,
  licenceNumber: u.licence_number,
  cadre: u.cadre,
  disabledAt: u.disabled_at,
  disabledReason: u.disabled_reason,
  createdAt: u.created_at,
  ...(roles ? { roles } : {}),
});

const isGlobalAdmin = (/** @type {AuthContext} */ auth) => hasGlobalPermission(auth.grants, 'users.manage');
const actorOf = (/** @type {AuthContext} */ a) => ({
  userId: a.userId,
  username: a.username,
  roles: a.roles,
  facilityId: a.facilityId,
});

/**
 * Users the actor may see: everyone for deployment-wide admins, otherwise users
 * holding a role at the actor's facility.
 * @param {import('knex').Knex} db @param {AuthContext} auth
 */
function visibleUsers(db, auth) {
  const q = db('users as u').whereNull('u.deleted_at');
  if (!isGlobalAdmin(auth))
    q.whereExists(db('user_roles as ur').whereRaw('ur.user_id = u.id').andWhere('ur.facility_id', auth.facilityId));
  return q;
}

/** @param {import('knex').Knex} db @param {string[]} userIds */
async function rolesFor(db, userIds) {
  if (!userIds.length) return new Map();
  const rows = await db('user_roles as ur')
    .join('roles as r', 'r.id', 'ur.role_id')
    .leftJoin('facilities as f', 'f.id', 'ur.facility_id')
    .leftJoin('departments as d', 'd.id', 'ur.department_id')
    .whereIn('ur.user_id', userIds)
    .orderBy('r.name')
    .select(
      'ur.user_id',
      'r.code as role',
      'r.name as role_name',
      'ur.facility_id',
      'f.name as facility_name',
      'ur.department_id',
      'd.name as department_name',
    );
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.user_id)) map.set(r.user_id, []);
    map.get(r.user_id).push({
      role: r.role,
      roleName: r.role_name,
      facilityId: r.facility_id,
      facilityName: r.facility_name,
      departmentId: r.department_id,
      departmentName: r.department_name,
    });
  }
  return map;
}

/**
 * Load a user the actor is allowed to manage, or throw 404/403.
 * @param {import('knex').Knex} db @param {AuthContext} auth @param {string} id @param {{forWrite?: boolean}} [opts]
 */
async function getManageable(db, auth, id, opts = {}) {
  const user = await visibleUsers(db, auth).where('u.id', id).first('u.*');
  if (!user) throw notFound('User');
  if (opts.forWrite && !isGlobalAdmin(auth)) {
    const hasGlobal = await db('user_roles').where({ user_id: id }).whereNull('facility_id').first();
    if (hasGlobal) throw forbidden('Only a deployment administrator can change this account');
  }
  return user;
}

/**
 * Check role assignments are within the actor's authority and reference real
 * departments of the right facility.
 * @param {import('knex').Knex} db @param {AuthContext} auth @param {RoleAssignment[]} roles
 */
async function checkAssignments(db, auth, roles) {
  const global = isGlobalAdmin(auth);
  for (const a of roles) {
    if (!global) {
      if (a.facilityId !== auth.facilityId)
        throw forbidden('You can only assign roles at your current facility', { assignment: a });
      if (a.role === 'super_admin') throw forbidden('Only a deployment administrator can assign Super Admin');
    }
    if (a.departmentId) {
      if (!a.facilityId) throw badRequest('A department-scoped role must name its facility');
      const d = await db('departments').where({ id: a.departmentId, facility_id: a.facilityId }).first('id');
      if (!d) throw badRequest('Department does not belong to that facility', { assignment: a });
    }
    if (a.facilityId && !(await db('facilities').where({ id: a.facilityId }).first('id')))
      throw badRequest('Facility does not exist', { assignment: a });
  }
}

/**
 * @param {import('knex').Knex.Transaction} trx @param {string} userId @param {RoleAssignment[]} roles @param {string} actorId
 */
async function insertAssignments(trx, userId, roles, actorId) {
  if (!roles.length) return;
  const roleRows = await trx('roles')
    .whereIn(
      'code',
      roles.map((r) => r.role),
    )
    .select('id', 'code');
  const idOf = new Map(roleRows.map((r) => [r.code, r.id]));
  const seen = new Set();
  const rows = [];
  for (const a of roles) {
    const k = `${a.role}|${a.facilityId}|${a.departmentId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    rows.push({
      user_id: userId,
      role_id: idOf.get(a.role),
      facility_id: a.facilityId,
      department_id: a.departmentId,
      created_by: actorId,
    });
  }
  await trx('user_roles').insert(rows);
}

/**
 * @param {{db: import('knex').Knex}} deps @param {AuthContext} auth
 * @param {{limit: number, cursor?: string, q?: string, role?: string, status: string}} query
 */
export async function listUsers({ db }, auth, query) {
  const q = visibleUsers(db, auth).select(PUBLIC_COLS.map((c) => `u.${c}`));
  if (query.status !== 'all') q.andWhere('u.status', query.status);
  if (query.q) {
    const like = `%${query.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    q.andWhere((w) => w.whereILike('u.full_name', like).orWhereILike('u.username', like));
  }
  if (query.role)
    q.whereExists(
      db('user_roles as ur2')
        .join('roles as r2', 'r2.id', 'ur2.role_id')
        .whereRaw('ur2.user_id = u.id')
        .andWhere('r2.code', query.role),
    );
  const c = decodeCursor(query.cursor);
  if (c) q.andWhereRaw('(lower(u.full_name), u.id) > (?, ?)', [c.n, c.id]);
  const rows = await q.orderByRaw('lower(u.full_name), u.id').limit(query.limit + 1);
  const result = page(rows, query.limit, (u) => ({ n: u.full_name.toLowerCase(), id: u.id }));
  const roles = await rolesFor(
    db,
    result.data.map((u) => u.id),
  );
  return { data: result.data.map((u) => toUser(u, roles.get(u.id) ?? [])), nextCursor: result.nextCursor };
}

/** @param {{db: import('knex').Knex}} deps @param {AuthContext} auth @param {string} id */
export async function getUser({ db }, auth, id) {
  const u = await getManageable(db, auth, id);
  const roles = await rolesFor(db, [id]);
  return toUser(u, roles.get(id) ?? []);
}

/**
 * @param {{db: import('knex').Knex}} deps @param {AuthContext} auth
 * @param {import('zod').infer<typeof import('@afyazuri/shared').createUserBody>} input @param {Meta} meta
 */
export async function createUser({ db }, auth, input, meta) {
  const problems = checkPassword(input.password, { username: input.username });
  if (problems.length) throw new AppError(400, 'WEAK_PASSWORD', 'Password does not meet the policy', { problems });
  await checkAssignments(db, auth, input.roles);
  if (await db('users').where({ username: input.username }).first('id'))
    throw new AppError(409, 'USERNAME_TAKEN', 'That username is already in use');

  const password_hash = await hashPassword(input.password);
  const id = await db.transaction(async (trx) => {
    const [u] = await trx('users')
      .insert({
        username: input.username,
        full_name: input.fullName,
        email: input.email ?? null,
        phone: input.phone ?? null,
        password_hash,
        must_change_password: input.mustChangePassword,
        licence_body: input.licenceBody ?? null,
        licence_number: input.licenceNumber ?? null,
        cadre: input.cadre ?? null,
        default_facility_id: input.roles.find((r) => r.facilityId)?.facilityId ?? null,
        created_by: auth.userId,
        updated_by: auth.userId,
      })
      .returning('*');
    await insertAssignments(trx, u.id, input.roles, auth.userId);
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'create',
      entityType: 'user',
      entityId: u.id,
      after: u,
      metadata: { roles: input.roles },
    });
    return u.id;
  });
  return getUser({ db }, auth, id);
}

/**
 * @param {{db: import('knex').Knex}} deps @param {AuthContext} auth @param {string} id
 * @param {Record<string, any>} input @param {Meta} meta
 */
export async function updateUser({ db }, auth, id, input, meta) {
  const before = await getManageable(db, auth, id, { forWrite: true });
  const patch = {};
  const map = {
    fullName: 'full_name',
    email: 'email',
    phone: 'phone',
    licenceBody: 'licence_body',
    licenceNumber: 'licence_number',
    cadre: 'cadre',
  };
  for (const [k, col] of Object.entries(map)) if (k in input) patch[col] = input[k];
  if (!Object.keys(patch).length) return getUser({ db }, auth, id);
  await db.transaction(async (trx) => {
    const [after] = await trx('users')
      .where({ id })
      .update({ ...patch, updated_by: auth.userId })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, { action: 'update', entityType: 'user', entityId: id, before, after });
  });
  return getUser({ db }, auth, id);
}

/**
 * Replace a user's role assignments. Facility-scoped admins replace only the
 * assignments at their own facility; others are left untouched.
 * @param {{db: import('knex').Knex}} deps @param {AuthContext} auth @param {string} id
 * @param {RoleAssignment[]} roles @param {Meta} meta
 */
export async function setRoles({ db }, auth, id, roles, meta) {
  await getManageable(db, auth, id, { forWrite: true });
  await checkAssignments(db, auth, roles);
  const beforeRoles = (await rolesFor(db, [id])).get(id) ?? [];
  await db.transaction(async (trx) => {
    const del = trx('user_roles').where({ user_id: id });
    if (!isGlobalAdmin(auth)) del.andWhere('facility_id', auth.facilityId);
    await del.delete();
    await insertAssignments(trx, id, roles, auth.userId);
    const afterRoles = (await rolesFor(trx, [id])).get(id) ?? [];
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'user_roles',
      entityId: id,
      before: { roles: beforeRoles.map(summarise) },
      after: { roles: afterRoles.map(summarise) },
    });
    // Sessions keep working; permissions are re-read on every request.
  });
  return getUser({ db }, auth, id);
}
const summarise = (r) => `${r.role}@${r.facilityId ?? '*'}/${r.departmentId ?? '*'}`;

/**
 * Disable or re-enable an account. Disabling ends all of the user's sessions.
 * @param {{db: import('knex').Knex}} deps @param {AuthContext} auth @param {string} id
 * @param {{disabled: boolean, reason?: string}} input @param {Meta} meta
 */
export async function setStatus({ db }, auth, id, input, meta) {
  if (id === auth.userId) throw badRequest('You cannot disable your own account');
  const before = await getManageable(db, auth, id, { forWrite: true });
  await db.transaction(async (trx) => {
    const [after] = await trx('users')
      .where({ id })
      .update(
        input.disabled
          ? {
              status: 'disabled',
              disabled_at: trx.fn.now(),
              disabled_reason: input.reason ?? null,
              updated_by: auth.userId,
            }
          : {
              status: 'active',
              disabled_at: null,
              disabled_reason: null,
              failed_login_count: 0,
              locked_until: null,
              updated_by: auth.userId,
            },
      )
      .returning('*');
    if (input.disabled) await revokeUserSessions(trx, id, 'user_disabled');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'user',
      entityId: id,
      before,
      after,
      reason: input.reason ?? null,
    });
  });
  return getUser({ db }, auth, id);
}

/** @param {{db: import('knex').Knex}} deps @param {AuthContext} auth @param {string} id @param {Meta} meta */
export async function forceLogout({ db }, auth, id, meta) {
  await getManageable(db, auth, id, { forWrite: true });
  return db.transaction(async (trx) => {
    const count = await revokeUserSessions(trx, id, 'forced_logout');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'logout',
      entityType: 'user',
      entityId: id,
      metadata: { forced: true, sessionsEnded: count },
    });
    return count;
  });
}

/** @param {{db: import('knex').Knex}} deps @param {AuthContext} auth @param {string} id @param {string} password @param {Meta} meta */
export async function resetPassword({ db }, auth, id, password, meta) {
  const user = await getManageable(db, auth, id, { forWrite: true });
  const problems = checkPassword(password, { username: user.username });
  if (problems.length) throw new AppError(400, 'WEAK_PASSWORD', 'Password does not meet the policy', { problems });
  const hash = await hashPassword(password);
  await db.transaction(async (trx) => {
    await trx('users').where({ id }).update({
      password_hash: hash,
      must_change_password: true,
      failed_login_count: 0,
      locked_until: null,
      updated_by: auth.userId,
    });
    await revokeUserSessions(trx, id, 'password_reset');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'user',
      entityId: id,
      metadata: { field: 'password', reset: true },
    });
  });
}

/** @param {{db: import('knex').Knex}} deps @param {AuthContext} auth @param {string} id @param {Meta} meta */
export async function unlock({ db }, auth, id, meta) {
  const before = await getManageable(db, auth, id, { forWrite: true });
  await db.transaction(async (trx) => {
    const [after] = await trx('users')
      .where({ id })
      .update({ failed_login_count: 0, locked_until: null, updated_by: auth.userId })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'user',
      entityId: id,
      before,
      after,
      metadata: { unlocked: true },
    });
  });
  return getUser({ db }, auth, id);
}

/** Roles with their permissions. @param {{db: import('knex').Knex}} deps */
export async function listRoles({ db }) {
  const rows = await db('roles as r')
    .leftJoin('role_permissions as rp', 'rp.role_id', 'r.id')
    .groupBy('r.id')
    .orderBy('r.name')
    .select(
      'r.code',
      'r.name',
      'r.description',
      'r.is_clinical',
      db.raw(
        `COALESCE(array_agg(rp.permission_code ORDER BY rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions`,
      ),
    );
  return rows.map((r) => ({
    code: r.code,
    name: r.name,
    description: r.description,
    clinical: r.is_clinical,
    permissions: r.permissions,
  }));
}
