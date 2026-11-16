import { hasGlobalPermission, hasPermission } from '@afyazuri/shared';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { camel, snake } from '../../lib/case.js';
import { recordAudit } from '../audit/service.js';
import { accessibleFacilities } from '../auth/repository.js';

/**
 * Facility setup. Everything except creating facilities operates on the
 * session's active facility, so one facility's admin can never read or change
 * another's departments, wards or beds.
 * @typedef {import('../../middleware/auth.js').AuthContext} AuthContext
 * @typedef {{ip?: string|null, userAgent?: string|null, requestId?: string|null}} Meta
 * @typedef {{db: import('knex').Knex, bus: import('../../lib/events.js').EventBus}} Deps
 */

const actorOf = (/** @type {AuthContext} */ a) => ({
  userId: a.userId,
  username: a.username,
  roles: a.roles,
  facilityId: a.facilityId,
});

/**
 * Insert a row with audit columns and an audit entry, in one transaction.
 * @param {Deps} deps @param {AuthContext} auth @param {Meta} meta
 * @param {string} table @param {string} entityType @param {Record<string, any>} values
 */
async function auditedInsert({ db }, auth, meta, table, entityType, values) {
  return db.transaction(async (trx) => {
    const [row] = await trx(table)
      .insert({ ...values, created_by: auth.userId, updated_by: auth.userId })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'create',
      entityType,
      entityId: row.id,
      after: row,
      facilityId: row.facility_id ?? (table === 'facilities' ? row.id : auth.facilityId),
    });
    return row;
  });
}

/**
 * Update a facility-scoped row and audit the diff. Throws 404 when the row
 * isn't in the actor's facility.
 * @param {Deps} deps @param {AuthContext} auth @param {Meta} meta
 * @param {string} table @param {string} entityType @param {string} id @param {Record<string, any>} patch
 */
async function auditedUpdate({ db }, auth, meta, table, entityType, id, patch) {
  return db.transaction(async (trx) => {
    const before = await trx(table).where({ id, facility_id: auth.facilityId }).forUpdate().first();
    if (!before) throw notFound(entityType.replace(/_/g, ' '));
    if (!Object.keys(patch).length) return before;
    const [after] = await trx(table)
      .where({ id })
      .update({ ...patch, updated_by: auth.userId })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, { action: 'update', entityType, entityId: id, before, after });
    return after;
  });
}

/** @param {import('knex').Knex} db @param {AuthContext} auth @param {string|undefined} departmentId */
async function assertDepartment(db, auth, departmentId) {
  if (!departmentId) return;
  const d = await db('departments').where({ id: departmentId, facility_id: auth.facilityId }).first('id');
  if (!d) throw badRequest('Department not found in this facility');
}

// ---- Facilities -------------------------------------------------------------

const facilityOut = (f) => camel(f, ['created_by', 'updated_by']);

/** @param {Deps} deps @param {AuthContext} auth */
export async function listFacilities({ db }, auth) {
  const ids = (await accessibleFacilities(db, auth.grants)).map((f) => f.id);
  if (!ids.length) return [];
  const rows = await db('facilities').whereIn('id', ids).orderBy('name');
  return rows.map(facilityOut);
}

/** @param {Deps} deps @param {AuthContext} auth */
export async function currentFacility({ db }, auth) {
  return facilityOut(await db('facilities').where({ id: auth.facilityId }).first());
}

/** @param {Deps} deps @param {AuthContext} auth @param {Record<string, any>} input @param {Meta} meta */
export async function createFacility(deps, auth, input, meta) {
  if (!hasGlobalPermission(auth.grants, 'facilities.manage'))
    throw forbidden('Only a deployment administrator can add facilities');
  const row = await auditedInsert(deps, auth, meta, 'facilities', 'facility', snake(input));
  await deps.bus.publish(deps.db, {
    type: 'facility.created',
    aggregateType: 'facility',
    aggregateId: row.id,
    facilityId: row.id,
    payload: { name: row.name },
  });
  return facilityOut(row);
}

/** @param {Deps} deps @param {AuthContext} auth @param {string} id @param {Record<string, any>} input @param {Meta} meta */
export async function updateFacility({ db }, auth, id, input, meta) {
  const global = hasGlobalPermission(auth.grants, 'facilities.manage');
  if (!global && id !== auth.facilityId) throw notFound('Facility');
  return db.transaction(async (trx) => {
    const before = await trx('facilities').where({ id }).forUpdate().first();
    if (!before) throw notFound('Facility');
    const [after] = await trx('facilities')
      .where({ id })
      .update({ ...snake(input), updated_by: auth.userId })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'facility',
      entityId: id,
      before,
      after,
      facilityId: id,
    });
    return facilityOut(after);
  });
}

// ---- Departments -----------------------------------------------------------

/** @param {Deps} deps @param {AuthContext} auth */
export async function listDepartments({ db }, auth) {
  return (await db('departments').where({ facility_id: auth.facilityId }).orderBy('name')).map((r) => camel(r));
}
/** @param {Deps} deps @param {AuthContext} auth @param {Record<string, any>} input @param {Meta} meta */
export const createDepartment = async (deps, auth, input, meta) =>
  camel(
    await auditedInsert(deps, auth, meta, 'departments', 'department', {
      ...snake(input),
      facility_id: auth.facilityId,
    }),
  );
/** @param {Deps} deps @param {AuthContext} auth @param {string} id @param {Record<string, any>} input @param {Meta} meta */
export const updateDepartment = async (deps, auth, id, input, meta) =>
  camel(await auditedUpdate(deps, auth, meta, 'departments', 'department', id, snake(input)));

// ---- Service points --------------------------------------------------------

/** @param {Deps} deps @param {AuthContext} auth */
export async function listServicePoints({ db }, auth) {
  const rows = await db('service_points as sp')
    .join('departments as d', 'd.id', 'sp.department_id')
    .where('sp.facility_id', auth.facilityId)
    .orderBy('sp.name')
    .select('sp.*', 'd.name as department_name');
  return rows.map((r) => camel(r));
}
/** @param {Deps} deps @param {AuthContext} auth @param {Record<string, any>} input @param {Meta} meta */
export async function createServicePoint(deps, auth, input, meta) {
  await assertDepartment(deps.db, auth, input.departmentId);
  return camel(
    await auditedInsert(deps, auth, meta, 'service_points', 'service_point', {
      ...snake(input),
      facility_id: auth.facilityId,
    }),
  );
}
/** @param {Deps} deps @param {AuthContext} auth @param {string} id @param {Record<string, any>} input @param {Meta} meta */
export async function updateServicePoint(deps, auth, id, input, meta) {
  await assertDepartment(deps.db, auth, input.departmentId);
  return camel(await auditedUpdate(deps, auth, meta, 'service_points', 'service_point', id, snake(input)));
}

// ---- Wards and beds --------------------------------------------------------

/** Wards with live bed counts per status. @param {Deps} deps @param {AuthContext} auth */
export async function listWards({ db }, auth) {
  const rows = await db('wards as w')
    .join('departments as d', 'd.id', 'w.department_id')
    .leftJoin('beds as b', (j) => j.on('b.ward_id', 'w.id').andOn(db.raw('b.active')))
    .where('w.facility_id', auth.facilityId)
    .groupBy('w.id', 'd.name')
    .orderBy('w.name')
    .select(
      'w.*',
      'd.name as department_name',
      db.raw(`count(b.id)::int AS bed_count`),
      db.raw(`count(b.id) FILTER (WHERE b.status = 'available')::int AS available`),
      db.raw(`count(b.id) FILTER (WHERE b.status = 'occupied')::int AS occupied`),
    );
  return rows.map((r) => camel(r));
}
/** @param {Deps} deps @param {AuthContext} auth @param {Record<string, any>} input @param {Meta} meta */
export async function createWard(deps, auth, input, meta) {
  await assertDepartment(deps.db, auth, input.departmentId);
  return camel(
    await auditedInsert(deps, auth, meta, 'wards', 'ward', { ...snake(input), facility_id: auth.facilityId }),
  );
}
/** @param {Deps} deps @param {AuthContext} auth @param {string} id @param {Record<string, any>} input @param {Meta} meta */
export async function updateWard(deps, auth, id, input, meta) {
  await assertDepartment(deps.db, auth, input.departmentId);
  return camel(await auditedUpdate(deps, auth, meta, 'wards', 'ward', id, snake(input)));
}

/** @param {Deps} deps @param {AuthContext} auth @param {string} wardId */
export async function listBeds({ db }, auth, wardId) {
  const ward = await db('wards').where({ id: wardId, facility_id: auth.facilityId }).first('id');
  if (!ward) throw notFound('Ward');
  const rows = await db('beds').where({ ward_id: wardId }).orderByRaw(`length(label), label`);
  return rows.map((r) => camel(r));
}
/** @param {Deps} deps @param {AuthContext} auth @param {string} wardId @param {Record<string, any>} input @param {Meta} meta */
export async function createBed(deps, auth, wardId, input, meta) {
  const ward = await deps.db('wards').where({ id: wardId, facility_id: auth.facilityId }).first('id');
  if (!ward) throw notFound('Ward');
  if (input.status === 'occupied') throw badRequest('A new bed cannot start as occupied');
  return camel(
    await auditedInsert(deps, auth, meta, 'beds', 'bed', {
      ...snake(input),
      ward_id: wardId,
      facility_id: auth.facilityId,
    }),
  );
}

/**
 * Housekeeping status changes. Occupancy is owned by admissions (Phase 6), so
 * this endpoint never sets or clears "occupied".
 * @param {Deps} deps @param {AuthContext} auth @param {string} id @param {string} status @param {Meta} meta
 */
export async function setBedStatus(deps, auth, id, status, meta) {
  if (
    !hasPermission(auth.grants, 'facilities.manage', { facilityId: auth.facilityId }) &&
    !hasPermission(auth.grants, 'ipd.beds.manage', { facilityId: auth.facilityId })
  )
    throw forbidden();
  if (status === 'occupied') throw badRequest('Beds become occupied through an admission');
  const bed = await deps.db('beds').where({ id, facility_id: auth.facilityId }).first('status');
  if (!bed) throw notFound('Bed');
  if (bed.status === 'occupied') throw badRequest('This bed is occupied; discharge or transfer the patient first');
  return camel(await auditedUpdate(deps, auth, meta, 'beds', 'bed', id, { status }));
}

// ---- Settings --------------------------------------------------------------

/** Facility settings merged over deployment defaults. @param {Deps} deps @param {AuthContext} auth */
export async function getSettings({ db }, auth) {
  const rows = await db('system_settings')
    .where((w) => w.whereNull('facility_id').orWhere('facility_id', auth.facilityId))
    .orderByRaw('facility_id NULLS FIRST');
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/** @param {Deps} deps @param {AuthContext} auth @param {string} key @param {unknown} value @param {Meta} meta */
export async function putSetting({ db }, auth, key, value, meta) {
  return db.transaction(async (trx) => {
    const before = await trx('system_settings').where({ facility_id: auth.facilityId, key }).first();
    let after;
    if (before)
      [after] = await trx('system_settings')
        .where({ id: before.id })
        .update({ value: JSON.stringify(value), updated_by: auth.userId })
        .returning('*');
    else
      [after] = await trx('system_settings')
        .insert({
          facility_id: auth.facilityId,
          key,
          value: JSON.stringify(value),
          created_by: auth.userId,
          updated_by: auth.userId,
        })
        .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: before ? 'update' : 'create',
      entityType: 'setting',
      entityId: key,
      before,
      after,
    });
    return { key, value: after.value };
  });
}
