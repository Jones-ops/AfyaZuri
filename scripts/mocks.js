// npm run mocks: the mock M-Pesa (Daraja) and SMS (Africa's Talking) servers on one port.
import { startMocks } from './lib/mocks.js';

const { url } = await startMocks();
console.log(`Point MPESA_BASE_URL and SMS_BASE_URL at ${url}. Ctrl+C to stop.`);
