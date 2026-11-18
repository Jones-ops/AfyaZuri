import { Router } from 'express';
import { auditQuery, hasGlobalPermission } from '@afyazuri/shared';
import { decodeCursor, page, requestMeta, validate } from '../../lib/http.js';
import { actorOf, requirePermission } from '../../middleware/auth.js';
import { recordAudit } from './service.js';
import { csvCell } from '../../lib/csv.js';

/**
 * Filtered audit query. Facility-scoped admins see their facility's entries;
 * deployment-wide admins see every facility.
 * @param {import('knex').Knex} db
 * @param {import('../../middleware/auth.js').AuthContext} auth
 * @param {Record<string, any>} f
 */
function auditFilter(db, auth, f) {
  const q = db('audit_log');
  if (!hasGlobalPermission(auth.grants, 'audit.read')) q.where('facility_id', auth.facilityId);
  if (f.userId) q.andWhere('actor_user_id', f.userId);
  if (f.patientId) q.andWhere('patient_id', f.patientId);
  if (f.action) q.andWhere('action', f.action);
  if (f.entityType) q.andWhere('entity_type', f.entityType);
  if (f.from) q.andWhere('occurred_at', '>=', f.from);
  if (f.to) q.andWhere('occurred_at', '<=', f.to);
  return q;
}

const out = (r) => ({
  id: String(r.id),
  occurredAt: r.occurred_at,
  actorUserId: r.actor_user_id,
  actorUsername: r.actor_username,
  actorRoles: r.actor_roles,
  facilityId: r.facility_id,
  action: r.action,
  entityType: r.entity_type,
  entityId: r.entity_id,
  patientId: r.patient_id,
  changes: r.changes,
  before: r.before,
  after: r.after,
  ip: r.ip,
  userAgent: r.user_agent,
  reason: r.reason,
  metadata: r.metadata,
  requestId: r.request_id,
});

/** @param {import('../../app.js').Deps} deps */
export function auditRoutes(deps) {
  const { db } = deps;
  const r = Router();

  r.get('/audit', requirePermission('audit.read'), validate({ query: auditQuery }), async (req, res) => {
    const f = req.valid.query;
    const q = auditFilter(db, req.auth, f);
    const c = decodeCursor(f.cursor);
    if (c) q.andWhere('id', '<', c.id);
    const rows = await q.orderBy('id', 'desc').limit(f.limit + 1);
    const result = page(rows, f.limit, (x) => ({ id: Number(x.id) }));
    res.json({ data: result.data.map(out), nextCursor: result.nextCursor });
  });

  // Streams CSV for investigations; capped at 100k rows. The export itself is audited.
  r.get('/audit/export', requirePermission('audit.export'), validate({ query: auditQuery }), async (req, res) => {
    const f = req.valid.query;
    await recordAudit(db, actorOf(req), requestMeta(req), {
      action: 'export',
      entityType: 'audit_log',
      metadata: { filters: { ...f, cursor: undefined, limit: undefined } },
    });
    const cols = [
      'id',
      'occurred_at',
      'actor_username',
      'actor_user_id',
      'actor_roles',
      'facility_id',
      'action',
      'entity_type',
      'entity_id',
      'patient_id',
      'reason',
      'ip',
      'user_agent',
      'changes',
      'metadata',
      'request_id',
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.write(`${cols.join(',')}\n`);
    const stream = auditFilter(db, req.auth, f).orderBy('id', 'desc').limit(100_000).select(cols).stream();
    try {
      for await (const row of stream) {
        if (!res.write(`${cols.map((c) => csvCell(row[c])).join(',')}\n`))
          await new Promise((ok) => res.once('drain', ok));
      }
      res.end();
    } catch (err) {
      // Headers are already sent: abort the download so it can't be mistaken for a complete export.
      req.log?.error({ err }, 'audit export failed');
      res.destroy(err);
    }
  });

  return r;
}
