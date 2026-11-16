import { AppError } from '../lib/errors.js';
import { sha256 } from '../lib/crypto.js';

/**
 * Idempotency-Key support for unsafe requests (payments, dispensing, claim
 * submission and offline-synced writes). The first request with a key is
 * executed and its response stored; repeats with the same key and body get
 * the stored response; the same key with a different body is rejected.
 * Must run after authentication.
 * @param {import('knex').Knex} db
 * @param {{required?: boolean}} [opts]
 * @returns {import('express').RequestHandler}
 */
export function idempotent(db, opts = {}) {
  return async (req, res, next) => {
    const key = req.get('idempotency-key');
    if (!key) {
      if (opts.required) throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
      return next();
    }
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(key))
      throw new AppError(400, 'BAD_IDEMPOTENCY_KEY', 'Idempotency-Key must be 8–100 URL-safe characters');

    const userId = req.auth.userId;
    const requestHash = sha256(`${req.method} ${req.originalUrl.split('?')[0]} ${JSON.stringify(req.body ?? {})}`);
    const inserted = await db('idempotency_keys')
      .insert({
        key,
        user_id: userId,
        method: req.method,
        path: req.originalUrl.split('?')[0],
        request_hash: requestHash,
      })
      .onConflict(['user_id', 'key'])
      .ignore()
      .returning('key');

    if (inserted.length === 0) {
      const prior = await db('idempotency_keys').where({ user_id: userId, key }).first();
      if (prior.request_hash !== requestHash)
        throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was used for a different request');
      if (prior.response_status === null)
        throw new AppError(409, 'REQUEST_IN_PROGRESS', 'The original request is still being processed');
      res.set('Idempotent-Replay', 'true');
      return res.status(prior.response_status).json(prior.response_body);
    }

    const json = res.json.bind(res);
    res.json = (body) => {
      const done =
        res.statusCode < 500
          ? db('idempotency_keys')
              .where({ user_id: userId, key })
              .update({ response_status: res.statusCode, response_body: JSON.stringify(body) })
          : db('idempotency_keys').where({ user_id: userId, key }).delete(); // let the client retry
      done.then(
        () => json(body),
        (err) => {
          req.log?.error({ err }, 'idempotency store failed');
          json(body);
        },
      );
      return res;
    };
    next();
  };
}
