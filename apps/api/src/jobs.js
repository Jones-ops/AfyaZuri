import { copyFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import PgBoss from 'pg-boss';
import { reconcilePendingStk } from './modules/billing/payments.js';
import { createBackup, pruneBackups, verifyBackup } from './ops/backup.js';

/**
 * Background work.
 * - pg-boss runs scheduled jobs (Postgres-backed; no Redis needed on-prem).
 * - The outbox dispatcher polls every second for low-latency event delivery.
 * @param {import('./app.js').Deps} deps
 */
export async function startJobs(deps) {
  const { db, config, logger, bus } = deps;
  const boss = new PgBoss({ connectionString: config.DATABASE_URL, schema: 'pgboss' });
  boss.on('error', (err) => logger.error({ err }, 'pg-boss error'));
  await boss.start();

  const jobs = {
    'sessions.cleanup': async () => {
      // Remove refresh tokens of sessions that ended more than 30 days ago.
      const n = await db('refresh_tokens')
        .whereIn(
          'session_id',
          db('sessions')
            .where('expires_at', '<', db.raw(`now() - interval '30 days'`))
            .orWhere('revoked_at', '<', db.raw(`now() - interval '30 days'`))
            .select('id'),
        )
        .delete();
      logger.info({ removed: n }, 'sessions.cleanup');
    },
    'idempotency.cleanup': async () => {
      const n = await db('idempotency_keys').where('created_at', '<', db.raw(`now() - interval '7 days'`)).delete();
      logger.info({ removed: n }, 'idempotency.cleanup');
    },
  };
  const backupsOn = Boolean(config.BACKUP_KEY && config.BACKUP_DIR);
  if (backupsOn) {
    jobs['backup.nightly'] = async () => {
      const policy = {
        daily: config.BACKUP_KEEP_DAILY,
        weekly: config.BACKUP_KEEP_WEEKLY,
        monthly: config.BACKUP_KEEP_MONTHLY,
      };
      const r = await createBackup({ db, key: config.BACKUP_KEY, dir: config.BACKUP_DIR });
      await verifyBackup(r.file, config.BACKUP_KEY);
      const pruned = await pruneBackups(config.BACKUP_DIR, policy);
      if (config.BACKUP_OFFSITE_DIR) {
        await mkdir(config.BACKUP_OFFSITE_DIR, { recursive: true });
        await copyFile(r.file, join(config.BACKUP_OFFSITE_DIR, basename(r.file)));
        await pruneBackups(config.BACKUP_OFFSITE_DIR, policy);
      }
      logger.info(
        { file: basename(r.file), bytes: r.bytes, rows: r.rows, pruned: pruned.length },
        'backup.nightly complete',
      );
    };
  }

  // Settle M-Pesa requests whose callback never arrived.
  jobs['mpesa.reconcile'] = async () => {
    const n = await reconcilePendingStk({ db, bus, crypto: deps.crypto, mpesa: deps.mpesa, logger });
    if (n) logger.info({ queried: n }, 'mpesa.reconcile');
  };

  for (const [name, handler] of Object.entries(jobs)) {
    await boss.createQueue(name);
    await boss.work(name, handler);
  }
  await boss.schedule('sessions.cleanup', '15 3 * * *', {}, { tz: 'Africa/Nairobi' });
  await boss.schedule('idempotency.cleanup', '30 3 * * *', {}, { tz: 'Africa/Nairobi' });
  if (backupsOn) await boss.schedule('backup.nightly', config.BACKUP_CRON, {}, { tz: 'Africa/Nairobi' });
  else await boss.unschedule('backup.nightly').catch(() => {});
  await boss.schedule('mpesa.reconcile', '* * * * *', {}, { tz: 'Africa/Nairobi' });

  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      try {
        const n = await bus.dispatchPending(db);
        if (n === 0) await new Promise((r) => setTimeout(r, 1000));
      } catch (err) {
        logger.error({ err }, 'outbox dispatch failed');
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  };
  const loopDone = loop();

  return async () => {
    stopped = true;
    await loopDone;
    await boss.stop({ graceful: true, timeout: 10_000 });
  };
}
