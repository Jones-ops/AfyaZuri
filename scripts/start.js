#!/usr/bin/env node
// Production / on-premise runtime without Docker.
//
// Runs on one machine: an embedded PostgreSQL 16 server bound to localhost
// (never exposed to the LAN), and the Afyazuri API which also serves the
// built web app. The API is supervised and restarted if it crashes.
//
// Required in .env (see `npm run secrets`): JWT_SECRET, ENCRYPTION_KEY, BLIND_INDEX_KEY,
// PG_PASSWORD. Recommended: BACKUP_KEY + BACKUP_DIR for nightly backups, TLS_CERT_FILE +
// TLS_KEY_FILE for HTTPS on the LAN.
//
// Set EXTERNAL_DATABASE_URL to use a separately installed / managed PostgreSQL instead.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startMocks } from './lib/mocks.js';
import { ROOT, loadEnv, migrateAndSeed, startPostgres } from './lib/pg.js';

loadEnv();
process.env.NODE_ENV ??= 'production';
const log = (m) => console.log(`[afyazuri] ${new Date().toISOString()} ${m}`);

const web = resolve(ROOT, process.env.WEB_DIST ?? 'apps/web/dist');
if (!existsSync(join(web, 'index.html'))) {
  console.error('✗ The web app is not built. Run `npm run build` first.');
  process.exit(1);
}

let pg = { stop: async () => {} };
let url = process.env.EXTERNAL_DATABASE_URL;
if (!url) {
  if (!process.env.PG_PASSWORD) {
    console.error('✗ PG_PASSWORD is not set. Run `npm run secrets` to generate one.');
    process.exit(1);
  }
  pg = await startPostgres({
    dataDir: resolve(ROOT, process.env.PGDATA_DIR ?? 'data/postgres'),
    port: Number(process.env.PGPORT ?? 54329),
    password: process.env.PG_PASSWORD,
    database: process.env.PGDATABASE ?? 'afyazuri',
    log,
  });
  url = pg.url;
}
await migrateAndSeed(url, { demo: process.env.SEED_DEMO === 'true', log });

// Demo installs use the mock M-Pesa and SMS servers; real ones set MPESA_ENV / SMS_ENV.
const mockMpesa = (process.env.MPESA_ENV ?? 'mock') === 'mock';
const mockSms = (process.env.SMS_ENV ?? 'mock') === 'mock';
const mocks = mockMpesa || mockSms ? await startMocks({ log }) : null;
if (mocks && mockMpesa) log('M-Pesa is in MOCK mode: no real money moves. Set MPESA_ENV for live payments.');
if (mocks && mockSms) log('SMS is in MOCK mode: nothing reaches phones. Set SMS_ENV to send for real.');
const env = {
  ...process.env,
  DATABASE_URL: url,
  WEB_DIST: web,
  ...(mocks && mockMpesa ? { MPESA_BASE_URL: process.env.MPESA_BASE_URL ?? mocks.url } : {}),
  ...(mocks && mockSms ? { SMS_BASE_URL: process.env.SMS_BASE_URL ?? mocks.url } : {}),
};
let child;
let stopping = false;
let restarts = 0;
function startApi() {
  child = spawn(process.execPath, [join(ROOT, 'apps/api/src/server.js')], { stdio: 'inherit', env });
  const startedAt = Date.now();
  child.on('exit', (code, signal) => {
    if (stopping) return;
    restarts = Date.now() - startedAt > 60_000 ? 0 : restarts + 1;
    const delay = Math.min(30_000, 1000 * 2 ** restarts);
    log(`API exited (${signal ?? code}); restarting in ${delay / 1000}s`);
    setTimeout(startApi, delay);
  });
}
startApi();

async function stop(signal) {
  if (stopping) return;
  stopping = true;
  log(`${signal} received, stopping`);
  if (child && child.exitCode === null) {
    const exited = new Promise((ok) => child.once('exit', ok));
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((ok) => setTimeout(ok, 15_000))]);
  }
  await pg.stop();
  process.exit(0);
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
