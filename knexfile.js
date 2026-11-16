// Knex configuration shared by the CLI, the API and the test harness.
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
