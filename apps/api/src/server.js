import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttps } from 'node:https';
import { fileURLToPath } from 'node:url';
import knex from 'knex';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { FieldCrypto } from './lib/crypto.js';
import { EventBus } from './lib/events.js';
import { createLogger } from './lib/logger.js';
import { startJobs } from './jobs.js';

// Load the repository-root .env when present (real environment variables win).
const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadConfig();
const logger = createLogger({ level: config.LOG_LEVEL });
const db = knex({ client: 'pg', connection: config.DATABASE_URL, pool: { min: 0, max: config.DB_POOL_MAX } });
const crypto = new FieldCrypto({ encryptionKey: config.ENCRYPTION_KEY, blindIndexKey: config.BLIND_INDEX_KEY });
const bus = new EventBus({ logger });
const deps = { db, config, logger, crypto, bus };

const app = createApp(deps);
const tls = config.TLS_CERT_FILE
  ? { cert: readFileSync(config.TLS_CERT_FILE), key: readFileSync(config.TLS_KEY_FILE) }
  : null;
const server = (tls ? createHttps(tls, app) : app).listen(config.PORT, () =>
  logger.info(
    { port: config.PORT, env: config.NODE_ENV, https: !!tls, web: !!config.WEB_DIST },
    'Afyazuri API listening',
  ),
);
const stopJobs = config.JOBS_ENABLED ? await startJobs(deps) : async () => {};

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  server.close();
  await stopJobs();
  await db.destroy();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
