// Who may see a patient's clinical record.
//
// Clinical content needs emr.read at the facility. A restricted record (VIP or
// sensitive) additionally needs an active break-the-glass grant: a reason,
// time-limited, audited and queued for review. Demographics stay searchable
// for registration either way.
import { hasPermission } from '@afyazuri/shared';
import { AppError, forbidden } from '../../lib/errors.js';

/**
 * @param {import('knex').Knex} db
 * @param {import('../../middleware/auth.js').AuthContext} auth
 * @param {{id: string, is_restricted: boolean}} patient
 * @returns {Promise<{allowed: boolean, reason: 'ok'|'no_permission'|'restricted', breakGlassUntil: Date|null}>}
 */
export async function clinicalAccess(db, auth, patient) {
  if (!hasPermission(auth.grants, 'emr.read', { facilityId: auth.facilityId }))
    return { allowed: false, reason: 'no_permission', breakGlassUntil: null };
  if (!patient.is_restricted) return { allowed: true, reason: 'ok', breakGlassUntil: null };
  const grant = await db('break_glass_access')
    .where({ user_id: auth.userId, patient_id: patient.id })
    .andWhere('expires_at', '>', db.fn.now())
    .orderBy('expires_at', 'desc')
    .first('expires_at');
  return grant
    ? { allowed: true, reason: 'ok', breakGlassUntil: grant.expires_at }
    : { allowed: false, reason: 'restricted', breakGlassUntil: null };
}

/**
 * Throw unless the user may read this patient's clinical record.
 * @param {import('knex').Knex} db
 * @param {import('../../middleware/auth.js').AuthContext} auth
 * @param {{id: string, is_restricted: boolean}} patient
 */
export async function assertClinicalAccess(db, auth, patient) {
  const a = await clinicalAccess(db, auth, patient);
  if (a.reason === 'no_permission')
    throw forbidden('Your role does not include access to clinical records', { required: ['emr.read'] });
  if (a.reason === 'restricted')
    throw new AppError(
      403,
      'BREAK_GLASS_REQUIRED',
      'This record is restricted. Emergency access requires a reason and is reviewed.',
      {
        patientId: patient.id,
      },
    );
  return a;
}
