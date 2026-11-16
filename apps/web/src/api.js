const BASE = '/api/v1';

/** Error carrying the API's `{ error: { code, message, details } }` payload. */
export class ApiError extends Error {
  /** @param {number} status @param {{code?: string, message?: string, details?: any}} [error] */
  constructor(status, error = {}) {
    super(error.message ?? `Request failed (${status})`);
    this.status = status;
    this.code = error.code ?? 'UNKNOWN';
    this.details = error.details ?? null;
  }
}

/** @type {Set<(code: string) => void>} */
const sessionListeners = new Set();
/** Subscribe to "session ended" events (401s that a refresh can't fix). */
export const onSessionEnded = (fn) => {
  sessionListeners.add(fn);
  return () => sessionListeners.delete(fn);
};

let refreshing = null;
function refreshSession() {
  refreshing ??= fetch(`${BASE}/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'X-Afyazuri-Client': '1' },
  }).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @param {{headers?: Record<string, string>, retried?: boolean}} [opts]
 */
async function request(method, path, body, opts = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      credentials: 'include',
      headers: {
        'X-Afyazuri-Client': '1',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...opts.headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, { code: 'NETWORK', message: 'Cannot reach the server. Check your connection.' });
  }

  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.ok) return data;

  const err = new ApiError(res.status, data?.error);
  if (res.status === 401 && !path.startsWith('/auth/login')) {
    if (err.code === 'TOKEN_EXPIRED' && !opts.retried) {
      const r = await refreshSession();
      if (r.ok) return request(method, path, body, { ...opts, retried: true });
    }
    if (!path.startsWith('/auth/me')) sessionListeners.forEach((fn) => fn(err.code));
  }
  throw err;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body = {}, headers) => request('POST', path, body, { headers }),
  put: (path, body = {}) => request('PUT', path, body),
  patch: (path, body = {}) => request('PATCH', path, body),
};

/** Build a query string, skipping empty values. @param {Record<string, any>} params */
export const qs = (params) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const str = s.toString();
  return str ? `?${str}` : '';
};
