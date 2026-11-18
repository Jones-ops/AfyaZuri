#!/usr/bin/env node
// Server for Playwright: a throwaway embedded PostgreSQL with demo data, and the API
// serving the built web app on http://localhost:4100 (the same single-process mode
// used on-premise). Started automatically by playwright.config.js.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMocks } from './lib/mocks.js';
import { ROOT, migrateAndSeed, startPostgres } from './lib/pg.js';

// One set of keys for both the demo seed (which encrypts patient phones and IDs) and the API.
const keys = {
  JWT_SECRET: randomBytes(48).toString('hex'),
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  BLIND_INDEX_KEY: randomBytes(32).toString('base64'),
};
Object.assign(process.env, keys);

const dataDir = mkdtempSync(join(tmpdir(), 'afyazuri-e2e-'));
const pg = await startPostgres({ dataDir, port: 55433, password: 'postgres', database: 'afyazuri_e2e' });
await migrateAndSeed(pg.url, { demo: true });

const mocks = await startMocks({ port: 4301, log: () => {} });

const api = spawn(process.execPath, [join(ROOT, 'apps/api/src/server.js')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    ...keys,
    NODE_ENV: 'test',
    PORT: '4100',
    MPESA_ENV: 'mock',
    MPESA_BASE_URL: mocks.url,
    MPESA_CALLBACK_BASE_URL: 'http://localhost:4100',
    SMS_ENV: 'mock',
    SMS_BASE_URL: mocks.url,
    ETIMS_ENV: 'mock',
    DATABASE_URL: pg.url,
    WEB_DIST: join(ROOT, 'apps/web/dist'),
    COOKIE_SECURE: 'false',
    JOBS_ENABLED: 'false',
    AUTH_RATE_LIMIT_PER_MIN: '1000',
    LOG_LEVEL: 'warn',
  },
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  api.kill();
  await pg.stop();
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
api.on('exit', () => stop());
