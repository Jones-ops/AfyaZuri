import { Router } from 'express';

/**
 * Minimal Prometheus-style request metrics kept in memory per instance.
 */
export class Metrics {
  constructor() {
    this.started = Date.now();
    /** @type {Map<string, number>} */
    this.counts = new Map();
    this.durationSum = 0;
    this.durationCount = 0;
  }

  /** @type {import('express').RequestHandler} */
  middleware = (req, res, next) => {
    const t0 = process.hrtime.bigint();
    res.on('finish', () => {
      const key = `${req.method}|${Math.floor(res.statusCode / 100)}xx`;
      this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
      this.durationSum += Number(process.hrtime.bigint() - t0) / 1e9;
      this.durationCount += 1;
    });
    next();
  };

  render() {
    const lines = [
      '# TYPE afyazuri_http_requests_total counter',
      ...[...this.counts].map(([k, v]) => {
        const [method, status] = k.split('|');
        return `afyazuri_http_requests_total{method="${method}",status="${status}"} ${v}`;
      }),
      '# TYPE afyazuri_http_request_duration_seconds summary',
      `afyazuri_http_request_duration_seconds_sum ${this.durationSum.toFixed(6)}`,
      `afyazuri_http_request_duration_seconds_count ${this.durationCount}`,
      '# TYPE afyazuri_uptime_seconds gauge',
      `afyazuri_uptime_seconds ${Math.round((Date.now() - this.started) / 1000)}`,
      '# TYPE afyazuri_process_resident_memory_bytes gauge',
      `afyazuri_process_resident_memory_bytes ${process.memoryUsage().rss}`,
    ];
    return `${lines.join('\n')}\n`;
  }
}

/**
 * /health is liveness (process up). /ready also checks the database and that
 * migrations have been applied. /metrics is meant for the LAN/monitoring
 * network only; Nginx blocks it from the public listener.
 * @param {{db: import('knex').Knex, metrics: Metrics}} deps
 */
export function healthRoutes({ db, metrics }) {
  const r = Router();
  r.get('/health', (_req, res) => res.json({ status: 'ok' }));
  r.get('/ready', async (_req, res) => {
    try {
      await db.raw('SELECT 1');
      const hasSchema = await db.schema.hasTable('audit_log');
      if (!hasSchema) return res.status(503).json({ status: 'not_ready', reason: 'migrations not applied' });
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'not_ready', reason: 'database unreachable' });
    }
  });
  r.get('/metrics', (_req, res) => res.type('text/plain; version=0.0.4').send(metrics.render()));
  return r;
}
