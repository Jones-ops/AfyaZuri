import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { AppError, errorHandler } from './lib/errors.js';
import { safeUrl } from './lib/logger.js';
import { csrfGuard } from './middleware/auth.js';
import { auditRoutes } from './modules/audit/routes.js';
import { authRoutes } from './modules/auth/routes.js';
import { facilityRoutes } from './modules/facilities/routes.js';
import { Metrics, healthRoutes } from './modules/health/routes.js';
import { userRoutes } from './modules/users/routes.js';

/**
 * @typedef {Object} Deps
 * @property {import('knex').Knex} db
 * @property {import('./config.js').Config} config
 * @property {import('pino').Logger} logger
 * @property {import('./lib/crypto.js').FieldCrypto} crypto
 * @property {import('./lib/events.js').EventBus} bus
 */

/**
 * Build the Express application. Side-effect free (no listening, no jobs),
 * so tests can create it against a test database.
 * @param {Deps} deps
 */
export function createApp(deps) {
  const { config, logger } = deps;
  const app = express();
  const metrics = new Metrics();

  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY);
  app.use(metrics.middleware);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id =
          (typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'].slice(0, 64)) || randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: safeUrl(req.url) }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/metrics' },
    }),
  );
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          manifestSrc: ["'self'"],
          workerSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      // LAN installs may run plain HTTP behind a firewall; only send HSTS over TLS.
      strictTransportSecurity: Boolean(config.TLS_CERT_FILE) || config.NODE_ENV === 'production',
    }),
  );
  app.use(compression());
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
      credentials: true,
      allowedHeaders: ['Content-Type', 'X-Afyazuri-Client', 'Idempotency-Key', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id', 'Idempotent-Replay'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.use(healthRoutes({ db: deps.db, metrics }));

  const api = express.Router();
  api.use(csrfGuard);
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  api.use('/auth', authRoutes(deps));
  api.use(userRoutes(deps));
  api.use(facilityRoutes(deps));
  api.use(auditRoutes(deps));
  api.use((req) => {
    throw new AppError(404, 'NOT_FOUND', `No route for ${req.method} ${safeUrl(req.originalUrl)}`);
  });
  app.use('/api/v1', api);

  if (config.WEB_DIST) {
    const dist = resolve(config.WEB_DIST);
    if (!existsSync(join(dist, 'index.html')))
      throw new Error(`WEB_DIST=${dist} has no index.html. Run \`npm run build\` first.`);
    app.use(
      express.static(dist, {
        index: false,
        setHeaders: (res, file) => {
          // Hashed assets never change; the shell and service worker must always revalidate.
          if (/[\\/]assets[\\/]/.test(file)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          else res.setHeader('Cache-Control', 'no-cache');
        },
      }),
    );
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(join(dist, 'index.html'));
    });
  }

  app.use(errorHandler());
  return app;
}
