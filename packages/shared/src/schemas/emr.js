import { z } from 'zod';
import { ALLERGY_CATEGORIES, ALLERGY_SEVERITY, NOTE_TYPES } from '../enums.js';

/** @param {string[]} arr */
const e = (arr) => z.enum(/** @type {[string, ...string[]]} */ (arr));
const n = (min, max) =>
  z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? undefined : Number(v)),
    z.number().min(min).max(max).optional(),
  );
const text = (max) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => v || null);

export const vitalsBody = z
  .object({
    systolic: n(40, 300),
    diastolic: n(20, 200),
    pulse: n(20, 250),
    temperatureC: n(25, 45),
    respRate: n(4, 80),
    spo2: n(40, 100),
    weightKg: n(0.3, 400),
    heightCm: n(20, 250),
    muacCm: n(5, 50),
    painScore: n(0, 10),
    notes: text(500),
    clientId: z.string().uuid().optional(),
  })
  .refine((v) => Object.entries(v).some(([k, x]) => !['notes', 'clientId'].includes(k) && x !== undefined), {
    message: 'Record at least one measurement',
  })
  .refine((v) => (v.systolic === undefined) === (v.diastolic === undefined), {
    path: ['diastolic'],
    message: 'Enter both systolic and diastolic blood pressure',
  })
  .refine((v) => v.systolic === undefined || v.systolic > v.diastolic, {
    path: ['systolic'],
    message: 'Systolic must be higher than diastolic',
  });

export const noteBody = z
  .object({
    noteType: e(NOTE_TYPES).default('soap'),
    templateCode: z.string().max(40).optional().nullable(),
    subjective: text(8000),
    objective: text(8000),
    assessment: text(8000),
    plan: text(8000),
    /** Notes are signed on save by default; pass false to keep a draft. */
    sign: z.boolean().default(true),
    clientId: z.string().uuid().optional(),
  })
  .refine((v) => v.subjective || v.objective || v.assessment || v.plan, { message: 'The note is empty' });

export const noteUpdateBody = z.object({
  subjective: text(8000),
  objective: text(8000),
  assessment: text(8000),
  plan: text(8000),
});

export const addendumBody = z.object({ body: z.string().trim().min(2).max(4000) });

export const diagnosisBody = z.object({
  icdCode: z.string().trim().min(2).max(20),
  icdSystem: z.enum(['icd11', 'icd10']).default('icd11'),
  certainty: z.enum(['provisional', 'confirmed']).default('provisional'),
  rank: z.enum(['primary', 'secondary']).default('secondary'),
  clientId: z.string().uuid().optional(),
});

export const allergyBody = z.object({
  category: e(ALLERGY_CATEGORIES),
  allergen: z.string().trim().min(2).max(120),
  reaction: text(300),
  severity: e(ALLERGY_SEVERITY),
  clientId: z.string().uuid().optional(),
});

export const problemBody = z.object({
  icdCode: z.string().trim().max(20).optional().nullable(),
  description: z.string().trim().min(2).max(300),
  onsetDate: z.coerce.date().optional().nullable(),
});

export const problemUpdateBody = z.object({
  status: z.enum(['active', 'resolved']),
  resolvedAt: z.coerce.date().optional().nullable(),
});

export const enteredInErrorBody = z.object({ reason: z.string().trim().min(5).max(300) });

export const icdSearchQuery = z.object({
  q: z.string().trim().min(2).max(80),
  system: z.enum(['icd11', 'icd10']).default('icd11'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const timelineQuery = z.object({
  before: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});
