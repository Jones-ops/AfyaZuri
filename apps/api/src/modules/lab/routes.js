import { Router } from 'express';
import {
  accessionBody,
  collectBody,
  idParams,
  labCatalogueQuery,
  labOrderBody,
  labTestBody,
  labTestUpdateBody,
  labWorklistQuery,
  reasonBody,
  resultAmendBody,
  resultEntryBody,
} from '@afyazuri/shared';
import { requestMeta as m, validate } from '../../lib/http.js';
import { requirePermission } from '../../middleware/auth.js';
import { idempotent } from '../../middleware/idempotency.js';
import * as results from './results.js';
import * as lab from './service.js';

/** @param {import('../../app.js').Deps} deps */
export function labRoutes(deps) {
  const r = Router();
  const id = validate({ params: idParams });
  const read = requirePermission('lab.read');
  const manage = requirePermission('lab.catalogue.manage');

  // Catalogue
  r.get(
    '/lab/tests',
    requirePermission(['lab.read', 'lab.catalogue.manage']),
    validate({ query: labCatalogueQuery }),
    async (req, res) => res.json({ data: await lab.listTests(deps, req.auth, req.valid.query) }),
  );
  r.get('/lab/orderable-tests', requirePermission(['orders.lab.create', 'lab.read']), async (req, res) =>
    res.json({ data: await lab.orderableTests(deps, req.auth) }),
  );
  r.post('/lab/tests', manage, validate({ body: labTestBody }), async (req, res) =>
    res.status(201).json(await lab.createTest(deps, req.auth, req.valid.body, m(req))),
  );
  r.patch('/lab/tests/:id', manage, validate({ params: idParams, body: labTestUpdateBody }), async (req, res) =>
    res.json(await lab.updateTest(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );

  // Ordering (from a visit)
  r.get('/encounters/:id/lab-orders', requirePermission('emr.read'), id, async (req, res) =>
    res.json({ data: await lab.encounterLabOrders(deps, req.auth, req.valid.params.id) }),
  );
  r.post(
    '/encounters/:id/lab-orders',
    requirePermission('orders.lab.create'),
    idempotent(deps.db, { required: true }),
    validate({ params: idParams, body: labOrderBody }),
    async (req, res) =>
      res.status(201).json(await lab.createLabOrder(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );
  r.post(
    '/lab-order-items/:id/cancel',
    requirePermission(['orders.lab.create', 'lab.results.verify']),
    validate({ params: idParams, body: reasonBody }),
    async (req, res) =>
      res.json(await lab.cancelLabItem(deps, req.auth, req.valid.params.id, req.valid.body.reason, m(req))),
  );

  // Lab work
  r.get('/lab/worklist', read, validate({ query: labWorklistQuery }), async (req, res) =>
    res.json({ data: await lab.labWorklist(deps, req.auth, req.valid.query) }),
  );
  r.get('/lab-orders/:id', requirePermission(['lab.read', 'emr.read']), id, async (req, res) =>
    res.json(await lab.getLabOrder(deps, req.auth, req.valid.params.id)),
  );
  r.post(
    '/lab-orders/:id/collect',
    requirePermission('lab.samples.collect'),
    validate({ params: idParams, body: collectBody }),
    async (req, res) =>
      res.json({ data: await lab.collectSamples(deps, req.auth, req.valid.params.id, req.valid.body, m(req)) }),
  );
  r.get('/lab-samples/:id/label', requirePermission(['lab.samples.collect', 'lab.read']), id, async (req, res) =>
    res.json(await lab.sampleLabel(deps, req.auth, req.valid.params.id)),
  );
  r.post(
    '/lab-samples/receive',
    requirePermission('lab.samples.receive'),
    validate({ body: accessionBody }),
    async (req, res) => res.json(await lab.receiveSample(deps, req.auth, req.valid.body.accession, m(req))),
  );
  r.post(
    '/lab-samples/:id/reject',
    requirePermission('lab.samples.receive'),
    validate({ params: idParams, body: reasonBody }),
    async (req, res) =>
      res.json(await lab.rejectSample(deps, req.auth, req.valid.params.id, req.valid.body.reason, m(req))),
  );
  // Results
  const seeResults = requirePermission(['lab.read', 'emr.read']);
  r.get('/lab-order-items/:id/results', seeResults, id, async (req, res) =>
    res.json(await results.itemResults(deps, req.auth, req.valid.params.id)),
  );
  r.post(
    '/lab-order-items/:id/results',
    requirePermission('lab.results.enter'),
    validate({ params: idParams, body: resultEntryBody }),
    async (req, res) =>
      res.json(await results.enterResults(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );
  r.post('/lab-order-items/:id/verify', requirePermission('lab.results.verify'), id, async (req, res) =>
    res.json(await results.verifyResults(deps, req.auth, req.valid.params.id, m(req))),
  );
  r.post(
    '/lab-order-items/:id/amend',
    requirePermission('lab.results.verify'),
    validate({ params: idParams, body: resultAmendBody }),
    async (req, res) =>
      res.json(await results.amendResults(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );
  r.get('/lab-orders/:id/report', seeResults, id, async (req, res) =>
    res.json(await results.labReport(deps, req.auth, req.valid.params.id)),
  );
  r.get('/patients/:id/lab-results', requirePermission('emr.read'), id, async (req, res) =>
    res.json({ data: await results.patientLabResults(deps, req.auth, req.valid.params.id) }),
  );
  return r;
}
