import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { closeShiftBody, idParams, mpesaStkBody, openShiftBody, paymentBody } from '@afyazuri/shared';
import { AppError } from '../../lib/errors.js';
import { requestMeta, validate } from '../../lib/http.js';
import { requirePermission } from '../../middleware/auth.js';
import { idempotent } from '../../middleware/idempotency.js';
import * as pay from './payments.js';

const matchBody = z.object({ billId: z.string().uuid() });

/** Staff-facing routes (behind authentication). @param {import('../../app.js').Deps} deps */
export function paymentRoutes(deps) {
  const r = Router();
  const m = requestMeta;
  const id = validate({ params: idParams });
  const receive = requirePermission('billing.payment.receive');

  r.get('/shifts/current', requirePermission('billing.shift.manage'), async (req, res) =>
    res.json({ shift: await pay.currentShift(deps, req.auth) }),
  );
  r.post('/shifts', requirePermission('billing.shift.manage'), validate({ body: openShiftBody }), async (req, res) =>
    res.status(201).json(await pay.openShift(deps, req.auth, req.valid.body, m(req))),
  );
  r.post(
    '/shifts/current/close',
    requirePermission('billing.shift.manage'),
    validate({ body: closeShiftBody }),
    async (req, res) => res.json(await pay.closeShift(deps, req.auth, req.valid.body, m(req))),
  );
  r.get('/shifts', requirePermission('billing.read'), async (req, res) =>
    res.json({ data: await pay.listShifts(deps, req.auth) }),
  );

  r.post(
    '/bills/:id/payments',
    receive,
    idempotent(deps.db, { required: true }),
    validate({ params: idParams, body: paymentBody }),
    async (req, res) =>
      res.status(201).json(await pay.receivePayment(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );
  r.post(
    '/bills/:id/mpesa',
    receive,
    idempotent(deps.db, { required: true }),
    validate({ params: idParams, body: mpesaStkBody }),
    async (req, res) =>
      res.status(201).json(await pay.initiateStk(deps, req.auth, req.valid.params.id, req.valid.body, m(req))),
  );
  r.get('/mpesa/:id', requirePermission('billing.read'), id, async (req, res) =>
    res.json(await pay.getMpesa(deps, req.auth, req.valid.params.id)),
  );
  r.post('/mpesa/:id/query', receive, id, async (req, res) =>
    res.json(await pay.queryStk(deps, req.auth, req.valid.params.id)),
  );
  r.get('/mpesa-unmatched', requirePermission('billing.read'), async (req, res) =>
    res.json({ data: await pay.listUnmatched(deps, req.auth) }),
  );
  r.post('/mpesa/:id/match', receive, validate({ params: idParams, body: matchBody }), async (req, res) =>
    res.json(await pay.matchC2b(deps, req.auth, req.valid.params.id, req.valid.body.billId, m(req))),
  );
  r.post('/mpesa/register-c2b', requirePermission('settings.manage'), async (_req, res) =>
    res.json(await deps.mpesa.registerC2bUrls()),
  );

  r.get('/receipts/:id', requirePermission('billing.read'), id, async (req, res) =>
    res.json(await pay.getReceipt(deps, req.auth, req.valid.params.id)),
  );
  r.post('/receipts/:id/reprint', requirePermission('billing.read'), id, async (req, res) =>
    res.json(await pay.getReceipt(deps, req.auth, req.valid.params.id, { reprint: true }, m(req))),
  );
  return r;
}

/**
 * Safaricom → Afyazuri callbacks. No session or CSRF header is possible, so the
 * secret token in the URL authenticates them; Daraja always gets a 200 so it
 * does not retry forever, and problems are logged.
 * @param {import('../../app.js').Deps} deps
 */
export function mpesaCallbackRoutes(deps) {
  const r = Router();
  const expected = Buffer.from(deps.config.MPESA_CALLBACK_TOKEN);
  const allowed = deps.config.MPESA_CALLBACK_ALLOWED_IPS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // Callbacks are small JSON documents; refuse anything else before parsing work.
  r.use((req, _res, next) => {
    if (Number(req.get('content-length') ?? 0) > 32 * 1024) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Too large');
    if (allowed.length && !allowed.includes((req.ip ?? '').replace(/^::ffff:/, '')))
      throw new AppError(404, 'NOT_FOUND', 'Not found');
    next();
  });
  r.use('/mpesa/:token', (req, _res, next) => {
    const got = Buffer.from(req.params.token ?? '');
    if (got.length !== expected.length || !timingSafeEqual(got, expected))
      throw new AppError(404, 'NOT_FOUND', 'Not found');
    next();
  });
  const handle = (fn) => async (req, res) => {
    try {
      await fn(req.body);
    } catch (err) {
      req.log?.error({ err }, 'M-Pesa callback could not be processed');
    }
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  };
  r.post(
    '/mpesa/:token/stk-callback',
    handle((b) => pay.handleStkCallback(deps, b)),
  );
  r.post(
    '/mpesa/:token/c2b-confirmation',
    handle((b) => pay.handleC2bConfirmation(deps, b)),
  );
  r.post('/mpesa/:token/c2b-validation', (_req, res) => res.json({ ResultCode: 0, ResultDesc: 'Accepted' }));
  return r;
}
