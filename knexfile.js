// Knex configuration shared by the CLI, the API and the test harness.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The Knex CLI (npm run db:migrate / db:seed) reads .env too, so demo seeding can
// encrypt patient fields with the same keys the API uses. Real environment variables win.
const envFile = fileURLToPath(new URL('./.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const connection = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54329/afyazuri';

/** @type {import('knex').Knex.Config} */
const config = {
  client: 'pg',
  connection,
  pool: { min: 0, max: Number(process.env.DB_POOL_MAX ?? 10) },
  migrations: { directory: './db/migrations', loadExtensions: ['.js'], tableName: 'knex_migrations' },
  seeds: { directory: './db/seeds', loadExtensions: ['.js'] },
};

export default config;
