import { z } from 'zod';
import { CHARGE_CATEGORIES, COVER_TYPES, PAYMENT_METHODS } from '../enums.js';
import { fromCents, toCents } from '../money.js';
import { kenyanPhone } from './common.js';

/** @param {string[]} arr */
const e = (arr) => z.enum(/** @type {[string, ...string[]]} */ (arr));

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;
const MAX_CENTS = 99_999_999_999;
/** @param {{min?: number}} [o] min in cents */
const makeAmount = ({ min = 0 } = {}) =>
  z.union([z.string(), z.number()]).transform((v, ctx) => {
    const s = typeof v === 'number' ? (Number.isFinite(v) && v >= 0 ? v.toFixed(2) : '') : v.replace(/,/g, '').trim();
    if (!AMOUNT_RE.test(s)) {
      ctx.addIssue({ code: 'custom', message: 'Enter an amount in KES, e.g. 1500 or 1500.50' });
      return z.NEVER;
    }
    const cents = toCents(s);
    if (cents > MAX_CENTS) {
      ctx.addIssue({ code: 'custom', message: 'Amount is too large' });
      return z.NEVER;
    }
    if (cents < min) {
      ctx.addIssue({ code: 'custom', message: 'Amount must be more than zero' });
      return z.NEVER;
    }
    return fromCents(cents);
  });

/** A KES amount ≥ 0 given as "1500", "1,500.50" or 1500 → normalised "1500.00". */
export const amount = makeAmount();
/** A KES amount > 0. */
export const positiveAmount = makeAmount({ min: 1 });
const isAmount = (v) => typeof v === 'string';

const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9_-]{1,31}$/, '2–32 letters, digits, - or _');

export const chargeItemBody = z.object({
  code,
  name: z.string().trim().min(2).max(160),
  category: e(CHARGE_CATEGORIES),
  departmentId: z.string().uuid().nullable().optional(),
  unit: z.string().trim().min(1).max(30).default('each'),
  vatRate: z.coerce.number().min(0).max(100).default(0),
  tariffCode: z.string().trim().max(40).nullable().optional(),
});
export const chargeItemUpdateBody = chargeItemBody.partial().extend({ active: z.boolean().optional() });

export const priceListBody = z
  .object({
    code,
    name: z.string().trim().min(2).max(120),
    /** null = the facility's cash price list. */
    schemeId: z.string().uuid().nullable().default(null),
    isDefault: z.boolean().default(false),
    validFrom: z.coerce.date().nullable().optional(),
    validTo: z.coerce.date().nullable().optional(),
  })
  .refine((v) => !v.isDefault || v.schemeId === null, {
    path: ['isDefault'],
    message: 'Only the cash price list can be the default',
  });
export const priceListUpdateBody = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  active: z.boolean().optional(),
  validFrom: z.coerce.date().nullable().optional(),
  validTo: z.coerce.date().nullable().optional(),
});

export const priceListItemBody = z
  .object({
    chargeItemId: z.string().uuid(),
    unitPrice: amount,
    coverType: e(COVER_TYPES).default('none'),
    coverValue: amount.default('0.00'),
    requiresPreauth: z.boolean().default(false),
  })
  .refine((v) => v.coverType !== 'percent' || !isAmount(v.coverValue) || toCents(v.coverValue) <= 10000, {
    path: ['coverValue'],
    message: 'A percentage cannot exceed 100',
  });

export const manualChargeBody = z.object({
  chargeItemId: z.string().uuid(),
  quantity: z.coerce.number().positive().max(100000).default(1),
  /** Only for items with no price on the applicable list (e.g. a miscellaneous charge). */
  unitPrice: amount.optional(),
  description: z.string().trim().max(200).optional(),
});

export const voidItemBody = z.object({ reason: z.string().trim().min(5).max(300) });

export const billsQuery = z.object({
  status: z.enum(['open', 'final', 'closed', 'cancelled', 'outstanding', 'all']).default('outstanding'),
  patientId: z.string().uuid().optional(),
  encounterId: z.string().uuid().optional(),
  q: z.string().trim().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});

// ---- Payments ----------------------------------------------------------------

export const openShiftBody = z.object({ openingFloat: amount.default('0.00') });

const declared = z.object(Object.fromEntries(PAYMENT_METHODS.map((m) => [m, amount.default('0.00')])));
export const closeShiftBody = z.object({ declared, notes: z.string().trim().max(500).optional().nullable() });

export const paymentBody = z
  .object({
    method: e(PAYMENT_METHODS.filter((m) => m !== 'mpesa')),
    amount: positiveAmount,
    /** Card authorisation code, bank slip number, etc. Required for card and bank. */
    reference: z.string().trim().max(60).optional().nullable(),
    /** Cash only: what the patient handed over, to show change due. */
    tendered: amount.optional(),
    notes: z.string().trim().max(300).optional().nullable(),
    clientId: z.string().uuid().optional(),
  })
  .refine((v) => v.method === 'cash' || !!v.reference, {
    path: ['reference'],
    message: 'Enter the card or bank reference',
  })
  .refine((v) => !v.tendered || !isAmount(v.amount) || toCents(v.tendered) >= toCents(v.amount), {
    path: ['tendered'],
    message: 'Tendered is less than the amount',
  });

export const mpesaStkBody = z.object({
  phone: kenyanPhone,
  amount: positiveAmount.refine((v) => !isAmount(v) || toCents(v) % 100 === 0, 'M-Pesa amounts are whole shillings'),
});

export const waiverBody = z.object({ amount: positiveAmount, reason: z.string().trim().min(10).max(500) });
export const refundBody = z
  .object({
    kind: z.enum(['refund', 'credit_note']),
    amount: positiveAmount,
    reason: z.string().trim().min(10).max(500),
    paymentId: z.string().uuid().optional(),
  })
  .refine((v) => v.kind === 'credit_note' || !!v.paymentId, {
    path: ['paymentId'],
    message: 'Choose the payment to refund',
  });
export const decisionBody = z.object({ approve: z.boolean(), note: z.string().trim().max(300).optional().nullable() });
export const payRefundBody = z.object({
  method: e(PAYMENT_METHODS),
  reference: z.string().trim().max(60).optional().nullable(),
});

export const reportRangeQuery = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  format: z.enum(['json', 'csv']).default('json'),
});
