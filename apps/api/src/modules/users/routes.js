import { Router } from 'express';
import { z } from 'zod';
import {
  PERMISSION_GROUPS,
  createUserBody,
  idParams,
  listUsersQuery,
  resetPasswordBody,
  setRolesBody,
  updateUserBody,
} from '@afyazuri/shared';
import { requestMeta, validate } from '../../lib/http.js';
import { requirePermission } from '../../middleware/auth.js';
import { idempotent } from '../../middleware/idempotency.js';
import * as svc from './service.js';

const statusBody = z.object({ reason: z.string().trim().min(3).max(300) });

/** @param {import('../../app.js').Deps} deps */
export function userRoutes(deps) {
  const r = Router();
  const id = validate({ params: idParams });

  r.get('/roles', requirePermission('roles.read'), async (_req, res) =>
    res.json({ data: await svc.listRoles(deps), permissionGroups: PERMISSION_GROUPS }),
  );

  r.get('/users', requirePermission('users.read'), validate({ query: listUsersQuery }), async (req, res) =>
    res.json(await svc.listUsers(deps, req.auth, req.valid.query)),
  );

  r.post(
    '/users',
    requirePermission('users.manage'),
    idempotent(deps.db),
    validate({ body: createUserBody }),
    async (req, res) => res.status(201).json(await svc.createUser(deps, req.auth, req.valid.body, requestMeta(req))),
  );

  r.get('/users/:id', requirePermission('users.read'), id, async (req, res) =>
    res.json(await svc.getUser(deps, req.auth, req.valid.params.id)),
  );

  r.patch(
    '/users/:id',
    requirePermission('users.manage'),
    validate({ params: idParams, body: updateUserBody }),
    async (req, res) =>
      res.json(await svc.updateUser(deps, req.auth, req.valid.params.id, req.valid.body, requestMeta(req))),
  );

  r.put(
    '/users/:id/roles',
    requirePermission('users.manage'),
    validate({ params: idParams, body: setRolesBody }),
    async (req, res) =>
      res.json(await svc.setRoles(deps, req.auth, req.valid.params.id, req.valid.body.roles, requestMeta(req))),
  );

  r.post(
    '/users/:id/disable',
    requirePermission('users.disable'),
    validate({ params: idParams, body: statusBody }),
    async (req, res) =>
      res.json(
        await svc.setStatus(
          deps,
          req.auth,
          req.valid.params.id,
          { disabled: true, reason: req.valid.body.reason },
          requestMeta(req),
        ),
      ),
  );

  r.post('/users/:id/enable', requirePermission('users.disable'), id, async (req, res) =>
    res.json(await svc.setStatus(deps, req.auth, req.valid.params.id, { disabled: false }, requestMeta(req))),
  );

  r.post('/users/:id/force-logout', requirePermission('users.disable'), id, async (req, res) =>
    res.json({ sessionsEnded: await svc.forceLogout(deps, req.auth, req.valid.params.id, requestMeta(req)) }),
  );

  r.post(
    '/users/:id/reset-password',
    requirePermission('users.manage'),
    validate({ params: idParams, body: resetPasswordBody }),
    async (req, res) => {
      await svc.resetPassword(deps, req.auth, req.valid.params.id, req.valid.body.password, requestMeta(req));
      res.json({ ok: true });
    },
  );

  r.post('/users/:id/unlock', requirePermission('users.manage'), id, async (req, res) =>
    res.json(await svc.unlock(deps, req.auth, req.valid.params.id, requestMeta(req))),
  );

  return r;
}
