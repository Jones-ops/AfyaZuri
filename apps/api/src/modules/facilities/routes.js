import { Router } from 'express';
import { z } from 'zod';
import {
  bedBody,
  bedStatusBody,
  departmentBody,
  departmentUpdateBody,
  facilityBody,
  facilityUpdateBody,
  idParams,
  servicePointBody,
  servicePointUpdateBody,
  wardBody,
  wardUpdateBody,
} from '@afyazuri/shared';
import { requestMeta, validate } from '../../lib/http.js';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import * as svc from './service.js';

const settingParams = z.object({ key: z.string().regex(/^[a-z][a-z0-9_.]{2,80}$/) });
const settingBody = z.object({ value: z.unknown() }).refine((b) => b.value !== undefined, 'value is required');

/** @param {import('../../app.js').Deps} deps */
export function facilityRoutes(deps) {
  const r = Router();
  r.use(authenticate(deps));
  const read = requirePermission('facilities.read');
  const manage = requirePermission('facilities.manage');
  const m = requestMeta;

  r.get('/facilities', read, async (req, res) => res.json({ data: await svc.listFacilities(deps, req.auth) }));
  r.get('/facilities/current', read, async (req, res) => res.json(await svc.currentFacility(deps, req.auth)));
  r.post('/facilities', manage, validate({ body: facilityBody }), async (req, res) =>
    res.status(201).json(await svc.createFacility(deps, req.auth, req.valid.body, m(req))),
  );
  r.patch('/facilities/:id', manage, validate({ params: idParams, body: facilityUpdateBody }), async (req, res) =>
    res.json(await svc.updateFacility(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );

  r.get('/departments', read, async (req, res) => res.json({ data: await svc.listDepartments(deps, req.auth) }));
  r.post('/departments', manage, validate({ body: departmentBody }), async (req, res) =>
    res.status(201).json(await svc.createDepartment(deps, req.auth, req.valid.body, m(req))),
  );
  r.patch('/departments/:id', manage, validate({ params: idParams, body: departmentUpdateBody }), async (req, res) =>
    res.json(await svc.updateDepartment(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );

  r.get('/service-points', read, async (req, res) => res.json({ data: await svc.listServicePoints(deps, req.auth) }));
  r.post('/service-points', manage, validate({ body: servicePointBody }), async (req, res) =>
    res.status(201).json(await svc.createServicePoint(deps, req.auth, req.valid.body, m(req))),
  );
  r.patch(
    '/service-points/:id',
    manage,
    validate({ params: idParams, body: servicePointUpdateBody }),
    async (req, res) =>
      res.json(await svc.updateServicePoint(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );

  r.get('/wards', requirePermission(['facilities.read', 'ipd.read']), async (req, res) =>
    res.json({ data: await svc.listWards(deps, req.auth) }),
  );
  r.post('/wards', manage, validate({ body: wardBody }), async (req, res) =>
    res.status(201).json(await svc.createWard(deps, req.auth, req.valid.body, m(req))),
  );
  r.patch('/wards/:id', manage, validate({ params: idParams, body: wardUpdateBody }), async (req, res) =>
    res.json(await svc.updateWard(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );

  r.get(
    '/wards/:id/beds',
    requirePermission(['facilities.read', 'ipd.read']),
    validate({ params: idParams }),
    async (req, res) => res.json({ data: await svc.listBeds(deps, req.auth, req.valid.params.id) }),
  );
  r.post('/wards/:id/beds', manage, validate({ params: idParams, body: bedBody }), async (req, res) =>
    res.status(201).json(await svc.createBed(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );
  r.patch(
    '/beds/:id/status',
    requirePermission(['facilities.manage', 'ipd.beds.manage']),
    validate({ params: idParams, body: bedStatusBody }),
    async (req, res) =>
      res.json(await svc.setBedStatus(deps, req.auth, req.valid.params.id, req.valid.body.status, m(req))),
  );

  r.get('/settings', requirePermission(['settings.manage', 'facilities.read']), async (req, res) =>
    res.json(await svc.getSettings(deps, req.auth)),
  );
  r.put(
    '/settings/:key',
    requirePermission('settings.manage'),
    validate({ params: settingParams, body: settingBody }),
    async (req, res) =>
      res.json(await svc.putSetting(deps, req.auth, req.valid.params.key, req.valid.body.value, m(req))),
  );

  return r;
}
