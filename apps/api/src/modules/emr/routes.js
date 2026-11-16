import { Router } from 'express';
import { z } from 'zod';
import {
  NOTE_TEMPLATES,
  addendumBody,
  allergyBody,
  diagnosisBody,
  enteredInErrorBody,
  icdSearchQuery,
  idParams,
  noteBody,
  noteUpdateBody,
  problemBody,
  problemUpdateBody,
  timelineQuery,
  vitalsBody,
} from '@afyazuri/shared';
import { requestMeta, validate } from '../../lib/http.js';
import { requirePermission } from '../../middleware/auth.js';
import * as svc from './service.js';

const errorParams = z.object({
  kind: z.enum(/** @type {[string, ...string[]]} */ (svc.ERRORABLE_KINDS)),
  id: z.string().uuid(),
});
const allergyStatusBody = z.object({ status: z.enum(['active', 'inactive']) });

/** @param {import('../../app.js').Deps} deps */
export function emrRoutes(deps) {
  const r = Router();
  const m = requestMeta;
  const id = validate({ params: idParams });
  const withBody = (body) => validate({ params: idParams, body });

  r.get('/note-templates', requirePermission('emr.read'), (_req, res) => res.json({ data: NOTE_TEMPLATES }));
  r.get('/icd', requirePermission(['emr.read', 'claims.read']), validate({ query: icdSearchQuery }), async (req, res) =>
    res.json({ data: await svc.searchIcd(deps, req.valid.query) }),
  );

  // Per visit
  r.get('/encounters/:id/clinical', requirePermission('emr.read'), id, async (req, res) =>
    res.json(await svc.encounterClinical(deps, req.auth, req.valid.params.id, m(req))),
  );
  r.post('/encounters/:id/vitals', requirePermission('emr.vitals.write'), withBody(vitalsBody), async (req, res) =>
    res.status(201).json(await svc.recordVitals(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );
  r.post('/encounters/:id/notes', requirePermission('emr.notes.write'), withBody(noteBody), async (req, res) =>
    res.status(201).json(await svc.createNote(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );
  r.post(
    '/encounters/:id/diagnoses',
    requirePermission('emr.diagnoses.write'),
    withBody(diagnosisBody),
    async (req, res) =>
      res.status(201).json(await svc.addDiagnosis(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );

  // Notes
  r.patch('/notes/:id', requirePermission('emr.notes.write'), withBody(noteUpdateBody), async (req, res) =>
    res.json(await svc.updateDraft(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );
  r.post('/notes/:id/sign', requirePermission('emr.notes.sign'), id, async (req, res) =>
    res.json(await svc.signNote(deps, req.auth, req.valid.params.id, m(req))),
  );
  r.post('/notes/:id/addenda', requirePermission('emr.notes.write'), withBody(addendumBody), async (req, res) =>
    res.status(201).json(await svc.addAddendum(deps, req.auth, req.valid.params.id, req.valid.body.body, m(req))),
  );

  // Per patient
  r.get(
    '/patients/:id/timeline',
    requirePermission('emr.read'),
    validate({ params: idParams, query: timelineQuery }),
    async (req, res) => res.json(await svc.timeline(deps, req.auth, req.valid.params.id, req.valid.query, m(req))),
  );
  r.get('/patients/:id/clinical-summary', requirePermission('emr.read'), id, async (req, res) =>
    res.json(await svc.clinicalSummary(deps, req.auth, req.valid.params.id, m(req))),
  );
  r.post('/patients/:id/allergies', requirePermission('emr.allergies.write'), withBody(allergyBody), async (req, res) =>
    res.status(201).json(await svc.addAllergy(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );
  r.patch('/allergies/:id', requirePermission('emr.allergies.write'), withBody(allergyStatusBody), async (req, res) =>
    res.json(await svc.setAllergyStatus(deps, req.auth, req.valid.params.id, req.valid.body.status, m(req))),
  );
  r.post('/patients/:id/problems', requirePermission('emr.allergies.write'), withBody(problemBody), async (req, res) =>
    res.status(201).json(await svc.addProblem(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );
  r.patch('/problems/:id', requirePermission('emr.allergies.write'), withBody(problemUpdateBody), async (req, res) =>
    res.json(await svc.updateProblem(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );

  // Corrections
  r.post(
    '/clinical/:kind/:id/entered-in-error',
    requirePermission('emr.read'),
    validate({ params: errorParams, body: enteredInErrorBody }),
    async (req, res) =>
      res.json(
        await svc.markEnteredInError(
          deps,
          req.auth,
          req.valid.params.kind,
          req.valid.params.id,
          req.valid.body.reason,
          m(req),
        ),
      ),
  );

  return r;
}
