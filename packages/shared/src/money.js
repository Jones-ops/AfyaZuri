/**
 * Money helpers. Amounts travel as decimal strings ("1500.00", as Postgres numeric
 * returns them) and are calculated in integer cents, so no floating-point rounding
 * ever touches a balance. Currency is KES.
 */

/**
 * Parse an amount (string or number) to integer cents.
 * @param {string|number|null|undefined} v
 * @returns {number}
 */
export function toCents(v) {
  if (v === null || v === undefined || v === '') return 0;
  const s = typeof v === 'number' ? v.toFixed(2) : String(v).trim();
  const m = /^(-)?(\d+)(?:\.(\d{1,2})\d*)?$/.exec(s);
  if (!m) throw new Error(`Not an amount: ${v}`);
  const cents = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -cents : cents;
}

/** Integer cents → "1234.50". @param {number} cents */
export function fromCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const a = Math.abs(Math.round(cents));
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

/** Sum amounts. @param {Array<string|number|null|undefined>} xs */
export const sumAmounts = (xs) => fromCents(xs.reduce((s, x) => s + toCents(x), 0));

/**
 * "KES 1,234.50" for display. @param {string|number|null|undefined} v
 * @param {{currency?: boolean}} [opts]
 */
export function formatKES(v, opts = {}) {
  const cents = toCents(v ?? 0);
  const sign = cents < 0 ? '-' : '';
  const a = Math.abs(cents);
  const whole = String(Math.floor(a / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = `${sign}${whole}.${String(a % 100).padStart(2, '0')}`;
  return opts.currency === false ? body : `KES ${body}`;
}

/**
 * Split a bill line between payer and patient.
 * @param {{unitPriceCents: number, quantity: number, coverType: 'none'|'full'|'fixed'|'percent', coverValue?: string|number}} p
 *   coverValue: KES per unit for 'fixed', a percentage for 'percent'.
 * @returns {{totalCents: number, payerCents: number, patientCents: number}}
 */
export function splitLine({ unitPriceCents, quantity, coverType, coverValue = 0 }) {
  const qtyHundredths = Math.round(Number(quantity) * 100);
  const totalCents = Math.round((unitPriceCents * qtyHundredths) / 100);
  let payerCents = 0;
  if (coverType === 'full') payerCents = totalCents;
  else if (coverType === 'fixed')
    payerCents = Math.min(totalCents, Math.round((toCents(coverValue) * qtyHundredths) / 100));
  else if (coverType === 'percent') payerCents = Math.round((totalCents * Math.min(100, Number(coverValue))) / 100);
  return { totalCents, payerCents, patientCents: totalCents - payerCents };
}

/** VAT contained in a VAT-inclusive amount. @param {number} grossCents @param {number|string} rate percent */
export const vatIncluded = (grossCents, rate) =>
  Number(rate) > 0 ? Math.round((grossCents * Number(rate)) / (100 + Number(rate))) : 0;
