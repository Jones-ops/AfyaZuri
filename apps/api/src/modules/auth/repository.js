/**
 * Load every role grant a user holds, with the permissions of each role.
 * @param {import('knex').Knex} db
 * @param {string} userId
 * @returns {Promise<import('@afyazuri/shared').Grant[]>}
 */
export async function loadGrants(db, userId) {
  const rows = await db('user_roles as ur')
    .join('roles as r', 'r.id', 'ur.role_id')
    .leftJoin('role_permissions as rp', 'rp.role_id', 'r.id')
    .where('ur.user_id', userId)
    .groupBy('ur.id', 'r.code', 'ur.facility_id', 'ur.department_id')
    .select(
      'r.code as role',
      'ur.facility_id',
      'ur.department_id',
      db.raw(
        `COALESCE(array_agg(rp.permission_code ORDER BY rp.permission_code)
           FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions`,
      ),
    );
  return rows.map((r) => ({
    role: r.role,
    facilityId: r.facility_id,
    departmentId: r.department_id,
    permissions: r.permissions,
  }));
}

/**
 * Facilities a user may work in: every active facility for deployment-wide
 * grants, otherwise the facilities named in their grants.
 * @param {import('knex').Knex} db
 * @param {import('@afyazuri/shared').Grant[]} grants
 */
export async function accessibleFacilities(db, grants) {
  const q = db('facilities').where('active', true).select('id', 'name', 'kmhfl_code').orderBy('name');
  if (grants.some((g) => g.facilityId === null)) return q;
  const ids = [...new Set(grants.map((g) => g.facilityId))];
  return ids.length ? q.whereIn('id', ids) : [];
}

/** @param {import('knex').Knex} db @param {string} sessionId @param {string} reason */
export const revokeSession = (db, sessionId, reason) =>
  db('sessions').where({ id: sessionId }).whereNull('revoked_at').update({ revoked_at: db.fn.now(), revoked_reason: reason });

/** @param {import('knex').Knex} db @param {string} userId @param {string} reason @param {string} [exceptSessionId] */
export function revokeUserSessions(db, userId, reason, exceptSessionId) {
  const q = db('sessions').where({ user_id: userId }).whereNull('revoked_at');
  if (exceptSessionId) q.whereNot('id', exceptSessionId);
  return q.update({ revoked_at: db.fn.now(), revoked_reason: reason });
}
