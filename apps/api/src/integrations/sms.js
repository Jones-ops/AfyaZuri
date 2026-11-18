// SMS adapter speaking Africa's Talking's bulk SMS API. The same code talks to the bundled
// mock server (deploy/mocks/sms-mock.js), the AT sandbox or production; only the base URL
// and credentials differ. Messages are never logged with their content or full number.

const BASE_URLS = {
  sandbox: 'https://api.sandbox.africastalking.com',
  production: 'https://api.africastalking.com',
  mock: 'http://localhost:4300',
};

/** "+254712345678" → "+254712…678" for logs and screens. @param {string|null|undefined} phone */
export const maskPhone = (phone) => (phone ? `${phone.slice(0, 7)}…${phone.slice(-3)}` : null);

/**
 * GSM-7 messages fit 160 characters (153 per part when split). Keep templates under one part.
 * @param {string} text
 */
export const smsParts = (text) => (text.length <= 160 ? 1 : Math.ceil(text.length / 153));

/** @typedef {{messageId: string, status: string, cost: string|null}} SmsResult */

export class AfricasTalkingAdapter {
  /** @param {import('../config.js').Config} config @param {{fetch?: typeof fetch}} [opts] */
  constructor(config, opts = {}) {
    this.mode = config.SMS_ENV;
    this.enabled = config.SMS_ENV !== 'off';
    this.baseUrl = (config.SMS_BASE_URL ?? BASE_URLS[config.SMS_ENV] ?? BASE_URLS.mock).replace(/\/$/, '');
    this.username = config.SMS_USERNAME;
    this.apiKey = config.SMS_API_KEY;
    this.senderId = config.SMS_SENDER_ID || null;
    this.fetch = opts.fetch ?? fetch;
  }

  /**
   * Send one SMS. Throws on transport errors or if the provider rejects the number.
   * @param {string} to E.164, e.g. +254712345678 @param {string} message
   * @returns {Promise<SmsResult>}
   */
  async send(to, message) {
    if (!this.enabled) throw new Error('SMS is switched off');
    if (!/^\+254\d{9}$/.test(to)) throw new Error('SMS: not a Kenyan mobile number');
    const form = new URLSearchParams({ username: this.username, to, message });
    if (this.senderId) form.set('from', this.senderId);
    let res;
    try {
      res = await this.fetch(`${this.baseUrl}/version1/messaging`, {
        method: 'POST',
        headers: {
          apiKey: this.apiKey,
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new Error(`SMS provider unreachable: ${err.message}`);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`SMS provider HTTP ${res.status}`);
    const r = body?.SMSMessageData?.Recipients?.[0];
    // 100 Processed, 101 Sent, 102 Queued are successes; anything else is a rejection.
    if (!r || ![100, 101, 102].includes(Number(r.statusCode)))
      throw new Error(`SMS rejected: ${r?.status ?? body?.SMSMessageData?.Message ?? 'no recipient'}`);
    return { messageId: r.messageId, status: r.status, cost: r.cost ?? null };
  }
}
