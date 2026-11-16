// Starts a local PostgreSQL 16 server (via embedded-postgres) for development and tests
// on machines without Docker. Data lives in .pgdata/ (git-ignored).
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const dataDir = resolve(process.env.PGDATA_DIR ?? '.pgdata');
const port = Number(process.env.PGPORT ?? 54329);

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'postgres',
  password: 'postgres',
  port,
  persistent: true,
  onLog: () => {},
});

if (!existsSync(resolve(dataDir, 'PG_VERSION'))) await pg.initialise();
await pg.start();
for (const db of ['afyazuri', 'afyazuri_test']) {
  try { await pg.createDatabase(db); } catch { /* already exists */ }
}
console.log(`PostgreSQL running on localhost:${port} (user postgres / postgres). Ctrl+C to stop.`);
const stop = async () => { await pg.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
if (process.argv.includes('--once')) await stop();
