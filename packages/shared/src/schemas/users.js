import { z } from 'zod';
import { ROLE_CODES } from '../permissions.js';
import { kenyanPhone, paginationQuery } from './common.js';

/** Practitioner licensing bodies in Kenya. */
export const LICENCE_BODIES = ['KMPDC', 'NCK', 'PPB', 'KMLTTB', 'COC', 'RPB', 'OTHER'];

export const roleAssignment = z.object({
  role: z.enum(/** @type {[string, ...string[]]} */ ([...ROLE_CODES])),
  facilityId: z.string().uuid().nullable(),
  departmentId: z.string().uuid().nullable().default(null),
});

export const createUserBody = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9._-]{3,64}$/, 'Use 3–64 letters, numbers, dots, dashes or underscores'),
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254).optional().nullable(),
  phone: kenyanPhone.optional().nullable(),
  password: z.string().min(10).max(256),
  licenceBody: z
    .enum(/** @type {[string, ...string[]]} */ (LICENCE_BODIES))
    .optional()
    .nullable(),
  licenceNumber: z.string().trim().max(40).optional().nullable(),
  cadre: z.string().trim().max(80).optional().nullable(),
  mustChangePassword: z.boolean().default(true),
  roles: z.array(roleAssignment).min(1),
});

export const updateUserBody = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  email: z.string().trim().email().max(254).optional().nullable(),
  phone: kenyanPhone.optional().nullable(),
  licenceBody: z
    .enum(/** @type {[string, ...string[]]} */ (LICENCE_BODIES))
    .optional()
    .nullable(),
  licenceNumber: z.string().trim().max(40).optional().nullable(),
  cadre: z.string().trim().max(80).optional().nullable(),
});

export const setRolesBody = z.object({ roles: z.array(roleAssignment) });

export const resetPasswordBody = z.object({ password: z.string().min(10).max(256) });

export const listUsersQuery = paginationQuery.extend({
  q: z.string().trim().max(80).optional(),
  role: z.string().max(40).optional(),
  status: z.enum(['active', 'disabled', 'all']).default('active'),
});
