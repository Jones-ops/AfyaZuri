import { describe, expect, it } from 'vitest';
import { formatKES, fromCents, splitLine, sumAmounts, toCents, vatIncluded } from '../src/money.js';
import { amount, mpesaStkBody, paymentBody, positiveAmount, priceListItemBody } from '../src/schemas/billing.js';

describe('cents conversion', () => {
  it.each([
    ['1500', 150000],
    ['1500.5', 150050],
    ['1500.55', 150055],
    ['0.01', 1],
    [12.5, 1250],
    [0.1 + 0.2, 30],
    ['-20.00', -2000],
  ])('%s → %i cents', (v, c) => expect(toCents(v)).toBe(c));

  it('formats back without float drift', () => {
    expect(fromCents(150055)).toBe('1500.55');
    expect(fromCents(-5)).toBe('-0.05');
    expect(sumAmounts(['0.10', '0.20', '1000.70'])).toBe('1001.00');
  });

  it('formats for display', () => {
    expect(formatKES('1234567.5')).toBe('KES 1,234,567.50');
    expect(formatKES('-200')).toBe('KES -200.00');
    expect(formatKES('900', { currency: false })).toBe('900.00');
  });
});

describe('payer / patient split', () => {
  it('handles each cover rule', () => {
    expect(splitLine({ unitPriceCents: 50000, quantity: 1, coverType: 'none' })).toEqual({
      totalCents: 50000,
      payerCents: 0,
      patientCents: 50000,
    });
    expect(splitLine({ unitPriceCents: 50000, quantity: 1, coverType: 'full' })).toEqual({
      totalCents: 50000,
      payerCents: 50000,
      patientCents: 0,
    });
    expect(splitLine({ unitPriceCents: 50000, quantity: 2, coverType: 'fixed', coverValue: '400' })).toEqual({
      totalCents: 100000,
      payerCents: 80000,
      patientCents: 20000,
    });
    expect(splitLine({ unitPriceCents: 30000, quantity: 1, coverType: 'fixed', coverValue: '400' }).payerCents).toBe(
      30000,
    ); // capped
    expect(splitLine({ unitPriceCents: 30000, quantity: 1, coverType: 'percent', coverValue: '80' })).toEqual({
      totalCents: 30000,
      payerCents: 24000,
      patientCents: 6000,
    });
  });

  it('always adds up exactly, including fractional quantities', () => {
    for (const [unit, qty, pct] of [
      [33333, 3, 80],
      [1999, 7, 33],
      [12345, 2.5, 90],
      [1, 1, 50],
    ]) {
      const s = splitLine({ unitPriceCents: unit, quantity: qty, coverType: 'percent', coverValue: String(pct) });
      expect(s.payerCents + s.patientCents).toBe(s.totalCents);
      expect(Number.isInteger(s.payerCents)).toBe(true);
    }
    expect(splitLine({ unitPriceCents: 12345, quantity: 2.5, coverType: 'none' }).totalCents).toBe(30863);
  });

  it('extracts VAT from inclusive amounts', () => {
    expect(vatIncluded(11600, 16)).toBe(1600);
    expect(vatIncluded(50000, 0)).toBe(0);
  });
});

describe('amount schemas', () => {
  it('normalises input', () => {
    expect(amount.parse('1,500')).toBe('1500.00');
    expect(amount.parse(12.5)).toBe('12.50');
  });
  it('rejects bad amounts', () => {
    for (const bad of ['abc', '-5', '1.234', '', '1e5']) expect(amount.safeParse(bad).success, bad).toBe(false);
    expect(positiveAmount.safeParse('0').success).toBe(false);
  });
  it('validates payments, M-Pesa and price rules', () => {
    expect(paymentBody.safeParse({ method: 'card', amount: '100' }).success).toBe(false); // needs a reference
    expect(paymentBody.safeParse({ method: 'cash', amount: '100', tendered: '50' }).success).toBe(false);
    expect(paymentBody.safeParse({ method: 'cash', amount: '100', tendered: '200' }).success).toBe(true);
    expect(mpesaStkBody.safeParse({ phone: '0712345678', amount: '10.50' }).success).toBe(false); // whole shillings
    expect(mpesaStkBody.parse({ phone: '0712 345 678', amount: '700' }).phone).toBe('+254712345678');
    expect(
      priceListItemBody.safeParse({
        chargeItemId: crypto.randomUUID(),
        unitPrice: '500',
        coverType: 'percent',
        coverValue: '120',
      }).success,
    ).toBe(false);
  });
});
