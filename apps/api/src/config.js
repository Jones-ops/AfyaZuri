import { z } from 'zod';

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
  if (!!c.TLS_CERT_FILE !== !!c.TLS_KEY_FILE)
    throw new Error('Invalid configuration:\n  Set both TLS_CERT_FILE and TLS_KEY_FILE, or neither');
  return {
    ...c,
    cookieSecure: c.COOKIE_SECURE ?? c.NODE_ENV === 'production',
    corsOrigins: c.CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
