import { z } from 'zod';
import { LAB_PRIORITIES, MODALITIES } from '../enums.js';

const text = (max) => z.string().trim().max(max);

export const imagingOrderBody = z.object({
  studyId: z.string().uuid(),
  priority: z.enum(/** @type {[string, ...string[]]} */ (LAB_PRIORITIES)).default('routine'),
  /** Why the study is needed: required for every imaging request. */
  clinicalIndication: text(1000).min(5, 'Give the clinical indication (at least 5 characters)'),
  clientId: z.string().uuid().optional(),
});
export const scheduleBody = z.object({ scheduledFor: z.string().datetime({ offset: true }) });
export const performBody = z.object({
  techniqueNotes: text(1000).optional().nullable(),
  /** DICOM Study Instance UID from the modality, if known. */
  studyInstanceUid: z
    .string()
    .trim()
    .regex(/^[0-9]+(\.[0-9]+)*$/, 'A DICOM UID is digits separated by dots')
    .max(64)
    .optional()
    .nullable(),
});
export const reportBody = z.object({
  findings: text(10000).min(10, 'Describe the findings'),
  impression: text(2000).min(3, 'Give an impression'),
});
export const amendReportBody = reportBody.extend({ reason: text(300).min(5) });
export const IMAGING_STAGES = ['schedule', 'perform', 'report', 'done'];
export const imagingWorklistQuery = z.object({
  stage: z.enum(/** @type {[string, ...string[]]} */ (IMAGING_STAGES)).default('perform'),
  modality: z.enum(/** @type {[string, ...string[]]} */ (MODALITIES)).optional(),
});
