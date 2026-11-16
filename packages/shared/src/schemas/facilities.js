import { z } from 'zod';
import {
  BED_STATUS, DEPARTMENT_TYPES, FACILITY_LEVELS, FACILITY_OWNERSHIP, SERVICE_POINT_TYPES,
} from '../enums.js';
import { kenyanPhone } from './common.js';

/** @param {string[]} arr */
const e = (arr) => z.enum(/** @type {[string, ...string[]]} */ (arr));
const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,16}$/, '2–16 letters, digits or _');

export const facilityBody = z.object({
  name: z.string().trim().min(2).max(160),
  kmhflCode: z.string().trim().regex(/^\d{4,6}$/, 'KMHFL code is 4–6 digits'),
  level: e(FACILITY_LEVELS),
  ownership: e(FACILITY_OWNERSHIP),
  countyCode: z.string().max(3).optional().nullable(),
  subCounty: z.string().max(80).optional().nullable(),
  address: z.string().max(240).optional().nullable(),
  phone: kenyanPhone.optional().nullable(),
  email: z.string().email().max(254).optional().nullable(),
  mrnFormat: z
    .string()
    .max(60)
    .refine((v) => v.includes('{seq}'), 'MRN format must contain {seq}')
    .default('{facility_code}-{year}-{seq}'),
});
export const facilityUpdateBody = facilityBody.partial().extend({ active: z.boolean().optional() });

export const departmentBody = z.object({
  name: z.string().trim().min(2).max(120),
  code,
  type: e(DEPARTMENT_TYPES),
});
export const departmentUpdateBody = departmentBody.partial().extend({ active: z.boolean().optional() });

export const servicePointBody = z.object({
  departmentId: z.string().uuid(),
  name: z.string().trim().min(2).max(120),
  type: e(SERVICE_POINT_TYPES),
});
export const servicePointUpdateBody = servicePointBody
  .partial()
  .extend({ active: z.boolean().optional() });

export const wardBody = z.object({
  departmentId: z.string().uuid(),
  name: z.string().trim().min(2).max(120),
  code,
  gender: z.enum(['male', 'female', 'mixed']).default('mixed'),
});
export const wardUpdateBody = wardBody.partial().extend({ active: z.boolean().optional() });

export const bedBody = z.object({
  label: z.string().trim().min(1).max(20),
  status: e(BED_STATUS).default('available'),
});
export const bedStatusBody = z.object({ status: e(BED_STATUS) });
