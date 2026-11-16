import knex from 'knex';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { FieldCrypto } from './lib/crypto.js';
import { EventBus } from './lib/events.js';
import { createLogger } from './lib/logger.js';
import { startJobs } from './jobs.js';

const config = loadConfig();
const logger = createLogger({ level: config.LOG_LEVEL });
const db = knex({ client: 'pg', connection: config.DATABASE_URL, pool: { min: 0, max: config.DB_POOL_MAX } });
const crypto = new FieldCrypto({ encryptionKey: config.ENCRYPTION_KEY, blindIndexKey: config.BLIND_INDEX_KEY });
const bus = new EventBus({ logger });
const deps = { db, config, logger, crypto, bus };

const app = createApp(deps);
const server = app.listen(config.PORT, () => logger.info({ port: config.PORT, env: config.NODE_ENV }, 'AfyaZuri API listening'));
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
