import pino from 'pino';

/**
 * Structured JSON logger. Credentials, cookies and anything that could carry
 * patient identifiers are redacted; request bodies are never logged and query
 * strings are stripped from logged URLs (search terms may be names or IDs).
 * @param {{level?: string}} [opts]
 */
export function createLogger(opts = {}) {
  return pino({
    level: opts.level ?? 'info',
    base: { service: 'afyazuri-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.password',
        '*.newPassword',
        '*.currentPassword',
        '*.phone',
        '*.nationalId',
        '*.national_id',
        '*.totp',
        '*.secret',
      ],
      censor: '[redacted]',
    },
  });
}

/** Strip the query string from a URL before logging it. */
export const safeUrl = (/** @type {string} */ url) => url.split('?')[0];
