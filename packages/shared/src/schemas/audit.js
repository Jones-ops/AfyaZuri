import { z } from 'zod';
import { AUDIT_ACTIONS } from '../enums.js';
import { paginationQuery } from './common.js';

export const auditQuery = paginationQuery.extend({
  userId: z.string().uuid().optional(),
  patientId: z.string().uuid().optional(),
  action: z.enum(/** @type {[string, ...string[]]} */ (AUDIT_ACTIONS)).optional(),
  entityType: z.string().max(60).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
