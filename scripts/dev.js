#!/usr/bin/env node
// One command for local development: embedded PostgreSQL + migrations + demo seed +
// API (auto-restart on change) + Vite dev server. Ctrl+C stops everything.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startMocks } from './lib/mocks.js';
import { ROOT, loadEnv, migrateAndSeed, startPostgres } from './lib/pg.js';

if (!existsSync(join(ROOT, '.env')))
  spawnSync(process.execPath, [join(ROOT, 'scripts/gen-secrets.js')], { stdio: 'inherit' });
loadEnv();
process.env.NODE_ENV ??= 'development';

const port = Number(process.env.PGPORT ?? 54329);
const pg = await startPostgres({
  dataDir: join(ROOT, process.env.PGDATA_DIR ?? '.pgdata'),
  port,
  password: 'postgres',
  database: 'afyazuri',
});
process.env.DATABASE_URL ??= pg.url;
await migrateAndSeed(process.env.DATABASE_URL, { demo: true });

const mocks = (process.env.MPESA_ENV ?? 'mock') === 'mock' ? await startMocks() : null;
if (mocks) process.env.MPESA_BASE_URL ??= mocks.url;

const children = [
  spawn(process.execPath, ['--watch', 'src/server.js'], {
    cwd: join(ROOT, 'apps/api'),
    stdio: 'inherit',
    env: process.env,
  }),
  spawn(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js')], {
    cwd: join(ROOT, 'apps/web'),
    stdio: 'inherit',
    env: process.env,
  }),
];
console.log(
  '\n  Afyazuri dev: web http://localhost:5173  ·  API http://localhost:4000  ·  demo password Afyazuri#2026\n',
);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill();
  await pg.stop();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const c of children)
  c.on('exit', (code) => {
    if (!stopping && code) {
      console.error(`A dev process exited with code ${code}`);
      stop();
    }
  });
