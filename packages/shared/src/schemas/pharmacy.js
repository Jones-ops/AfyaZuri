import { z } from 'zod';
import { FREQUENCIES, ROUTES } from '../enums.js';
import { kenyanPhone } from './common.js';
import { quantity } from './inventory.js';

const text = (max) => z.string().trim().max(max);
const freq = z.enum(/** @type {[string, ...string[]]} */ (Object.keys(FREQUENCIES)));

export const RX_WARNING_CODES = ['ALLERGY', 'DUPLICATE', 'DOSE_HIGH', 'DOSE_LOW'];

export const prescriptionItemBody = z
  .object({
    itemId: z.string().uuid(),
    doseValue: z.number().positive().max(100000),
    doseUnit: text(20).min(1),
    route: z.enum(/** @type {[string, ...string[]]} */ (ROUTES)),
    frequency: freq,
    durationDays: z.number().int().min(1).max(365).optional().nullable(),
    /** Base units to supply; worked out from dose × frequency × days when left out. */
    quantity: quantity.optional().nullable(),
    instructions: text(300).optional().nullable(),
  })
  .refine((v) => ['STAT', 'PRN'].includes(v.frequency) || !!v.durationDays, {
    path: ['durationDays'],
    message: 'How many days?',
  });

/** A prescriber acknowledging a warning, with their reason. */
export const rxOverride = z.object({
  itemId: z.string().uuid(),
  code: z.enum(/** @type {[string, ...string[]]} */ (RX_WARNING_CODES)),
  reason: text(300).min(5),
});

export const prescriptionBody = z.object({
  items: z
    .array(prescriptionItemBody)
    .min(1)
    .max(20)
    .refine((xs) => new Set(xs.map((x) => x.itemId)).size === xs.length, 'Each drug once per prescription'),
  notes: text(500).optional().nullable(),
  overrides: z.array(rxOverride).max(60).default([]),
  clientId: z.string().uuid().optional(),
});
export const prescriptionCheckBody = prescriptionBody.pick({ items: true });

export const dispenseBody = z.object({
  storeId: z.string().uuid(),
  lines: z
    .array(
      z
        .object({
          prescriptionItemId: z.string().uuid(),
          quantity,
          substituteItemId: z.string().uuid().optional().nullable(),
          substitutionReason: text(300).optional().nullable(),
        })
        .refine((v) => !v.substituteItemId || (v.substitutionReason ?? '').length >= 5, {
          path: ['substitutionReason'],
          message: 'Say why you substituted',
        }),
    )
    .min(1)
    .max(20),
});
export const cancelRxBody = z.object({ reason: text(300).min(5) });
export const worklistQuery = z.object({
  status: z.enum(['open', 'dispensed', 'cancelled']).default('open'),
  q: text(60).optional(),
});

export const doseRuleBody = z
  .object({
    genericName: text(160).min(2),
    route: z
      .enum(/** @type {[string, ...string[]]} */ (ROUTES))
      .optional()
      .nullable(),
    minAgeMonths: z.number().int().min(0).max(1500).optional().nullable(),
    maxAgeMonths: z.number().int().min(0).max(1500).optional().nullable(),
    doseUnit: text(20).min(1).default('mg'),
    minSingleDose: z.number().positive().optional().nullable(),
    maxSingleDose: z.number().positive().optional().nullable(),
    maxDailyDose: z.number().positive().optional().nullable(),
    maxDailyPerKg: z.number().positive().optional().nullable(),
    note: text(300).optional().nullable(),
  })
  .refine((v) => v.maxSingleDose || v.maxDailyDose || v.maxDailyPerKg || v.minSingleDose, 'Set at least one limit');

// ---- Over-the-counter sales -----------------------------------------------------------------

export const otcSaleBody = z.object({
  storeId: z.string().uuid(),
  customerName: text(120).min(2),
  customerPhone: kenyanPhone.optional().nullable(),
  lines: z
    .array(z.object({ itemId: z.string().uuid(), quantity }))
    .min(1)
    .max(30)
    .refine((xs) => new Set(xs.map((x) => x.itemId)).size === xs.length, 'Each item once per sale'),
});
export const otcSalesQuery = z.object({ status: z.enum(['awaiting_payment', 'completed', 'cancelled']).optional() });
