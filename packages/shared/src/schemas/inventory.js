import { z } from 'zod';
import { DRUG_FORMS, INVENTORY_CATEGORIES, STORE_TYPES } from '../enums.js';
import { kenyanPhone } from './common.js';

/** @param {string[]} arr */
const e = (arr) => z.enum(/** @type {[string, ...string[]]} */ (arr));

/** Quantities are counted in thousandths of a base unit, so arithmetic is exact (e.g. 2.5 ml). */
export const toMilli = (q) => Math.round(Number(q) * 1000);
export const fromMilli = (m) => (Math.round(m) / 1000).toFixed(3).replace(/\.?0+$/, '');

/** A quantity in base units: > 0, at most three decimals. */
export const quantity = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
  if (!Number.isFinite(n) || n <= 0 || n > 1e9 || Math.abs(n * 1000 - Math.round(n * 1000)) > 1e-6) {
    ctx.addIssue({ code: 'custom', message: 'Enter a quantity above zero (up to 3 decimals)' });
    return z.NEVER;
  }
  return Number(n.toFixed(3));
});
/** Like quantity, but zero is allowed (counts, reorder levels). */
export const count = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
  if (!Number.isFinite(n) || n < 0 || n > 1e9 || Math.abs(n * 1000 - Math.round(n * 1000)) > 1e-6) {
    ctx.addIssue({ code: 'custom', message: 'Enter zero or more (up to 3 decimals)' });
    return z.NEVER;
  }
  return Number(n.toFixed(3));
});
/** Cost per base unit in KES, up to 4 decimals (a tablet can cost KES 0.35). */
export const unitCost = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const s = typeof v === 'number' ? String(v) : v.replace(/,/g, '').trim();
  if (!/^\d{1,10}(\.\d{1,4})?$/.test(s)) {
    ctx.addIssue({ code: 'custom', message: 'Enter a cost in KES, e.g. 12.50' });
    return z.NEVER;
  }
  return Number(s).toFixed(4);
});

const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9_-]{1,31}$/, '2–32 letters, digits, - or _');
const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((v) => new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), 'Not a real date');
const text = (max) => z.string().trim().max(max);

// ---- Stores, items, suppliers --------------------------------------------------------

export const storeBody = z.object({
  code,
  name: text(120).min(2),
  type: e(STORE_TYPES),
  departmentId: z.string().uuid(),
  dispensing: z.boolean().default(false),
});
export const storeUpdateBody = storeBody.partial().extend({ active: z.boolean().optional() });

export const drugBody = z.object({
  genericName: text(160).min(2),
  brandName: text(160).optional().nullable(),
  form: e(DRUG_FORMS),
  strength: text(60).optional().nullable(),
  strengthValue: z.number().positive().max(1e6).optional().nullable(),
  strengthUnit: text(20).optional().nullable(),
  defaultRoute: text(40).optional().nullable(),
  keml: z.boolean().default(false),
  atcCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]\d{2}[A-Z]{0,2}\d{0,2}$/, 'ATC code looks like J01CA04')
    .optional()
    .nullable(),
  controlled: z.boolean().default(false),
});

export const packSizeBody = z.object({ name: text(60).min(1), baseQty: quantity });

export const itemBody = z
  .object({
    code,
    name: text(200).min(2),
    category: e(INVENTORY_CATEGORIES),
    baseUnit: text(30).min(1),
    chargeItemId: z.string().uuid().optional().nullable(),
    drug: drugBody.optional().nullable(),
    packSizes: z.array(packSizeBody).max(10).default([]),
  })
  .refine((v) => v.category !== 'drug' || !!v.drug, { path: ['drug'], message: 'Enter the drug details' });
export const itemUpdateBody = z.object({
  name: text(200).min(2).optional(),
  baseUnit: text(30).min(1).optional(),
  chargeItemId: z.string().uuid().optional().nullable(),
  drug: drugBody.partial().optional(),
  active: z.boolean().optional(),
});
export const itemsQuery = z.object({
  q: text(80).optional(),
  category: e(INVENTORY_CATEGORIES).optional(),
  active: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const supplierBody = z.object({
  name: text(160).min(2),
  kraPin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[AP]\d{9}[A-Z]$/, 'KRA PIN looks like P051234567X')
    .optional()
    .nullable(),
  phone: kenyanPhone.optional().nullable(),
  email: z.string().email().max(254).optional().nullable(),
  address: text(240).optional().nullable(),
});
export const supplierUpdateBody = supplierBody.partial().extend({ active: z.boolean().optional() });

export const reorderBody = z
  .object({ reorderLevel: count, reorderQty: quantity, maxLevel: count.optional().nullable() })
  .refine((v) => v.maxLevel == null || v.maxLevel >= v.reorderLevel, {
    path: ['maxLevel'],
    message: 'The maximum must be at least the reorder level',
  });

// ---- Purchasing --------------------------------------------------------------------------

export const purchaseOrderBody = z.object({
  supplierId: z.string().uuid(),
  storeId: z.string().uuid(),
  expectedDate: ymd.optional().nullable(),
  notes: text(500).optional().nullable(),
  lines: z
    .array(z.object({ itemId: z.string().uuid(), quantity, unitCost }))
    .min(1)
    .max(200)
    .refine((ls) => new Set(ls.map((l) => l.itemId)).size === ls.length, 'Each item once per order'),
});

export const grnBody = z.object({
  storeId: z.string().uuid(),
  supplierId: z.string().uuid(),
  poId: z.string().uuid().optional().nullable(),
  deliveryNote: text(60).optional().nullable(),
  invoiceRef: text(60).optional().nullable(),
  notes: text(500).optional().nullable(),
  lines: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        batchNumber: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z0-9][A-Z0-9/._-]{0,39}$/, 'Batch numbers use letters, digits and / . _ -'),
        expiryDate: ymd,
        /** Quantity in packs when packSizeId is given, otherwise in base units. */
        quantity,
        packSizeId: z.string().uuid().optional().nullable(),
        /** Cost per pack when packSizeId is given, otherwise per base unit. */
        unitCost,
      }),
    )
    .min(1)
    .max(200),
});

export const movementsQuery = z.object({
  storeId: z.string().uuid().optional(),
  itemId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.coerce.number().int().positive().optional(),
});
export const stockQuery = z.object({
  q: text(80).optional(),
  status: z.enum(['all', 'low', 'out', 'expiring']).default('all'),
});

// ---- Requisitions -------------------------------------------------------------------------

const uniqueItems = (ls) => new Set(ls.map((l) => l.itemId)).size === ls.length;

export const requisitionBody = z
  .object({
    fromStoreId: z.string().uuid(),
    toStoreId: z.string().uuid(),
    notes: text(500).optional().nullable(),
    lines: z
      .array(z.object({ itemId: z.string().uuid(), quantity }))
      .min(1)
      .max(100)
      .refine(uniqueItems, 'Each item once per requisition'),
  })
  .refine((v) => v.fromStoreId !== v.toStoreId, { path: ['toStoreId'], message: 'Choose a different store' });

/** The approver may cut quantities (never raise them); omitted lines keep the requested quantity. */
export const requisitionDecisionBody = z.object({
  approve: z.boolean(),
  note: text(300).optional().nullable(),
  lines: z
    .array(z.object({ itemId: z.string().uuid(), approvedQty: count }))
    .max(100)
    .default([]),
});

export const requisitionReceiveBody = z.object({
  lines: z
    .array(
      z.object({
        issueLineId: z.string().uuid(),
        receivedQty: count,
        varianceReason: text(300).optional().nullable(),
      }),
    )
    .min(1)
    .max(500),
});

export const requisitionsQuery = z.object({
  status: z.enum(['requested', 'approved', 'issued', 'received', 'rejected', 'cancelled']).optional(),
  storeId: z.string().uuid().optional(),
});

// ---- Stock takes and write-offs ---------------------------------------------------------------

export const stockTakeBody = z.object({ storeId: z.string().uuid(), notes: text(500).optional().nullable() });
export const stockCountBody = z.object({
  lines: z
    .array(z.object({ lineId: z.string().uuid(), countedQty: count, reason: text(300).optional().nullable() }))
    .min(1)
    .max(2000),
});
export const stockTakeDecisionBody = z.object({ approve: z.boolean(), note: text(300).optional().nullable() });
export const expiryWriteoffBody = z.object({ batchId: z.string().uuid(), reason: text(300).min(5) });

// ---- Reports ----------------------------------------------------------------------------------

export const consumptionQuery = z
  .object({
    from: ymd,
    to: ymd,
    storeId: z.string().uuid().optional(),
    format: z.enum(['json', 'csv']).default('json'),
  })
  .refine((v) => v.from <= v.to, { path: ['to'], message: 'The end date is before the start date' })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 366, {
    path: ['to'],
    message: 'Choose at most one year',
  });
export const valuationQuery = z.object({
  storeId: z.string().uuid().optional(),
  format: z.enum(['json', 'csv']).default('json'),
});
