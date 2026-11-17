import { describe, expect, it } from 'vitest';
import {
  darajaTimestamp,
  parseStkCallback,
  stkPassword,
  stkStatusFor,
  toMsisdn,
} from '../../src/integrations/mpesa.js';

describe('Daraja helpers', () => {
  it('builds the timestamp in East Africa Time', () => {
    expect(darajaTimestamp(new Date('2026-11-18T21:05:09Z'))).toBe('20261119000509');
  });
  it('builds the STK password and MSISDN', () => {
    expect(Buffer.from(stkPassword('174379', 'pk', '20261118120000'), 'base64').toString()).toBe(
      '174379pk20261118120000',
    );
    expect(toMsisdn('+254712345678')).toBe('254712345678');
  });
  it('parses a successful callback', () => {
    const cb = parseStkCallback({
      Body: {
        stkCallback: {
          MerchantRequestID: 'm',
          CheckoutRequestID: 'c',
          ResultCode: 0,
          ResultDesc: 'ok',
          CallbackMetadata: {
            Item: [
              { Name: 'Amount', Value: 700 },
              { Name: 'MpesaReceiptNumber', Value: 'SAB12CD34E' },
              { Name: 'TransactionDate', Value: 20261118120000 },
              { Name: 'PhoneNumber', Value: 254712345678 },
            ],
          },
        },
      },
    });
    expect(cb).toMatchObject({
      checkoutRequestId: 'c',
      resultCode: 0,
      amount: '700',
      receipt: 'SAB12CD34E',
      phone: '+254712345678',
    });
  });
  it('parses failures and maps result codes', () => {
    const cb = parseStkCallback({
      Body: { stkCallback: { CheckoutRequestID: 'c', ResultCode: 1032, ResultDesc: 'Request cancelled by user' } },
    });
    expect(cb).toMatchObject({ resultCode: 1032, amount: null, receipt: null });
    expect([0, 1032, 1, 2001].map(stkStatusFor)).toEqual(['completed', 'cancelled', 'failed', 'failed']);
    expect(() => parseStkCallback({})).toThrow();
  });
});
