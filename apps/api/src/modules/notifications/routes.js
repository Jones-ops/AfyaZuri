import { Router } from 'express';
import { idParams } from '@afyazuri/shared';
import { validate } from '../../lib/http.js';
import { markRead, myNotifications } from './inbox.js';

/** Each user's own inbox; no permission beyond being signed in, and nobody sees anyone else's. */
export function notificationRoutes(deps) {
  const r = Router();
  r.get('/notifications', async (req, res) => res.json(await myNotifications(deps, req.auth)));
  r.post('/notifications/read-all', async (req, res) => res.json(await markRead(deps, req.auth, null)));
  r.post('/notifications/:id/read', validate({ params: idParams }), async (req, res) =>
    res.json(await markRead(deps, req.auth, req.valid.params.id)),
  );
  return r;
}
