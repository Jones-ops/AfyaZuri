import { z } from 'zod';
import { SERVICE_POINT_TYPES } from '../enums.js';

export const checkInBody = z.object({
  patientId: z.string().uuid(),
  type: z.enum(['opd', 'emergency']).default('opd'),
  /** The patient's payer-scheme link to bill against; null/omitted = cash. */
  patientPayerSchemeId: z.string().uuid().nullable().optional(),
  /** 0 routine, 1 urgent, 2 emergency. Emergency visits are always 2. */
  priority: z.coerce.number().int().min(0).max(2).default(0),
  clientId: z.string().uuid().optional(),
});

export const completeTicketBody = z.object({
  next: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('route') }),
    z.object({ kind: z.literal('service_point'), servicePointId: z.string().uuid() }),
    z.object({ kind: z.literal('exit') }),
  ]),
  note: z.string().trim().max(300).optional().nullable(),
});

export const opdRouteBody = z.object({
  /** null = the default route; otherwise a payer type such as cash, sha, private_insurer. */
  payerType: z.string().max(40).nullable(),
  steps: z
    .array(z.enum(/** @type {[string, ...string[]]} */ (SERVICE_POINT_TYPES)))
    .min(2)
    .max(12)
    .refine((s) => s[0] === 'registration', 'A route starts at registration')
    .refine((s) => s[s.length - 1] === 'exit', 'A route ends at exit'),
});

export const encountersQuery = z.object({
  status: z.enum(['open', 'closed', 'all']).default('open'),
  patientId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const closeEncounterBody = z.object({ reason: z.string().trim().max(300).optional().nullable() });
