import express, { Router } from 'express';
import { z } from 'zod';
import {
  amendReportBody,
  idParams,
  imagingOrderBody,
  imagingWorklistQuery,
  performBody,
  reasonBody,
  reportBody,
  scheduleBody,
} from '@afyazuri/shared';
import { requestMeta as m, validate } from '../../lib/http.js';
import { requirePermission } from '../../middleware/auth.js';
import { idempotent } from '../../middleware/idempotency.js';
import * as img from './service.js';

const fileParams = z.object({ id: z.string().uuid(), fileId: z.string().uuid() });
const templateQuery = z.object({ modality: z.string().max(20).optional() });

/** @param {import('../../app.js').Deps} deps */
export function imagingRoutes(deps) {
  const r = Router();
  const id = validate({ params: idParams });
  const see = requirePermission(['imaging.read', 'emr.read']);

  r.get('/imaging/studies', requirePermission(['orders.imaging.create', 'imaging.read']), async (req, res) =>
    res.json({ data: await img.listStudies(deps, req.auth) }),
  );
  r.get(
    '/imaging/templates',
    requirePermission('imaging.report'),
    validate({ query: templateQuery }),
    async (req, res) => res.json({ data: await img.listTemplates(deps, req.auth, req.valid.query) }),
  );
  r.get(
    '/imaging/worklist',
    requirePermission('imaging.read'),
    validate({ query: imagingWorklistQuery }),
    async (req, res) => res.json({ data: await img.imagingWorklist(deps, req.auth, req.valid.query) }),
  );

  r.get('/encounters/:id/imaging-orders', requirePermission('emr.read'), id, async (req, res) =>
    res.json({ data: await img.encounterImaging(deps, req.auth, req.valid.params.id) }),
  );
  r.post(
    '/encounters/:id/imaging-orders',
    requirePermission('orders.imaging.create'),
    idempotent(deps.db, { required: true }),
    validate({ params: idParams, body: imagingOrderBody }),
    async (req, res) =>
      res.status(201).json(await img.createImagingOrder(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );
  r.get('/imaging-orders/:id', see, id, async (req, res) =>
    res.json(await img.getImagingOrder(deps, req.auth, req.valid.params.id)),
  );
  r.post(
    '/imaging-orders/:id/cancel',
    requirePermission(['orders.imaging.create', 'imaging.schedule']),
    validate({ params: idParams, body: reasonBody }),
    async (req, res) =>
      res.json(await img.cancelImaging(deps, req.auth, req.valid.params.id, req.valid.body.reason, m(req))),
  );
  r.post(
    '/imaging-orders/:id/schedule',
    requirePermission('imaging.schedule'),
    validate({ params: idParams, body: scheduleBody }),
    async (req, res) =>
      res.json(await img.scheduleImaging(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );
  r.post(
    '/imaging-orders/:id/perform',
    requirePermission('imaging.perform'),
    validate({ params: idParams, body: performBody }),
    async (req, res) => res.json(await img.performImaging(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );
  r.post(
    '/imaging-orders/:id/report',
    requirePermission('imaging.report'),
    validate({ params: idParams, body: reportBody }),
    async (req, res) => res.json(await img.writeReport(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );
  r.post('/imaging-orders/:id/release', requirePermission('imaging.report'), id, async (req, res) =>
    res.json(await img.releaseReport(deps, req.auth, req.valid.params.id, m(req))),
  );
  r.post(
    '/imaging-orders/:id/amend',
    requirePermission('imaging.report'),
    validate({ params: idParams, body: amendReportBody }),
    async (req, res) => res.json(await img.amendReport(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );

  // Attachments: the raw file is the request body; its type is decided from the bytes.
  r.post(
    '/imaging-orders/:id/attachments',
    requirePermission(['imaging.perform', 'imaging.report']),
    id,
    express.raw({ type: () => true, limit: `${deps.config.ATTACHMENT_MAX_MB}mb` }),
    async (req, res) => {
      let name = 'attachment';
      try {
        name = decodeURIComponent(String(req.get('x-file-name') ?? 'attachment'));
      } catch {
        /* keep the default name */
      }
      res
        .status(201)
        .json(await img.attachFile(deps, req.auth, req.valid.params.id, { name, buffer: req.body }, m(req)));
    },
  );
  r.get('/imaging-orders/:id/attachments/:fileId', see, validate({ params: fileParams }), async (req, res) => {
    const { row, buffer } = await img.downloadFile(
      deps,
      req.auth,
      req.valid.params.id,
      req.valid.params.fileId,
      m(req),
    );
    res.setHeader('Content-Type', row.mime_type);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(row.file_name)}`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(buffer);
  });
  return r;
}
