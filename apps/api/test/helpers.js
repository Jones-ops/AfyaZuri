import knex from 'knex';
import request from 'supertest';
import { inject } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { FieldCrypto } from '../src/lib/crypto.js';
import { EventBus } from '../src/lib/events.js';
import { createLogger } from '../src/lib/logger.js';
import { TEST_KEYS as keys } from './keys.js';

export const DEMO_PASSWORD = 'Afyazuri#2026';

/**
 * Build an app against the integration database.
 * @param {Record<string, string>} [env] config overrides
 */
export function makeApp(env = {}) {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: inject('databaseUrl'),
    LOG_LEVEL: 'silent',
    AUTH_RATE_LIMIT_PER_MIN: '10000',
    JOBS_ENABLED: 'false',
    ...keys,
    ...env,
  });
  const logger = createLogger({ level: 'silent' });
  const db = knex({ client: 'pg', connection: config.DATABASE_URL, pool: { min: 0, max: 5 } });
  const crypto = new FieldCrypto({ encryptionKey: config.ENCRYPTION_KEY, blindIndexKey: config.BLIND_INDEX_KEY });
  const bus = new EventBus({ logger });
  const deps = { db, config, logger, crypto, bus };
  return { app: createApp(deps), ...deps };
}

/**
 * Cookie-keeping client that always sends the CSRF header.
 * @param {import('express').Express} app
 */
export function client(app) {
  const agent = request.agent(app);
  const h = (r) => r.set('X-Afyazuri-Client', '1');
  return {
    agent,
    get: (url) => h(agent.get(url)),
    post: (url, body) => h(agent.post(url)).send(body ?? {}),
    put: (url, body) => h(agent.put(url)).send(body ?? {}),
    patch: (url, body) => h(agent.patch(url)).send(body ?? {}),
    delete: (url) => h(agent.delete(url)),
  };
}

/**
 * Sign in and return a client holding the session cookies.
 * @param {import('express').Express} app
 * @param {string} username
 * @param {string} [password]
 */
export async function signIn(app, username, password = DEMO_PASSWORD) {
  const c = client(app);
  const res = await c.post('/api/v1/auth/login', { username, password });
  if (res.status !== 200) throw new Error(`login ${username} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return c;
}

let n = 0;
/** Unique suffix for test data. */
export const uniq = (prefix = 't') => `${prefix}${Date.now().toString(36)}${(n++).toString(36)}`;

/** A password that satisfies the policy. */
export const STRONG = 'Str0ng!Passw0rd';
