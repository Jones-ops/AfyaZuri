// Start the bundled mock Daraja (M-Pesa) server in-process when MPESA_ENV=mock.
import { createDarajaMock } from '../../deploy/mocks/daraja-mock.js';
import { portInUse } from './pg.js';

/**
 * @param {{port?: number, log?: (m: string) => void}} [o]
 * @returns {Promise<{url: string, close: () => Promise<void>}>}
 */
export async function startMocks({ port = Number(process.env.MOCK_DARAJA_PORT ?? 4300), log = console.log } = {}) {
  const url = `http://localhost:${port}`;
  if (await portInUse(port)) {
    log(`Mock M-Pesa already running on ${url}; reusing it.`);
    return { url, close: async () => {} };
  }
  const server = await new Promise((ok) => {
    const s = createDarajaMock({ log: (m) => log(`[daraja-mock] ${m}`) }).listen(port, '127.0.0.1', () => ok(s));
  });
  log(`Mock M-Pesa (Daraja) on ${url}`);
  return { url, close: () => new Promise((ok) => server.close(() => ok())) };
}
