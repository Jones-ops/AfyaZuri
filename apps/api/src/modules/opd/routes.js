import { Router } from 'express';
import { z } from 'zod';
import {
  checkInBody,
  closeEncounterBody,
  completeTicketBody,
  encountersQuery,
  idParams,
  opdRouteBody,
} from '@afyazuri/shared';
import { requestMeta, validate } from '../../lib/http.js';
import { requirePermission } from '../../middleware/auth.js';
import { idempotent } from '../../middleware/idempotency.js';
import * as svc from './service.js';

const actionParams = z.object({ id: z.string().uuid(), action: z.enum(['call', 'start', 'no-show', 'requeue']) });

/** @param {import('../../app.js').Deps} deps */
export function opdRoutes(deps) {
  const r = Router();
  const m = requestMeta;
  const id = validate({ params: idParams });

  // Visits
  r.post(
    '/encounters',
    requirePermission('opd.checkin'),
    idempotent(deps.db),
    validate({ body: checkInBody }),
    async (req, res) => res.status(201).json(await svc.checkIn(deps, req.auth, req.valid.body, m(req))),
  );
  r.get(
    '/encounters',
    requirePermission(['opd.queue.read', 'patients.read']),
    validate({ query: encountersQuery }),
    async (req, res) => res.json({ data: await svc.listEncounters(deps, req.auth, req.valid.query) }),
  );
  r.get('/encounters/:id', requirePermission(['opd.queue.read', 'patients.read']), id, async (req, res) =>
    res.json(await svc.getEncounter(deps, req.auth, req.valid.params.id)),
  );
  r.post(
    '/encounters/:id/close',
    requirePermission(['opd.checkin', 'opd.queue.manage']),
    validate({ params: idParams, body: closeEncounterBody }),
    async (req, res) =>
      res.json(await svc.closeEncounter(deps, req.auth, req.valid.params.id, req.valid.body.reason ?? null, m(req))),
  );

  // Queues
  r.get('/queues', requirePermission('opd.queue.read'), async (req, res) =>
    res.json({ data: await svc.listQueues(deps, req.auth) }),
  );
  r.get('/queues/:id/board', requirePermission('opd.queue.read'), id, async (req, res) =>
    res.json(await svc.queueBoard(deps, req.auth, req.valid.params.id)),
  );
  r.get('/queues/:id/display', requirePermission('opd.queue.read'), id, async (req, res) =>
    res.json(await svc.queueDisplay(deps, req.auth, req.valid.params.id)),
  );
  r.post('/queues/:id/call-next', requirePermission('opd.queue.manage'), id, async (req, res) =>
    res.json(await svc.callNext(deps, req.auth, req.valid.params.id, m(req))),
  );
  r.post(
    '/queue-tickets/:id/complete',
    requirePermission('opd.queue.manage'),
    validate({ params: idParams, body: completeTicketBody }),
    async (req, res) => res.json(await svc.completeTicket(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );
  r.post(
    '/queue-tickets/:id/:action',
    requirePermission('opd.queue.manage'),
    validate({ params: actionParams }),
    async (req, res) =>
      res.json(
        await svc.ticketAction(deps, req.auth, req.valid.params.id, req.valid.params.action.replace('-', '_'), m(req)),
      ),
  );

  // Routing configuration
  r.get('/opd-routes', requirePermission(['facilities.read', 'opd.queue.read']), async (req, res) =>
    res.json({ data: await svc.listRoutes(deps, req.auth) }),
  );
  r.put('/opd-routes', requirePermission('facilities.manage'), validate({ body: opdRouteBody }), async (req, res) =>
    res.json({ data: await svc.setRoute(deps, req.auth, req.valid.body, m(req)) }),
  );

  return r;
}
