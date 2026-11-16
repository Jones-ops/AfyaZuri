import { z } from 'zod';
import { CONSENT_METHODS, CONSENT_TYPES, IDENTIFIER_TYPES, KIN_RELATIONSHIPS, MARITAL_STATUS, SEX } from '../enums.js';
import { kenyanPhone } from './common.js';

/** @param {string[]} arr */
const e = (arr) => z.enum(/** @type {[string, ...string[]]} */ (arr));
const name = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[\p{L}][\p{L}\p{M}' .-]*$/u, 'Letters, spaces, apostrophes and hyphens only');
const optText = (max) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => v || null);

/** Format rules per identifier type (values are normalised: trimmed, upper-cased, no spaces). */
export const IDENTIFIER_RULES = {
  national_id: { re: /^\d{6,10}$/, hint: '6–10 digits' },
  birth_certificate: { re: /^[A-Z0-9/-]{5,20}$/, hint: '5–20 letters or digits' },
  passport: { re: /^[A-Z0-9]{6,12}$/, hint: '6–12 letters or digits' },
  alien_id: { re: /^\d{6,10}$/, hint: '6–10 digits' },
  sha_number: { re: /^[A-Z0-9-]{6,20}$/, hint: '6–20 letters, digits or dashes' },
  nhif_legacy: { re: /^[A-Z0-9-]{4,20}$/, hint: '4–20 letters or digits' },
  other: { re: /^.{2,40}$/, hint: '2–40 characters' },
};

/** Normalise an identifier value the way it is stored and indexed. */
export const normaliseIdentifier = (/** @type {string} */ v) => String(v).trim().toUpperCase().replace(/\s+/g, '');

export const identifierInput = z
  .object({ type: e(IDENTIFIER_TYPES), value: z.string().min(1).max(40).transform(normaliseIdentifier) })
  .superRefine((v, ctx) => {
    const rule = IDENTIFIER_RULES[v.type];
    if (rule && !rule.re.test(v.value))
      ctx.addIssue({ code: 'custom', path: ['value'], message: `${v.type.replace(/_/g, ' ')}: ${rule.hint}` });
  });

const today = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Nairobi' }));

const demographics = {
  firstName: name,
  middleName: name
    .optional()
    .nullable()
    .or(z.literal('').transform(() => null)),
  lastName: name,
  sex: e(SEX),
  dateOfBirth: z.coerce
    .date()
    .refine((d) => d <= today(), 'Date of birth cannot be in the future')
    .refine((d) => d.getFullYear() >= today().getFullYear() - 120, 'Check the year of birth')
    .optional(),
  estimatedAge: z
    .object({
      years: z.coerce.number().int().min(0).max(120),
      months: z.coerce.number().int().min(0).max(11).default(0),
    })
    .optional(),
  phone: kenyanPhone
    .optional()
    .nullable()
    .or(z.literal('').transform(() => null)),
  email: z
    .string()
    .trim()
    .email()
    .max(254)
    .optional()
    .nullable()
    .or(z.literal('').transform(() => null)),
  countyCode: z
    .string()
    .regex(/^\d{3}$/)
    .optional()
    .nullable()
    .or(z.literal('').transform(() => null)),
  subCountyId: z.coerce.number().int().positive().optional().nullable(),
  adminWardId: z.coerce.number().int().positive().optional().nullable(),
  village: optText(120),
  occupation: optText(80),
  maritalStatus: e(MARITAL_STATUS).optional().nullable(),
  nextOfKin: z
    .object({
      name: z.string().trim().min(2).max(120),
      relationship: e(KIN_RELATIONSHIPS),
      phone: kenyanPhone
        .optional()
        .nullable()
        .or(z.literal('').transform(() => null)),
    })
    .optional()
    .nullable(),
};

export const consentInput = z.object({
  consentType: e(CONSENT_TYPES),
  granted: z.boolean(),
  method: e(CONSENT_METHODS).default('verbal'),
});

export const payerSchemeInput = z.object({
  schemeId: z.string().uuid(),
  memberNumber: z.string().trim().min(2).max(40),
  principalName: optText(120),
  relationship: optText(40),
  validFrom: z.coerce.date().optional().nullable(),
  validTo: z.coerce.date().optional().nullable(),
  isPrimary: z.boolean().default(true),
});

export const registerPatientBody = z
  .object({
    ...demographics,
    identifiers: z.array(identifierInput).max(6).default([]),
    payerScheme: payerSchemeInput.optional().nullable(),
    consents: z.array(consentInput).max(4).default([]),
    duplicateOverrideReason: z.string().trim().min(10, 'Explain in at least 10 characters').max(300).optional(),
    clientId: z.string().uuid().optional(),
  })
  .refine((v) => v.dateOfBirth || v.estimatedAge, {
    path: ['dateOfBirth'],
    message: 'Enter a date of birth or an estimated age',
  })
  .refine((v) => new Set(v.identifiers.map((i) => i.type)).size === v.identifiers.length, {
    path: ['identifiers'],
    message: 'Each identifier type can be entered once',
  });

export const updatePatientBody = z
  .object(demographics)
  .partial()
  .extend({
    identifiers: z.array(identifierInput).max(6).optional(),
  });

/** Fields used for the duplicate check before registration. */
export const duplicateCheckBody = z.object({
  firstName: z.string().trim().min(1).max(60),
  middleName: z.string().trim().max(60).optional().nullable(),
  lastName: z.string().trim().min(1).max(60),
  dateOfBirth: z.coerce.date().optional(),
  estimatedAge: demographics.estimatedAge,
  phone: demographics.phone,
  identifiers: z.array(identifierInput).max(6).default([]),
});

export const patientSearchQuery = z.object({
  q: z.string().trim().min(2, 'Type at least 2 characters').max(80),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(200).optional(),
});

export const mergePatientsBody = z
  .object({
    survivorId: z.string().uuid(),
    mergedId: z.string().uuid(),
    reason: z.string().trim().min(10).max(500),
  })
  .refine((v) => v.survivorId !== v.mergedId, { path: ['mergedId'], message: 'Choose two different patients' });

export const unmergeBody = z.object({ reason: z.string().trim().min(10).max(500) });

export const restrictBody = z.object({ restricted: z.boolean(), reason: z.string().trim().min(10).max(300) });

export const breakGlassBody = z.object({
  reason: z.string().trim().min(10, 'Give the clinical reason in at least 10 characters').max(500),
});

export const breakGlassReviewBody = z.object({ outcome: z.enum(['justified', 'unjustified']), note: optText(500) });
