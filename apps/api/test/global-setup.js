// Integration-test database. Uses TEST_DATABASE_URL when set (CI service container);
// otherwise starts a throwaway PostgreSQL 16 via embedded-postgres in a temp directory.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import knex from 'knex';
import knexConfig from '../../../knexfile.js';

/** @param {{provide: (key: string, value: unknown) => void}} ctx */
export default async function setup({ provide }) {
  let url = process.env.TEST_DATABASE_URL;
  let pg;
  let dir;
  if (!url) {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    dir = mkdtempSync(join(tmpdir(), 'afyazuri-pg-'));
    const port = 55000 + Math.floor(Math.random() * 2000);
    pg = new EmbeddedPostgres({
      databaseDir: dir,
      port,
      user: 'postgres',
      password: 'postgres',
      persistent: false,
      onLog: () => {},
    });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('afyazuri_test');
    url = `postgres://postgres:postgres@localhost:${port}/afyazuri_test`;
  }

  const db = knex({ ...knexConfig, connection: url });
  await db.raw('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await db.migrate.latest();
  await db.seed.run();
  await db.destroy();

  provide('databaseUrl', url);

  return async () => {
    if (pg) await pg.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  };
}
