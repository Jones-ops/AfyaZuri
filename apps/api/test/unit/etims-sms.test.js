import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSmsMock } from '../../../../deploy/mocks/sms-mock.js';
import { MockEtimsAdapter, checkDocument, taxCategory } from '../../src/integrations/etims.js';
import { AfricasTalkingAdapter, maskPhone, smsParts } from '../../src/integrations/sms.js';
import { TEMPLATES } from '../../src/modules/notifications/sms.js';

const doc = (over = {}) => ({
  kind: 'sale',
  documentNumber: 'RCT-2026-000001',
  issuedAt: '2026-11-18T08:00:00.000Z',
  seller: { name: 'Demo Hospital', kmhflCode: '99001', kraPin: 'P051234567X' },
  buyer: { name: 'Achieng Otieno' },
  lines: [
    { description: 'Consultation', quantity: 1, unitPrice: '500.00', amount: '500.00', vatRate: 0 },
    { description: 'Bottled water', quantity: 1, unitPrice: '116.00', amount: '116.00', vatRate: 16 },
  ],
  total: '616.00',
  ...over,
});

describe('eTIMS', () => {
  it('maps VAT rates to KRA tax categories', () => {
    expect([taxCategory(0), taxCategory(16), taxCategory(8)]).toEqual(['E', 'B', 'Z']);
  });

  it('validates documents and summarises tax', () => {
    expect(checkDocument(doc())).toEqual({ E: '500.00', B: '116.00' });
    expect(() => checkDocument(doc({ total: '600.00' }))).toThrow(/add up/);
    expect(() => checkDocument(doc({ lines: [] }))).toThrow(/at least one line/);
    expect(() => checkDocument(doc({ kind: 'credit_note' }))).toThrow(/original invoice/);
  });

  it('mock returns the same invoice number when a document is retried', async () => {
    const etims = new MockEtimsAdapter({ failNext: 1 });
    await expect(etims.submit(doc())).rejects.toThrow(/unavailable/);
    const a = await etims.submit(doc());
    const b = await etims.submit(doc());
    expect(a.invoiceNumber).toMatch(/^KRACU[0-9A-F]{10}\/\d{8}$/);
    expect(b.invoiceNumber).toBe(a.invoiceNumber);
    expect(a.verifyUrl).toBeNull();
    const other = await etims.submit(doc({ documentNumber: 'RCT-2026-000002' }));
    expect(other.invoiceNumber).not.toBe(a.invoiceNumber);
  });
});

describe('SMS', () => {
  let server;
  let mock;
  let sms;
  beforeAll(async () => {
    mock = createSmsMock();
    server = await new Promise((ok) => {
      const s = createServer(mock).listen(0, '127.0.0.1', () => ok(s));
    });
    sms = new AfricasTalkingAdapter({
      SMS_ENV: 'mock',
      SMS_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      SMS_USERNAME: 'sandbox',
      SMS_API_KEY: 'k',
      SMS_SENDER_ID: '',
    });
  });
  afterAll(() => new Promise((r) => server.close(r)));

  it("sends through Africa's Talking's protocol", async () => {
    const r = await sms.send('+254712000111', 'Habari');
    expect(r.messageId).toMatch(/^ATXid_/);
    expect(mock.messages.at(-1)).toMatchObject({ to: '+254712000111', message: 'Habari' });
  });

  it('surfaces rejected numbers and refuses non-Kenyan ones', async () => {
    await expect(sms.send('+254712000404', 'x')).rejects.toThrow(/InvalidPhoneNumber/);
    await expect(sms.send('+447700900123', 'x')).rejects.toThrow(/Kenyan/);
  });

  it('masks numbers and counts parts', () => {
    expect(maskPhone('+254712345678')).toBe('+254712…678');
    expect(smsParts('a'.repeat(160))).toBe(1);
    expect(smsParts('a'.repeat(161))).toBe(2);
  });

  it('keeps every template to one SMS, in Kiswahili and English', () => {
    const facility = 'Afyazuri Demo County Referral H…'; // the longest a facility name is allowed to be
    for (const [name, t] of Object.entries(TEMPLATES))
      for (const lang of ['sw', 'en']) {
        const text = t[lang]({
          facility,
          amount: '125000.50',
          balance: '99999.99',
          method: 'mpesa',
          receipt: 'RCT-2026-000123',
          document: 'RFD-2026-000123',
        });
        expect(text.length, `${name}/${lang}: ${text}`).toBeLessThanOrEqual(160);
      }
    expect(
      TEMPLATES.payment_received.sw({ facility: 'X', amount: '700', balance: '0', method: 'cash', receipt: 'R1' }),
    ).toBe('X: Tumepokea KES 700 kwa pesa taslimu. Stakabadhi R1. Salio KES 0. Asante, pona haraka.');
  });
});
