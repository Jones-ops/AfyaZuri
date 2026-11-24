import { z } from 'zod';
import { LAB_PRIORITIES, LAB_RESULT_TYPES, LAB_SECTIONS, SPECIMEN_TYPES } from '../enums.js';

/** @param {string[]} arr */
const e = (arr) => z.enum(/** @type {[string, ...string[]]} */ (arr));
const text = (max) => z.string().trim().max(max);
const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9_-]{0,31}$/, 'Letters, digits, - or _');

export const labOrderBody = z.object({
  tests: z
    .array(z.string().uuid())
    .min(1)
    .max(30)
    .refine((xs) => new Set(xs).size === xs.length, 'Each test once'),
  priority: e(LAB_PRIORITIES).default('routine'),
  clinicalNotes: text(500).optional().nullable(),
  clientId: z.string().uuid().optional(),
});

export const reasonBody = z.object({ reason: text(300).min(3) });
export const accessionBody = z.object({ accession: text(40).min(3).toUpperCase() });
export const collectBody = z.object({ itemIds: z.array(z.string().uuid()).max(30).optional() });

export const LAB_STAGES = ['collect', 'receive', 'result', 'verify', 'done'];
export const labWorklistQuery = z.object({
  stage: e(LAB_STAGES).default('collect'),
  q: text(60).optional(),
});

const range = z
  .object({
    sex: z.enum(['male', 'female']).optional().nullable(),
    ageMinDays: z.number().int().min(0).max(60000).default(0),
    ageMaxDays: z.number().int().min(0).max(60000).optional().nullable(),
    low: z.number().optional().nullable(),
    high: z.number().optional().nullable(),
    criticalLow: z.number().optional().nullable(),
    criticalHigh: z.number().optional().nullable(),
  })
  .refine((r) => r.low == null || r.high == null || r.low <= r.high, { path: ['high'], message: 'High is below low' });

const component = z
  .object({
    code,
    name: text(120).min(1),
    resultType: e(LAB_RESULT_TYPES),
    unit: text(30).optional().nullable(),
    decimals: z.number().int().min(0).max(4).default(1),
    options: z.array(text(80).min(1)).max(20).optional().nullable(),
    abnormalOptions: z.array(text(80).min(1)).max(20).optional().nullable(),
    ranges: z.array(range).max(20).default([]),
  })
  .refine((c) => c.resultType !== 'options' || (c.options?.length ?? 0) >= 2, {
    path: ['options'],
    message: 'Give at least two answers',
  })
  .refine((c) => !c.abnormalOptions || c.abnormalOptions.every((o) => c.options?.includes(o)), {
    path: ['abnormalOptions'],
    message: 'Abnormal answers must be among the answers',
  });

export const labTestBody = z.object({
  code,
  name: text(160).min(2),
  section: e(LAB_SECTIONS),
  specimenType: e(SPECIMEN_TYPES),
  container: text(80).min(2),
  tatMinutes: z
    .number()
    .int()
    .min(5)
    .max(60 * 24 * 14)
    .default(120),
  chargeItemId: z.string().uuid().optional().nullable(),
  components: z
    .array(component)
    .min(1)
    .max(40)
    .refine((cs) => new Set(cs.map((c) => c.code)).size === cs.length, 'Component codes must differ'),
});
export const labTestUpdateBody = z.object({
  name: text(160).min(2).optional(),
  tatMinutes: z
    .number()
    .int()
    .min(5)
    .max(60 * 24 * 14)
    .optional(),
  container: text(80).min(2).optional(),
  chargeItemId: z.string().uuid().optional().nullable(),
  active: z.boolean().optional(),
});
export const labCatalogueQuery = z.object({ q: text(60).optional(), active: z.enum(['true', 'false']).optional() });
