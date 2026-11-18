// Start the bundled mock M-Pesa (Daraja) and SMS (Africa's Talking) servers in-process,
// on one port, for development, demos and end-to-end tests.
import express from 'express';
import { createDarajaMock } from '../../deploy/mocks/daraja-mock.js';
import { createSmsMock } from '../../deploy/mocks/sms-mock.js';
import { portInUse } from './pg.js';

/**
 * @param {{port?: number, log?: (m: string) => void}} [o]
 * @returns {Promise<{url: string, close: () => Promise<void>}>}
 */
export async function startMocks({ port = Number(process.env.MOCK_DARAJA_PORT ?? 4300), log = console.log } = {}) {
  const url = `http://localhost:${port}`;
  if (await portInUse(port)) {
    log(`Mock M-Pesa/SMS already running on ${url}; reusing it.`);
    return { url, close: async () => {} };
  }
  const app = express();
  app.use(createSmsMock({ log: (m) => log(`[sms-mock] ${m}`) }));
  app.use(createDarajaMock({ log: (m) => log(`[daraja-mock] ${m}`) }));
  const server = await new Promise((ok) => {
    const s = app.listen(port, '127.0.0.1', () => ok(s));
  });
  log(`Mock M-Pesa (Daraja) and SMS (Africa's Talking) on ${url}`);
  return { url, close: () => new Promise((ok) => server.close(() => ok())) };
}
