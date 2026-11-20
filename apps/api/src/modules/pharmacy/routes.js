import { Router } from 'express';
import { z } from 'zod';
import {
  cancelRxBody,
  dispenseBody,
  doseRuleBody,
  idParams,
  prescriptionBody,
  prescriptionCheckBody,
  worklistQuery,
} from '@afyazuri/shared';
import { requestMeta as m, validate } from '../../lib/http.js';
import { requirePermission } from '../../middleware/auth.js';
import { idempotent } from '../../middleware/idempotency.js';
import * as rx from './service.js';

const storeQuery = z.object({ storeId: z.string().uuid().optional() });
const formularyQuery = z.object({ q: z.string().trim().min(2).max(60) });

/** @param {import('../../app.js').Deps} deps */
export function pharmacyRoutes(deps) {
  const r = Router();
  const prescribe = requirePermission('orders.prescription.create');
  const seeRx = requirePermission(['pharmacy.read', 'emr.read']);
  const id = validate({ params: idParams });

  // Prescribing (in a visit)
  r.get(
    '/formulary',
    requirePermission(['orders.prescription.create', 'pharmacy.read']),
    validate({ query: formularyQuery }),
    async (req, res) => res.json({ data: await rx.formulary(deps, req.auth, req.valid.query) }),
  );
  r.get('/encounters/:id/prescriptions', requirePermission('emr.read'), id, async (req, res) =>
    res.json({ data: await rx.encounterPrescriptions(deps, req.auth, req.valid.params.id) }),
  );
  r.post(
    '/encounters/:id/prescriptions/check',
    prescribe,
    validate({ params: idParams, body: prescriptionCheckBody }),
    async (req, res) => res.json(await rx.checkPrescription(deps, req.auth, req.valid.params.id, req.valid.body)),
  );
  r.post(
    '/encounters/:id/prescriptions',
    prescribe,
    idempotent(deps.db, { required: true }),
    validate({ params: idParams, body: prescriptionBody }),
    async (req, res) =>
      res.status(201).json(await rx.createPrescription(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );
  r.post('/prescriptions/:id/cancel', prescribe, validate({ params: idParams, body: cancelRxBody }), async (req, res) =>
    res.json(await rx.cancelPrescription(deps, req.auth, req.valid.params.id, req.valid.body.reason, m(req))),
  );

  // Pharmacy
  r.get(
    '/pharmacy/worklist',
    requirePermission('pharmacy.read'),
    validate({ query: worklistQuery }),
    async (req, res) => res.json({ data: await rx.worklist(deps, req.auth, req.valid.query) }),
  );
  r.get('/prescriptions/:id', seeRx, validate({ params: idParams, query: storeQuery }), async (req, res) =>
    res.json(await rx.getPrescription(deps, req.auth, req.valid.params.id, req.valid.query)),
  );
  r.post(
    '/prescriptions/:id/dispense',
    requirePermission('pharmacy.dispense'),
    idempotent(deps.db, { required: true }),
    validate({ params: idParams, body: dispenseBody }),
    async (req, res) => res.json(await rx.dispense(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );

  // Dose rules
  r.get('/pharmacy/dose-rules', seeRx, async (req, res) => res.json({ data: await rx.listDoseRules(deps, req.auth) }));
  r.post(
    '/pharmacy/dose-rules',
    requirePermission('pharmacy.rules.manage'),
    validate({ body: doseRuleBody }),
    async (req, res) => res.status(201).json(await rx.createDoseRule(deps, req.auth, req.valid.body, m(req))),
  );
  for (const [path, active] of [
    ['activate', true],
    ['deactivate', false],
  ])
    r.post(`/pharmacy/dose-rules/:id/${path}`, requirePermission('pharmacy.rules.manage'), id, async (req, res) =>
      res.json(await rx.setDoseRuleActive(deps, req.auth, req.valid.params.id, active, m(req))),
    );
  return r;
}
