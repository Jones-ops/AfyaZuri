import { Router } from 'express';
import { decisionBody, idParams, payRefundBody, refundBody, waiverBody } from '@afyazuri/shared';
import { requestMeta as m, validate } from '../../lib/http.js';
import { requirePermission } from '../../middleware/auth.js';
import { idempotent } from '../../middleware/idempotency.js';
import { retryEtims } from '../notifications/etims.js';
import * as adj from './adjustments.js';

/**
 * Waivers, credit notes, refunds and the approvals inbox.
 * Requests and payouts need an Idempotency-Key (a retried click must not raise two requests or
 * pay twice); decisions are naturally idempotent (a second decision is refused).
 * @param {import('../../app.js').Deps} deps
 */
export function adjustmentRoutes(deps) {
  const r = Router();
  const id = validate({ params: idParams });
  const once = idempotent(deps.db, { required: true });

  r.get(
    '/approvals',
    requirePermission(['billing.waiver.approve', 'billing.refund.approve', 'billing.payment.receive']),
    async (req, res) => res.json(await adj.listApprovals(deps, req.auth)),
  );

  r.post(
    '/bills/:id/waivers',
    requirePermission('billing.waiver.request'),
    once,
    validate({ params: idParams, body: waiverBody }),
    async (req, res) =>
      res.status(201).json(await adj.requestWaiver(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );
  r.get('/waivers/:id', requirePermission('billing.read'), id, async (req, res) =>
    res.json(await adj.getWaiver(deps, req.auth, req.valid.params.id)),
  );
  r.post(
    '/waivers/:id/decision',
    requirePermission('billing.waiver.approve'),
    validate({ params: idParams, body: decisionBody }),
    async (req, res) => res.json(await adj.decideWaiver(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );

  r.post(
    '/bills/:id/refunds',
    requirePermission('billing.refund.request'),
    once,
    validate({ params: idParams, body: refundBody }),
    async (req, res) =>
      res.status(201).json(await adj.requestRefund(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );
  r.get('/refunds/:id', requirePermission('billing.read'), id, async (req, res) =>
    res.json(await adj.getRefund(deps, req.auth, req.valid.params.id)),
  );
  r.post(
    '/refunds/:id/decision',
    requirePermission('billing.refund.approve'),
    validate({ params: idParams, body: decisionBody }),
    async (req, res) => res.json(await adj.decideRefund(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );
  r.post(
    '/refunds/:id/pay',
    requirePermission('billing.payment.receive'),
    once,
    validate({ params: idParams, body: payRefundBody }),
    async (req, res) => res.json(await adj.payRefund(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );

  const etimsRetry = requirePermission(['billing.payment.receive', 'billing.invoice.create']);
  r.post('/receipts/:id/etims-retry', etimsRetry, id, async (req, res) =>
    res.json(await retryEtims(deps, req.auth, 'receipt', req.valid.params.id, m(req))),
  );
  r.post('/refunds/:id/etims-retry', etimsRetry, id, async (req, res) =>
    res.json(await retryEtims(deps, req.auth, 'credit_note', req.valid.params.id, m(req))),
  );
  return r;
}
