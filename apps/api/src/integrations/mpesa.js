// M-Pesa Daraja adapter: STK Push (Lipa na M-Pesa Online), STK status query and
// C2B URL registration. The same code talks to the bundled mock server, the
// Safaricom sandbox or production; only the base URL and credentials differ.

const BASE_URLS = {
  sandbox: 'https://sandbox.safaricom.co.ke',
  production: 'https://api.safaricom.co.ke',
  mock: 'http://localhost:4300',
};

/** Daraja timestamp yyyyMMddHHmmss in East Africa Time. @param {Date} [d] */
export function darajaTimestamp(d = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Nairobi',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}${p.month}${p.day}${p.hour === '24' ? '00' : p.hour}${p.minute}${p.second}`;
}

/** STK password = base64(shortcode + passkey + timestamp). */
export const stkPassword = (shortcode, passkey, timestamp) =>
  Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

/** "+254712345678" → "254712345678" (Daraja's MSISDN format). @param {string} phone */
export const toMsisdn = (phone) => phone.replace(/^\+/, '');

/**
 * Pull the useful fields out of an STK callback body.
 * @param {any} body `{ Body: { stkCallback: {...} } }`
 * @returns {{merchantRequestId: string, checkoutRequestId: string, resultCode: number, resultDesc: string,
 *            amount: string|null, receipt: string|null, phone: string|null, transactionDate: string|null}}
 */
export function parseStkCallback(body) {
  const cb = body?.Body?.stkCallback;
  if (!cb?.CheckoutRequestID) throw new Error('Not an STK callback');
  const items = Object.fromEntries((cb.CallbackMetadata?.Item ?? []).map((i) => [i.Name, i.Value]));
  return {
    merchantRequestId: cb.MerchantRequestID,
    checkoutRequestId: cb.CheckoutRequestID,
    resultCode: Number(cb.ResultCode),
    resultDesc: cb.ResultDesc ?? '',
    amount: items.Amount !== undefined ? String(items.Amount) : null,
    receipt: items.MpesaReceiptNumber ?? null,
    phone: items.PhoneNumber !== undefined ? `+${items.PhoneNumber}` : null,
    transactionDate: items.TransactionDate !== undefined ? String(items.TransactionDate) : null,
  };
}

/** Daraja result codes → our transaction status. 0 = paid; 1032 = cancelled by the customer. */
export const stkStatusFor = (code) => (code === 0 ? 'completed' : code === 1032 ? 'cancelled' : 'failed');

export class DarajaAdapter {
  /** @param {import('../config.js').Config} config @param {{fetch?: typeof fetch}} [opts] */
  constructor(config, opts = {}) {
    this.config = config;
    this.baseUrl = (config.MPESA_BASE_URL ?? BASE_URLS[config.MPESA_ENV]).replace(/\/$/, '');
    this.fetch = opts.fetch ?? fetch;
    this.token = null;
    this.tokenExpires = 0;
  }

  callbackUrl(kind) {
    return `${this.config.MPESA_CALLBACK_BASE_URL.replace(/\/$/, '')}/api/v1/integrations/mpesa/${this.config.MPESA_CALLBACK_TOKEN}/${kind}`;
  }

  async request(path, init) {
    let res;
    try {
      res = await this.fetch(`${this.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      const e = new Error(`M-Pesa is unreachable: ${err.message}`);
      e.code = 'MPESA_UNREACHABLE';
      throw e;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data.errorMessage ?? data.ResponseDescription ?? `M-Pesa error ${res.status}`);
      e.code = 'MPESA_REJECTED';
      e.details = data;
      throw e;
    }
    return data;
  }

  async accessToken() {
    if (this.token && Date.now() < this.tokenExpires) return this.token;
    const basic = Buffer.from(`${this.config.MPESA_CONSUMER_KEY}:${this.config.MPESA_CONSUMER_SECRET}`).toString(
      'base64',
    );
    const data = await this.request('/oauth/v1/generate?grant_type=client_credentials', {
      headers: { Authorization: `Basic ${basic}` },
    });
    this.token = data.access_token;
    this.tokenExpires = Date.now() + (Number(data.expires_in ?? 3599) - 60) * 1000;
    return this.token;
  }

  async post(path, body) {
    return this.request(path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /**
   * Send an STK Push prompt to the customer's phone.
   * @param {{phone: string, amount: string, accountReference: string, description: string}} p
   * @returns {Promise<{merchantRequestId: string, checkoutRequestId: string, customerMessage: string}>}
   */
  async stkPush({ phone, amount, accountReference, description }) {
    const timestamp = darajaTimestamp();
    const { MPESA_SHORTCODE: shortcode, MPESA_PASSKEY: passkey } = this.config;
    const data = await this.post('/mpesa/stkpush/v1/processrequest', {
      BusinessShortCode: shortcode,
      Password: stkPassword(shortcode, passkey, timestamp),
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.round(Number(amount)),
      PartyA: toMsisdn(phone),
      PartyB: shortcode,
      PhoneNumber: toMsisdn(phone),
      CallBackURL: this.callbackUrl('stk-callback'),
      AccountReference: accountReference.slice(0, 12),
      TransactionDesc: description.slice(0, 13),
    });
    if (String(data.ResponseCode) !== '0') {
      const e = new Error(data.ResponseDescription ?? 'M-Pesa declined the request');
      e.code = 'MPESA_REJECTED';
      throw e;
    }
    return {
      merchantRequestId: data.MerchantRequestID,
      checkoutRequestId: data.CheckoutRequestID,
      customerMessage: data.CustomerMessage,
    };
  }

  /** Ask Daraja for an STK request's outcome (used when a callback never arrives). */
  async queryStk(checkoutRequestId) {
    const timestamp = darajaTimestamp();
    const { MPESA_SHORTCODE: shortcode, MPESA_PASSKEY: passkey } = this.config;
    const data = await this.post('/mpesa/stkpushquery/v1/query', {
      BusinessShortCode: shortcode,
      Password: stkPassword(shortcode, passkey, timestamp),
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    });
    return {
      resultCode: data.ResultCode === undefined ? null : Number(data.ResultCode),
      resultDesc: data.ResultDesc ?? '',
    };
  }

  /** Register the C2B (Paybill) confirmation and validation URLs. */
  async registerC2bUrls() {
    return this.post('/mpesa/c2b/v1/registerurl', {
      ShortCode: this.config.MPESA_SHORTCODE,
      ResponseType: 'Completed',
      ConfirmationURL: this.callbackUrl('c2b-confirmation'),
      ValidationURL: this.callbackUrl('c2b-validation'),
    });
  }
}
