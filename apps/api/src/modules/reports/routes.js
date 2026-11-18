import { Router } from 'express';
import { debtorsQuery, hasPermission, revenueQuery } from '@afyazuri/shared';
import { toCsv } from '../../lib/csv.js';
import { forbidden } from '../../lib/errors.js';
import { requestMeta, validate } from '../../lib/http.js';
import { actorOf, requirePermission } from '../../middleware/auth.js';
import { recordAudit } from '../audit/service.js';
import { REVENUE_CSV, debtorAgeing, debtorsCsv, revenueReport } from './financial.js';

/**
 * Financial reports. Viewing needs reports.financial.read; a CSV download also needs
 * reports.export and is written to the audit log (the debtor list names patients).
 * @param {import('../../app.js').Deps} deps
 */
export function reportRoutes(deps) {
  const r = Router();
  const read = requirePermission('reports.financial.read');

  const sendCsv = async (req, res, { name, header, rows, entityType, metadata }) => {
    if (!hasPermission(req.auth.grants, 'reports.export', { facilityId: req.auth.facilityId }))
      throw forbidden('You do not have permission to export reports', { required: ['reports.export'] });
    await recordAudit(deps.db, actorOf(req), requestMeta(req), {
      action: 'export',
      entityType,
      metadata: { ...metadata, rows: rows.length },
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(toCsv(header, rows));
  };

  r.get('/reports/revenue', read, validate({ query: revenueQuery }), async (req, res) => {
    const q = req.valid.query;
    const report = await revenueReport(deps, req.auth, q);
    if (q.format !== 'csv') return res.json(report);
    const [header, rows] = REVENUE_CSV[q.table](report);
    return sendCsv(req, res, {
      name: `revenue-${q.table}-${q.from}-to-${q.to}.csv`,
      header,
      rows,
      entityType: 'revenue_report',
      metadata: { from: q.from, to: q.to, table: q.table },
    });
  });

  r.get('/reports/debtors', read, validate({ query: debtorsQuery }), async (req, res) => {
    const q = req.valid.query;
    const report = await debtorAgeing(deps, req.auth, q);
    if (q.format !== 'csv') return res.json(report);
    const [header, rows] = debtorsCsv(report);
    return sendCsv(req, res, {
      name: `debtors-${report.asOf}${q.bucket ? `-${q.bucket}` : ''}.csv`,
      header,
      rows,
      entityType: 'debtor_report',
      metadata: { asOf: report.asOf, bucket: q.bucket ?? null },
    });
  });

  return r;
}
