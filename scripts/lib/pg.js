// Shared helpers for running Afyazuri on embedded PostgreSQL 16 (no Docker).
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import knex from 'knex';

export { ROOT, loadEnv } from './env.js';

/**
 * Cluster settings. Patient names and clinical text need UTF-8 (Windows would
 * otherwise default to WIN1252). ICU collation gives Unicode-aware lower() for
 * accent-insensitive name search; builds without ICU fall back to the C locale.
 */
const INIT_FLAGS = [
  ['--encoding=UTF8', '--locale-provider=icu', '--icu-locale=und', '--locale=C'],
  ['--encoding=UTF8', '--locale=C'],
];

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
 * Create (if needed) and start an embedded PostgreSQL cluster in dataDir.
 * @param {{dataDir: string, port: number, password: string, persistent?: boolean, log?: (m: string) => void}} o
 * @returns {Promise<EmbeddedPostgres>}
 */
export async function startCluster({ dataDir, port, password, persistent = true, log = () => {} }) {
  const make = (flags) =>
    new EmbeddedPostgres({
      databaseDir: dataDir,
      user: 'postgres',
      password,
      port,
      persistent,
      initdbFlags: flags,
      onLog: () => {},
      onError: (e) => log(`postgres: ${e}`),
    });
  if (existsSync(join(dataDir, 'PG_VERSION'))) {
    const pg = make([]);
    await pg.start();
    return pg;
  }
  let lastErr;
  for (const flags of INIT_FLAGS) {
    const pg = make(flags);
    try {
      await pg.initialise();
      await pg.start();
      return pg;
    } catch (err) {
      lastErr = err;
      log(`initdb with ${flags.join(' ')} failed; trying the next option`);
      if (existsSync(dataDir))
        for (const f of readdirSync(dataDir)) rmSync(join(dataDir, f), { recursive: true, force: true });
    }
  }
  throw lastErr;
}

/**
 * Create a UTF-8 database if it does not exist (works even on an older
 * cluster whose default encoding is not UTF-8).
 * @param {EmbeddedPostgres} pg @param {string} name
 * @returns {Promise<boolean>} true when created
 */
export async function ensureDatabase(pg, name) {
  const client = pg.getPgClient();
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (rowCount) return false;
    await client.query(
      `CREATE DATABASE ${client.escapeIdentifier(name)} ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`,
    );
    return true;
  } finally {
    await client.end();
  }
}

/**
 * Start (initialising on first run) an embedded PostgreSQL server bound to
 * localhost and make sure the database exists. Returns a stop function; when a
 * server is already running on the port it is reused and stop is a no-op.
 * @param {{dataDir: string, port: number, password: string, database: string, log?: (m: string) => void}} o
 */
export async function startPostgres({ dataDir, port, password, database, log = console.log }) {
  const url = `postgres://postgres:${encodeURIComponent(password)}@localhost:${port}/${database}`;
  if (await portInUse(port)) {
    log(`PostgreSQL already running on port ${port}; reusing it.`);
    return { url, stop: async () => {} };
  }
  if (!existsSync(join(dataDir, 'PG_VERSION'))) log(`Initialising PostgreSQL data directory at ${dataDir}`);
  const pg = await startCluster({ dataDir, port, password, log });
  if (await ensureDatabase(pg, database)) log(`Created database ${database}`);
  log(`PostgreSQL ${pgVersion(dataDir)} running on localhost:${port}`);
  return { url, stop: () => pg.stop() };
}

const pgVersion = (dir) => {
  try {
    return readFileSync(join(dir, 'PG_VERSION'), 'utf8').trim();
  } catch {
    return '';
  }
};

/**
 * Refuse to run against a database that cannot store all Unicode text.
 * @param {import('knex').Knex} db
 */
export async function assertUtf8(db) {
  const { rows } = await db.raw(
    `SELECT pg_encoding_to_char(encoding) AS enc FROM pg_database WHERE datname = current_database()`,
  );
  if (rows[0].enc !== 'UTF8')
    throw new Error(
      `Database encoding is ${rows[0].enc}, but Afyazuri needs UTF8 so names and clinical text are stored correctly. ` +
        "Create the database with ENCODING 'UTF8' (see docs/onprem-install.md).",
    );
}

/**
 * Apply migrations and seeds. Demo data is seeded only outside production.
 * @param {string} url @param {{demo: boolean, log?: (m: string) => void}} o
 */
export async function migrateAndSeed(url, { demo, log = console.log }) {
  const { default: config } = await import('../../knexfile.js');
  const db = knex({ ...config, connection: url });
  try {
    await assertUtf8(db);
    const [, ran] = await db.migrate.latest();
    log(ran.length ? `Applied ${ran.length} migration(s)` : 'Database schema is up to date');
    await db.seed.run(demo ? {} : { specific: '01_reference.js' });
    log(demo ? 'Reference and demo data seeded' : 'Reference data seeded');
  } finally {
    await db.destroy();
  }
}
