import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Repository root: relative paths in configuration are resolved from here, never the working directory. */
export const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../..');
const fromRoot = (p) => (p && !isAbsolute(p) ? resolve(REPO_ROOT, p) : p);

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const key32 = z
  .string({ required_error: 'is required (base64 of 32 random bytes; run `npm run secrets`)' })
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be base64 of exactly 32 bytes');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:54329/afyazuri'),
  DB_POOL_MAX: z.coerce.number().int().default(10),
  JWT_SECRET: z.string({ required_error: 'is required (run `npm run secrets`)' }).min(32),
  ENCRYPTION_KEY: key32,
  BLIND_INDEX_KEY: key32,
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(600),
  REFRESH_TOKEN_TTL_SEC: z.coerce
    .number()
    .int()
    .positive()
    .default(8 * 3600),
  SESSION_MAX_AGE_SEC: z.coerce
    .number()
    .int()
    .positive()
    .default(7 * 24 * 3600),
  SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(15),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),
  REQUIRE_2FA_PRIVILEGED: bool.default('false'),
  AUTH_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(20),
  COOKIE_SECURE: bool.optional(),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  TRUST_PROXY: z.string().default('loopback'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  JOBS_ENABLED: bool.default('true'),
  // Serve the built web app from the API (single-process on-prem mode).
  WEB_DIST: z.string().optional(),
  // HTTPS directly from Node when no reverse proxy is used (local/LAN certificate).
  TLS_CERT_FILE: z.string().optional(),
  TLS_KEY_FILE: z.string().optional(),
  // Nightly encrypted backups (enabled when BACKUP_KEY and BACKUP_DIR are set).
  BACKUP_KEY: key32.optional(),
  BACKUP_DIR: z.string().optional(),
  BACKUP_OFFSITE_DIR: z.string().optional(),
  BACKUP_CRON: z.string().default('30 1 * * *'),
  BACKUP_KEEP_DAILY: z.coerce.number().int().min(1).default(7),
  BACKUP_KEEP_WEEKLY: z.coerce.number().int().min(0).default(4),
  BACKUP_KEEP_MONTHLY: z.coerce.number().int().min(0).default(12),
  // M-Pesa (Daraja). MPESA_ENV=mock talks to the bundled mock server (npm run mocks).
  MPESA_ENV: z.enum(['mock', 'sandbox', 'production']).default('mock'),
  MPESA_BASE_URL: z.string().url().optional(),
  MPESA_CONSUMER_KEY: z.string().default('mock-key'),
  MPESA_CONSUMER_SECRET: z.string().default('mock-secret'),
  MPESA_SHORTCODE: z
    .string()
    .regex(/^\d{5,7}$/)
    .default('174379'),
  MPESA_PASSKEY: z.string().default('mock-passkey'),
  /** Public base URL Safaricom calls back on, e.g. https://afyazuri.hospital.co.ke */
  MPESA_CALLBACK_BASE_URL: z.string().url().default('http://localhost:4000'),
  /** Secret path segment that authenticates callbacks (Daraja cannot send our auth headers). */
  MPESA_CALLBACK_TOKEN: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().min(16).default('dev-callback-token-change-me'),
  ),
  /** Optional comma-separated IPs allowed to call the M-Pesa callbacks (Safaricom publishes its ranges). */
  MPESA_CALLBACK_ALLOWED_IPS: z.string().default(''),
});

/**
 * @typedef {z.infer<typeof schema> & {cookieSecure: boolean, corsOrigins: string[]}} Config
 */

/**
 * Parse and validate configuration from environment variables.
 * Throws a readable error listing every missing or invalid variable.
 * @param {Record<string, string|undefined>} [env]
 * @returns {Config}
 */
export function loadConfig(env = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const c = parsed.data;
  if (
    c.NODE_ENV === 'production' &&
    c.MPESA_ENV !== 'mock' &&
    c.MPESA_CALLBACK_TOKEN === 'dev-callback-token-change-me'
  )
    throw new Error(
      'Invalid configuration:\n  MPESA_CALLBACK_TOKEN must be set to a secret value (run `npm run secrets`)',
    );
  if (!!c.TLS_CERT_FILE !== !!c.TLS_KEY_FILE)
    throw new Error('Invalid configuration:\n  Set both TLS_CERT_FILE and TLS_KEY_FILE, or neither');
  return {
    ...c,
    // e.g. BACKUP_DIR=backups always means <repo>/backups, whichever folder the process started in.
    WEB_DIST: fromRoot(c.WEB_DIST),
    TLS_CERT_FILE: fromRoot(c.TLS_CERT_FILE),
    TLS_KEY_FILE: fromRoot(c.TLS_KEY_FILE),
    BACKUP_DIR: fromRoot(c.BACKUP_DIR),
    BACKUP_OFFSITE_DIR: fromRoot(c.BACKUP_OFFSITE_DIR),
    cookieSecure: c.COOKIE_SECURE ?? c.NODE_ENV === 'production',
    corsOrigins: c.CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
