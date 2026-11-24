// In-app notifications: a per-user inbox (critical lab results, amendments, …). Written in the
// same transaction as the event that causes them. A dedupe key stops the same notice twice.
import { notFound } from '../../lib/errors.js';

/**
 * @param {import('knex').Knex | import('knex').Knex.Transaction} db
 * @param {{userId: string, facilityId?: string|null, type: string, severity?: 'info'|'warning'|'critical',
 *          title: string, body?: string|null, link?: string|null, patientId?: string|null, dedupeKey?: string|null}} n
 */
export async function notify(db, n) {
  await db('notifications')
    .insert({
      user_id: n.userId,
      facility_id: n.facilityId ?? null,
      type: n.type,
      template: n.type,
      severity: n.severity ?? 'info',
      title: n.title,
      body: n.body ?? null,
      link: n.link ?? null,
      patient_id: n.patientId ?? null,
      dedupe_key: n.dedupeKey ?? null,
    })
    .onConflict(['user_id', 'dedupe_key'])
    .ignore();
}

/**
 * Active users at a facility who hold a permission there (e.g. lab supervisors for lab.results.verify).
 * @param {import('knex').Knex | import('knex').Knex.Transaction} db @param {string} facilityId @param {string} permission
 */
export async function usersWith(db, facilityId, permission) {
  const rows = await db('user_roles as ur')
    .join('users as u', 'u.id', 'ur.user_id')
    .join('roles as r', 'r.id', 'ur.role_id')
    .join('role_permissions as rp', 'rp.role_id', 'r.id')
    .where({ 'rp.permission_code': permission, 'u.status': 'active' })
    .whereNull('u.deleted_at')
    .andWhere((w) => w.whereNull('ur.facility_id').orWhere('ur.facility_id', facilityId))
    .distinct('u.id');
  return rows.map((r) => r.id);
}

const toNote = (n) => ({
  id: n.id,
  type: n.type,
  severity: n.severity,
  title: n.title,
  body: n.body,
  link: n.link,
  createdAt: n.created_at,
  readAt: n.read_at,
});

/** My notifications, unread first. @param {{db: import('knex').Knex}} deps @param {any} auth */
export async function myNotifications({ db }, auth) {
  const rows = await db('notifications')
    .where({ user_id: auth.userId, channel: 'in_app' })
    .andWhere((w) => w.whereNull('facility_id').orWhere('facility_id', auth.facilityId))
    .orderByRaw('read_at IS NOT NULL, created_at DESC')
    .limit(50);
  const unread = await db('notifications')
    .where({ user_id: auth.userId, channel: 'in_app' })
    .whereNull('read_at')
    .andWhere((w) => w.whereNull('facility_id').orWhere('facility_id', auth.facilityId))
    .count({ n: '*' })
    .first();
  return { unread: Number(unread.n), data: rows.map(toNote) };
}

/** Mark one (or all) of my notifications read. Nobody can touch another user's. */
export async function markRead({ db }, auth, id) {
  const q = db('notifications').where({ user_id: auth.userId }).whereNull('read_at');
  if (id) {
    const n = await db('notifications').where({ id, user_id: auth.userId }).first('id');
    if (!n) throw notFound('Notification');
    q.andWhere({ id });
  }
  await q.update({ read_at: db.fn.now() });
  return myNotifications({ db }, auth);
}
