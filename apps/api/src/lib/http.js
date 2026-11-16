import { badRequest, fromZod } from './errors.js';

/**
 * Validate request parts with Zod schemas. Parsed values replace the raw ones
 * on `req.valid` (Express 5 makes req.query read-only).
 * @param {{body?: import('zod').ZodTypeAny, query?: import('zod').ZodTypeAny, params?: import('zod').ZodTypeAny}} schemas
 * @returns {import('express').RequestHandler}
 */
export function validate(schemas) {
  return (req, _res, next) => {
    req.valid = req.valid ?? {};
    for (const part of /** @type {const} */ (['params', 'query', 'body'])) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part] ?? {});
      if (!result.success) return next(fromZod(result.error, part));
      req.valid[part] = result.data;
    }
    next();
  };
}

/**
 * Opaque cursor helpers for keyset pagination.
 * @param {Record<string, unknown>} value
 */
export const encodeCursor = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** @param {string|undefined} cursor */
export function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof v !== 'object' || v === null) throw new Error('bad');
    return v;
  } catch {
    throw badRequest('Invalid cursor');
  }
}

/**
 * Build a page response from limit+1 fetched rows.
 * @template T
 * @param {T[]} rows rows fetched with limit + 1
 * @param {number} limit
 * @param {(last: T) => Record<string, unknown>} cursorOf
 */
export function page(rows, limit, cursorOf) {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  return { data, nextCursor: hasMore ? encodeCursor(cursorOf(data[data.length - 1])) : null };
}

/**
 * Request metadata used by the audit log.
 * @param {import('express').Request} req
 */
export const requestMeta = (req) => ({
  ip: req.ip ?? null,
  userAgent: req.get('user-agent')?.slice(0, 300) ?? null,
  requestId: req.id ?? null,
});
