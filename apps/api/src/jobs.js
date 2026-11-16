import PgBoss from 'pg-boss';

/**
 * Background work.
 * - pg-boss runs scheduled jobs (Postgres-backed; no Redis needed on-prem).
 * - The outbox dispatcher polls every second for low-latency event delivery.
 * @param {import('./app.js').Deps} deps
 */
export async function startJobs({ db, config, logger, bus }) {
  const boss = new PgBoss({ connectionString: config.DATABASE_URL, schema: 'pgboss' });
  boss.on('error', (err) => logger.error({ err }, 'pg-boss error'));
  await boss.start();

  const jobs = {
    'sessions.cleanup': async () => {
      // Remove refresh tokens of sessions that ended more than 30 days ago.
      const n = await db('refresh_tokens')
        .whereIn('session_id', db('sessions').where('expires_at', '<', db.raw(`now() - interval '30 days'`))
          .orWhere('revoked_at', '<', db.raw(`now() - interval '30 days'`)).select('id'))
        .delete();
      logger.info({ removed: n }, 'sessions.cleanup');
    },
    'idempotency.cleanup': async () => {
      const n = await db('idempotency_keys').where('created_at', '<', db.raw(`now() - interval '7 days'`)).delete();
      logger.info({ removed: n }, 'idempotency.cleanup');
    },
  };
  for (const [name, handler] of Object.entries(jobs)) {
    await boss.createQueue(name);
    await boss.work(name, handler);
  }
  await boss.schedule('sessions.cleanup', '15 3 * * *', {}, { tz: 'Africa/Nairobi' });
  await boss.schedule('idempotency.cleanup', '30 3 * * *', {}, { tz: 'Africa/Nairobi' });

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
