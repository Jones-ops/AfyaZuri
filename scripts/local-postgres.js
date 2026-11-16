// Starts a local PostgreSQL 16 server (via embedded-postgres) for development on machines
// without Docker. Data lives in .pgdata/ (git-ignored). `npm run dev` does this for you.
import { resolve } from 'node:path';
import { ensureDatabase, startCluster } from './lib/pg.js';

const dataDir = resolve(process.env.PGDATA_DIR ?? '.pgdata');
const port = Number(process.env.PGPORT ?? 54329);

const pg = await startCluster({ dataDir, port, password: 'postgres', log: console.log });
for (const db of ['afyazuri', 'afyazuri_test']) await ensureDatabase(pg, db);
console.log(`PostgreSQL running on localhost:${port} (user postgres / postgres). Ctrl+C to stop.`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
if (process.argv.includes('--once')) await stop();
