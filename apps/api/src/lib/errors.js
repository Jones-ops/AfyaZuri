import { ZodError } from 'zod';

/** An error that maps directly to an HTTP response of shape `{ error: { code, message, details } }`. */
export class AppError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {unknown} [details]
   */
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new AppError(400, 'BAD_REQUEST', msg, details);
export const unauthorized = (code = 'UNAUTHENTICATED', msg = 'Please sign in') => new AppError(401, code, msg);
export const forbidden = (msg = 'You do not have permission to do that', details) =>
  new AppError(403, 'FORBIDDEN', msg, details);
export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (msg, details) => new AppError(409, 'CONFLICT', msg, details);

/**
 * Convert a ZodError into the API's validation error.
 * @param {ZodError} err
 * @param {string} where body | query | params
 */
export const fromZod = (err, where) =>
  new AppError(400, 'VALIDATION_ERROR', `Invalid request ${where}`, {
    issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });

/**
 * Express error handler. Unknown errors are logged and returned as 500 without internals.
 * @returns {import('express').ErrorRequestHandler}
 */
export function errorHandler() {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    let e = err;
    if (err instanceof ZodError) e = fromZod(err, 'data');
    else if (err?.type === 'entity.parse.failed') e = badRequest('Malformed JSON body');
    else if (err?.type === 'entity.too.large') e = new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body too large');
    else if (err?.code === '23505') e = conflict('A record with these details already exists', { constraint: err.constraint });
    else if (err?.code === '23503') e = badRequest('A referenced record does not exist', { constraint: err.constraint });
    else if (err?.code === '23514') e = badRequest('A value is outside the allowed range', { constraint: err.constraint });
    else if (err?.code === '42501') e = new AppError(409, 'IMMUTABLE_RECORD', err.message);

    if (!(e instanceof AppError)) {
      req.log?.error({ err }, 'unhandled error');
      e = new AppError(500, 'INTERNAL', 'Something went wrong. The error has been logged.');
    }
    res.status(e.status).json({ error: { code: e.code, message: e.message, details: e.details ?? null } });
  };
}
