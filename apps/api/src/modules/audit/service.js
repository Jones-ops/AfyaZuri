import { diff, redact } from '../../lib/diff.js';

/**
 * @typedef {Object} Actor
 * @property {string} userId
 * @property {string} username
 * @property {string[]} roles
 * @property {string|null} facilityId
 */

/**
 * @typedef {Object} AuditEntry
 * @property {string} action          one of AUDIT_ACTIONS
 * @property {string} entityType      e.g. 'user', 'facility', 'patient'
 * @property {string|null} [entityId]
 * @property {string|null} [patientId] set whenever the entry concerns a patient's record
 * @property {Record<string, any>|null} [before]
 * @property {Record<string, any>|null} [after]
 * @property {string|null} [reason]
 * @property {Record<string, any>|null} [metadata]
 * @property {string|null} [facilityId] overrides the actor's facility
 */

/**
 * Append an entry to the audit log. Call inside the same transaction as the
 * change it records so the two commit or roll back together.
 * @param {import('knex').Knex | import('knex').Knex.Transaction} db
 * @param {Actor|null} actor
 * @param {{ip?: string|null, userAgent?: string|null, requestId?: string|null}} meta
 * @param {AuditEntry} entry
 */
export async function recordAudit(db, actor, meta, entry) {
  const before = redact(entry.before);
  const after = redact(entry.after);
  await db('audit_log').insert({
    request_id: meta.requestId ?? null,
    actor_user_id: actor?.userId ?? null,
    actor_username: actor?.username ?? null,
    actor_roles: actor?.roles ?? null,
    facility_id: entry.facilityId !== undefined ? entry.facilityId : (actor?.facilityId ?? null),
    action: entry.action,
    entity_type: entry.entityType,
    entity_id: entry.entityId ?? null,
    patient_id: entry.patientId ?? null,
    before: before ? JSON.stringify(before) : null,
    after: after ? JSON.stringify(after) : null,
    changes: before && after ? JSON.stringify(diff(entry.before, entry.after)) : null,
    ip: meta.ip ?? null,
    user_agent: meta.userAgent ?? null,
    reason: entry.reason ?? null,
    metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
  });
}
