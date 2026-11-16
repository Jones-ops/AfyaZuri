import { Router } from 'express';
import { z } from 'zod';
import {
  breakGlassBody,
  breakGlassReviewBody,
  consentInput,
  duplicateCheckBody,
  idParams,
  mergePatientsBody,
  patientSearchQuery,
  payerSchemeInput,
  registerPatientBody,
  restrictBody,
  unmergeBody,
  updatePatientBody,
} from '@afyazuri/shared';
import { requestMeta, validate } from '../../lib/http.js';
import { requirePermission } from '../../middleware/auth.js';
import { idempotent } from '../../middleware/idempotency.js';
import * as svc from './service.js';

const linkParams = z.object({ id: z.string().uuid(), linkId: z.string().uuid() });
const breakGlassQuery = z.object({ status: z.enum(['unreviewed', 'all']).default('unreviewed') });

/** @param {import('../../app.js').Deps} deps */
export function patientRoutes(deps) {
  const { db } = deps;
  const r = Router();
  const m = requestMeta;
  const id = validate({ params: idParams });

  // Reference data for the registration form.
  r.get('/schemes', requirePermission('patients.read'), async (_req, res) =>
    res.json({ data: await svc.listSchemes(deps) }),
  );
  r.get('/admin-units/counties', requirePermission('patients.read'), async (_req, res) =>
    res.json({ data: await db('counties').orderBy('name').select('code', 'name') }),
  );
  r.get(
    '/admin-units/counties/:code/sub-counties',
    requirePermission('patients.read'),
    validate({ params: z.object({ code: z.string().regex(/^\d{3}$/) }) }),
    async (req, res) =>
      res.json({
        data: await db('sub_counties')
          .where({ county_code: req.valid.params.code })
          .orderBy('name')
          .select('id', 'name'),
      }),
  );
  r.get(
    '/admin-units/sub-counties/:id/wards',
    requirePermission('patients.read'),
    validate({ params: z.object({ id: z.coerce.number().int().positive() }) }),
    async (req, res) =>
      res.json({
        data: await db('admin_wards')
          .where({ sub_county_id: req.valid.params.id })
          .orderBy('name')
          .select('id', 'name'),
      }),
  );

  // Registration and search.
  r.post(
    '/patients/duplicates',
    requirePermission('patients.create'),
    validate({ body: duplicateCheckBody }),
    async (req, res) => res.json({ data: await svc.findDuplicates(deps, req.auth, req.valid.body) }),
  );
  r.post(
    '/patients',
    requirePermission('patients.create'),
    idempotent(db),
    validate({ body: registerPatientBody }),
    async (req, res) => res.status(201).json(await svc.registerPatient(deps, req.auth, req.valid.body, m(req))),
  );
  r.get('/patients', requirePermission('patients.read'), validate({ query: patientSearchQuery }), async (req, res) =>
    res.json(await svc.searchPatients(deps, req.auth, req.valid.query)),
  );

  // Merge (before /patients/:id so "merge" is not read as an id).
  r.post(
    '/patients/merge',
    requirePermission('patients.merge'),
    validate({ body: mergePatientsBody }),
    async (req, res) => res.json(await svc.mergePatients(deps, req.auth, req.valid.body, m(req))),
  );
  r.post(
    '/patient-merges/:id/unmerge',
    requirePermission('patients.merge'),
    validate({ params: idParams, body: unmergeBody }),
    async (req, res) =>
      res.json(await svc.unmergePatients(deps, req.auth, req.valid.params.id, req.valid.body.reason, m(req))),
  );

  // One patient.
  r.get('/patients/:id', requirePermission('patients.read'), id, async (req, res) =>
    res.json(await svc.getPatient(deps, req.auth, req.valid.params.id, m(req))),
  );
  r.patch(
    '/patients/:id',
    requirePermission('patients.update'),
    validate({ params: idParams, body: updatePatientBody }),
    async (req, res) => res.json(await svc.updatePatient(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );
  r.post(
    '/patients/:id/restrict',
    requirePermission('patients.restrict'),
    validate({ params: idParams, body: restrictBody }),
    async (req, res) => res.json(await svc.setRestricted(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );
  r.post(
    '/patients/:id/consents',
    requirePermission('patients.consent.manage'),
    validate({ params: idParams, body: consentInput }),
    async (req, res) => res.json(await svc.recordConsent(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );
  r.post(
    '/patients/:id/payer-schemes',
    requirePermission('patients.update'),
    validate({ params: idParams, body: payerSchemeInput }),
    async (req, res) => res.json(await svc.addPayerScheme(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );
  r.delete(
    '/patients/:id/payer-schemes/:linkId',
    requirePermission('patients.update'),
    validate({ params: linkParams }),
    async (req, res) =>
      res.json(await svc.removePayerScheme(deps, req.auth, req.valid.params.id, req.valid.params.linkId, m(req))),
  );
  r.get('/patients/:id/merges', requirePermission('patients.merge'), id, async (req, res) =>
    res.json({ data: await svc.listMerges(deps, req.auth, req.valid.params.id) }),
  );

  // Break the glass.
  r.post(
    '/patients/:id/break-glass',
    requirePermission('emr.break_glass'),
    validate({ params: idParams, body: breakGlassBody }),
    async (req, res) =>
      res.status(201).json(await svc.breakGlass(deps, req.auth, req.valid.params.id, req.valid.body.reason, m(req))),
  );
  r.get('/break-glass', requirePermission('audit.read'), validate({ query: breakGlassQuery }), async (req, res) =>
    res.json({ data: await svc.listBreakGlass(deps, req.auth, req.valid.query) }),
  );
  r.post(
    '/break-glass/:id/review',
    requirePermission('audit.read'),
    validate({ params: idParams, body: breakGlassReviewBody }),
    async (req, res) =>
      res.json(await svc.reviewBreakGlass(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );

  return r;
}
