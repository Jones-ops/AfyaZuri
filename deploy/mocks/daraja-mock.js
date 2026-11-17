#!/usr/bin/env node
// Mock of Safaricom's Daraja API for development and tests: OAuth, STK Push (with a
// callback a moment later), STK query, C2B URL registration and a helper to
// simulate a customer paying via Paybill.
//
//   npm run mocks                    # listens on http://localhost:4300
//
// Outcome by the customer's phone number (last digits):
//   …0001  insufficient funds (ResultCode 1)      …0032  customer cancelled (1032)
//   …0099  no callback at all (tests the query fallback; query reports success)
//   anything else  paid successfully
import { randomBytes } from 'node:crypto';
import express from 'express';

/**
 * @param {{delayMs?: number, log?: (m: string) => void}} [opts]
 * @returns {import('express').Express & {requests: Map<string, any>, c2bUrls: any}}
 */
export function createDarajaMock({ delayMs = 800, log = () => {} } = {}) {
  const app = express();
  app.use(express.json());
  /** @type {Map<string, {body: any, outcome: number, receipt: string}>} */
  const requests = new Map();
  let c2bUrls = null;
  const id = (p) => `${p}_${Date.now()}_${randomBytes(4).toString('hex')}`;
  const outcomeFor = (msisdn) => (msisdn.endsWith('0001') ? 1 : msisdn.endsWith('0032') ? 1032 : 0);
  const receipt = () => `S${randomBytes(5).toString('hex').toUpperCase().slice(0, 9)}`;
  const post = (url, body) =>
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(
      (e) => log(`callback to ${url} failed: ${e.message}`),
    );

  app.get('/oauth/v1/generate', (req, res) => {
    if (!req.get('authorization')?.startsWith('Basic '))
      return res.status(401).json({ errorMessage: 'Invalid credentials' });
    res.json({ access_token: `mock_${randomBytes(8).toString('hex')}`, expires_in: '3599' });
  });

  const bearer = (req, res, next) =>
    req.get('authorization')?.startsWith('Bearer ')
      ? next()
      : res.status(401).json({ errorMessage: 'Invalid Access Token' });

  app.post('/mpesa/stkpush/v1/processrequest', bearer, (req, res) => {
    const b = req.body;
    for (const k of [
      'BusinessShortCode',
      'Password',
      'Timestamp',
      'Amount',
      'PhoneNumber',
      'CallBackURL',
      'AccountReference',
    ])
      if (b[k] === undefined || b[k] === '')
        return res.status(400).json({ errorCode: '400.002.02', errorMessage: `Bad Request - Invalid ${k}` });
    if (!/^2547\d{8}$|^2541\d{8}$/.test(String(b.PhoneNumber)))
      return res.status(400).json({ errorMessage: 'Bad Request - Invalid PhoneNumber' });
    const merchant = id('MR');
    const checkout = id('ws_CO');
    const outcome = outcomeFor(String(b.PhoneNumber));
    requests.set(checkout, { body: b, outcome, receipt: receipt() });
    res.json({
      MerchantRequestID: merchant,
      CheckoutRequestID: checkout,
      ResponseCode: '0',
      ResponseDescription: 'Success. Request accepted for processing',
      CustomerMessage: 'Success. Request accepted for processing',
    });
    if (String(b.PhoneNumber).endsWith('0099')) return; // lost callback
    setTimeout(() => {
      const r = requests.get(checkout);
      const stkCallback = {
        MerchantRequestID: merchant,
        CheckoutRequestID: checkout,
        ResultCode: r.outcome,
        ResultDesc:
          r.outcome === 0
            ? 'The service request is processed successfully.'
            : r.outcome === 1032
              ? 'Request cancelled by user'
              : 'The balance is insufficient for the transaction',
      };
      if (r.outcome === 0)
        stkCallback.CallbackMetadata = {
          Item: [
            { Name: 'Amount', Value: Number(b.Amount) },
            { Name: 'MpesaReceiptNumber', Value: r.receipt },
            { Name: 'TransactionDate', Value: Number(new Date().toISOString().replace(/\D/g, '').slice(0, 14)) },
            { Name: 'PhoneNumber', Value: Number(b.PhoneNumber) },
          ],
        };
      log(`STK ${checkout} → ${r.outcome}`);
      post(b.CallBackURL, { Body: { stkCallback } });
    }, delayMs);
  });

  app.post('/mpesa/stkpushquery/v1/query', bearer, (req, res) => {
    const r = requests.get(req.body.CheckoutRequestID);
    if (!r) return res.status(404).json({ errorMessage: 'The transaction is being processed' });
    res.json({
      ResponseCode: '0',
      ResultCode: String(r.outcome),
      ResultDesc: r.outcome === 0 ? 'The service request is processed successfully.' : 'Request cancelled by user',
      CheckoutRequestID: req.body.CheckoutRequestID,
      MpesaReceiptNumber: r.outcome === 0 ? r.receipt : undefined,
    });
  });

  app.post('/mpesa/c2b/v1/registerurl', bearer, (req, res) => {
    c2bUrls = req.body;
    res.json({ ResponseCode: '0', ResponseDescription: 'Success' });
  });

  /** Test helper: pretend a customer paid into the Paybill. Body: { BillRefNumber, TransAmount, MSISDN } */
  app.post('/mock/c2b/pay', async (req, res) => {
    if (!c2bUrls) return res.status(409).json({ error: 'Register C2B URLs first' });
    const trans = {
      TransactionType: 'Pay Bill',
      TransID: receipt(),
      TransTime: new Date().toISOString().replace(/\D/g, '').slice(0, 14),
      TransAmount: String(req.body.TransAmount),
      BusinessShortCode: c2bUrls.ShortCode,
      BillRefNumber: req.body.BillRefNumber,
      MSISDN: String(req.body.MSISDN ?? '254712345678'),
      FirstName: 'MOCK',
    };
    await post(c2bUrls.ConfirmationURL, trans);
    res.json({ ok: true, TransID: trans.TransID });
  });

  Object.assign(app, {
    requests,
    get c2bUrls() {
      return c2bUrls;
    },
  });
  return /** @type {any} */ (app);
}

// Run standalone: node deploy/mocks/daraja-mock.js
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const port = Number(process.env.MOCK_DARAJA_PORT ?? 4300);
  createDarajaMock({ log: (m) => console.log(`[daraja-mock] ${m}`) }).listen(port, () =>
    console.log(`[daraja-mock] listening on http://localhost:${port}`),
  );
}
