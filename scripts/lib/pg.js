// Shared helpers for running Afyazuri on embedded PostgreSQL 16 (no Docker).
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import knex from 'knex';

export { ROOT, loadEnv } from './env.js';

/** True when something is already listening on localhost:port. */
export const portInUse = (port) =>
  new Promise((ok) => {
    const s = connect({ port, host: '127.0.0.1' });
    s.once('connect', () => {
      s.destroy();
      ok(true);
    });
    s.once('error', () => ok(false));
  });

/**
 * Start (initialising on first run) an embedded PostgreSQL server bound to
 * localhost and make sure the database exists. Returns a stop function; when a
 * server is already running on the port it is reused and stop is a no-op.
 * @param {{dataDir: string, port: number, password: string, database: string, log?: (m: string) => void}} o
 */
export async function startPostgres({ dataDir, port, password, database, log = console.log }) {
  if (await portInUse(port)) {
    log(`PostgreSQL already running on port ${port}; reusing it.`);
    return {
      url: `postgres://postgres:${encodeURIComponent(password)}@localhost:${port}/${database}`,
      stop: async () => {},
    };
  }
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password,
    port,
    persistent: true,
    onLog: () => {},
    onError: (e) => log(`postgres: ${e}`),
  });
  const fresh = !existsSync(join(dataDir, 'PG_VERSION'));
  if (fresh) {
    log(`Initialising PostgreSQL data directory at ${dataDir}`);
    await pg.initialise();
  }
  await pg.start();
  try {
    await pg.createDatabase(database);
    log(`Created database ${database}`);
  } catch {
    /* already exists */
  }
  log(`PostgreSQL ${pgVersion(dataDir)} running on localhost:${port}`);
  return {
    url: `postgres://postgres:${encodeURIComponent(password)}@localhost:${port}/${database}`,
    stop: () => pg.stop(),
  };
}

const pgVersion = (dir) => {
  try {
    return readFileSync(join(dir, 'PG_VERSION'), 'utf8').trim();
  } catch {
    return '';
  }
};

/**
 * Apply migrations and seeds. Demo data is seeded only outside production.
 * @param {string} url @param {{demo: boolean, log?: (m: string) => void}} o
 */
export async function migrateAndSeed(url, { demo, log = console.log }) {
  const { default: config } = await import('../../knexfile.js');
  const db = knex({ ...config, connection: url });
  try {
    const [, ran] = await db.migrate.latest();
    log(ran.length ? `Applied ${ran.length} migration(s)` : 'Database schema is up to date');
    await db.seed.run(demo ? {} : { specific: '01_reference.js' });
    log(demo ? 'Reference and demo data seeded' : 'Reference data seeded');
  } finally {
    await db.destroy();
  }
}
