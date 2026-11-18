#!/usr/bin/env node
// Mock of Africa's Talking's bulk SMS endpoint for development and tests. Messages are
// kept in memory (never sent anywhere) and can be read back at GET /mock/sms/messages.
//
// Outcome by the recipient's number (last digits):
//   …0404  rejected as an invalid number (statusCode 403)
//   anything else  sent (statusCode 101)
import { randomBytes } from 'node:crypto';
import express from 'express';

/**
 * @param {{log?: (m: string) => void, keep?: number}} [opts]
 * @returns {import('express').Express & {messages: Array<{to: string, message: string, from: string|null, messageId: string, at: string}>}}
 */
export function createSmsMock({ log = () => {}, keep = 500 } = {}) {
  const app = express();
  /** @type {Array<any>} */
  const messages = [];

  app.post('/version1/messaging', express.urlencoded({ extended: false, limit: '16kb' }), (req, res) => {
    if (!req.get('apikey')) return res.status(401).send('The supplied authentication is invalid');
    const { username, to, message, from } = req.body ?? {};
    if (!username || !to || !message) return res.status(400).send('Missing username, to or message');
    const recipients = String(to)
      .split(',')
      .map((n) => n.trim())
      .map((number) => {
        if (number.endsWith('0404'))
          return { number, status: 'InvalidPhoneNumber', statusCode: 403, cost: '0', messageId: 'None' };
        const messageId = `ATXid_${randomBytes(12).toString('hex')}`;
        messages.push({ to: number, message, from: from ?? null, messageId, at: new Date().toISOString() });
        if (messages.length > keep) messages.shift();
        log(`SMS to ${number.slice(0, 7)}… (${message.length} chars)`);
        return { number, status: 'Success', statusCode: 101, cost: 'KES 0.8000', messageId };
      });
    const sent = recipients.filter((r) => r.statusCode === 101).length;
    res.status(201).json({
      SMSMessageData: {
        Message: `Sent to ${sent}/${recipients.length} Total Cost: KES ${(sent * 0.8).toFixed(4)}`,
        Recipients: recipients,
      },
    });
  });

  // Test helper: what would have reached phones.
  app.get('/mock/sms/messages', (req, res) => {
    const to = typeof req.query.to === 'string' ? req.query.to : null;
    res.json({ data: to ? messages.filter((m) => m.to === to) : messages });
  });

  Object.assign(app, { messages });
  return /** @type {any} */ (app);
}

// Run standalone: node deploy/mocks/sms-mock.js
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const port = Number(process.env.MOCK_SMS_PORT ?? 4302);
  createSmsMock({ log: (m) => console.log(`[sms-mock] ${m}`) }).listen(port, () =>
    console.log(`[sms-mock] listening on http://localhost:${port}`),
  );
}
