import '../../lib/db-types.js';
import { ageLabel, dobFromEstimatedAge, todayNairobi } from '@afyazuri/shared';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { decodeCursor, encodeCursor } from '../../lib/http.js';
import { getSetting } from '../../lib/settings.js';
import { recordAudit } from '../audit/service.js';
import { clinicalAccess } from './access.js';
import { classifyQuery, maskIdentifier, maskPhone, nextMrn, scoreCandidate } from './identity.js';

/**
 * @typedef {import('../../middleware/auth.js').AuthContext} AuthContext
 * @typedef {{ip?: string|null, userAgent?: string|null, requestId?: string|null}} Meta
 * @typedef {{db: import('knex').Knex, crypto: import('../../lib/crypto.js').FieldCrypto, bus: import('../../lib/events.js').EventBus}} Deps
 */

/**
 * Every table whose rows belong to a patient. Merging repoints these rows to the
 * surviving record and unmerging moves exactly the same rows back. Later phases
 * add their tables here (bills, prescriptions, lab orders, admissions, claims…).
 */
export const PATIENT_LINKED_TABLES = [
  'patient_identifiers',
  'patient_payer_schemes',
  'patient_consents',
  'encounters',
  'triage_vitals',
  'clinical_notes',
  'diagnoses',
  'allergies',
  'problem_list',
  'procedures',
  'referrals',
  'attachments',
  'queue_tickets',
  'break_glass_access',
  'bills',
];

const BREAK_GLASS_HOURS_DEFAULT = 4;
const DUPLICATE_THRESHOLD = 50;

const actorOf = (/** @type {AuthContext} */ a) => ({
  userId: a.userId,
  username: a.username,
  roles: a.roles,
  facilityId: a.facilityId,
});
const ymd = (/** @type {Date|string} */ d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
const idHash = (crypto, value) => crypto.blindIndex('id', value);
const phoneHash = (crypto, phone) => crypto.blindIndex('phone', phone);
const fullName = (p) => [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(' ');

/** @param {AuthContext} auth */
function requireFacility(auth) {
  if (!auth.facilityId) throw badRequest('Select a facility first');
  return auth.facilityId;
}

/** @param {{dateOfBirth?: Date|string, estimatedAge?: {years: number, months?: number}}} input */
function resolveDob(input) {
  if (input.dateOfBirth) return { dob: ymd(input.dateOfBirth), estimated: false };
  if (input.estimatedAge)
    return { dob: dobFromEstimatedAge(input.estimatedAge.years, input.estimatedAge.months ?? 0), estimated: true };
  return { dob: null, estimated: false };
}

/** Patient row in the caller's facility, or 404. */
async function loadPatient(db, auth, id, { forUpdate = false } = {}) {
  const q = db('patients')
    .where({ id, facility_id: requireFacility(auth) })
    .whereNull('deleted_at');
  if (forUpdate) q.forUpdate();
  const p = await q.first();
  if (!p) throw notFound('Patient');
  return p;
}

/** Short form used in search results, duplicate candidates and banners. */
function toSummary(p, crypto) {
  return {
    id: p.id,
    mrn: p.mrn,
    fullName: fullName(p),
    sex: p.sex,
    dateOfBirth: p.date_of_birth,
    dobEstimated: p.dob_estimated,
    age: ageLabel(p.date_of_birth),
    phoneMasked: maskPhone(crypto.decrypt(p.phone_enc)),
    isRestricted: p.is_restricted,
  };
}

function toPatient(p, crypto) {
  return {
    ...toSummary(p, crypto),
    firstName: p.first_name,
    middleName: p.middle_name,
    lastName: p.last_name,
    phone: crypto.decrypt(p.phone_enc),
    email: p.email,
    countyCode: p.county_code,
    subCountyId: p.sub_county_id,
    adminWardId: p.admin_ward_id,
    village: p.village,
    occupation: p.occupation,
    maritalStatus: p.marital_status,
    nextOfKin: p.next_of_kin_name
      ? {
          name: p.next_of_kin_name,
          relationship: p.next_of_kin_relation,
          phone: crypto.decrypt(p.next_of_kin_phone_enc),
        }
      : null,
    restrictedReason: p.restricted_reason,
    deceasedAt: p.deceased_at,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

// ---- Duplicate detection ----------------------------------------------------

/**
 * Likely existing records for the person being registered, best match first.
 * Matches on identifiers and phone (via blind indexes) and on fuzzy name
 * (pg_trgm), then scores with name, date of birth and age agreement.
 * @param {Deps} deps @param {AuthContext} auth
 * @param {{firstName: string, middleName?: string|null, lastName: string, dateOfBirth?: Date, estimatedAge?: any, phone?: string|null, identifiers?: {type: string, value: string}[]}} input
 * @param {{excludeId?: string}} [opts]
 */
export async function findDuplicates({ db, crypto }, auth, input, opts = {}) {
  const facilityId = requireFacility(auth);
  const { dob, estimated } = resolveDob(input);
  const name = [input.firstName, input.middleName, input.lastName].filter(Boolean).join(' ').toLowerCase();
  const firstLast = `${input.firstName} ${input.lastName}`.toLowerCase();
  const ph = input.phone ? phoneHash(crypto, input.phone) : null;
  const hashes = (input.identifiers ?? []).map((i) => idHash(crypto, i.value));

  const { rows } = await db.raw(
    `WITH cand AS (
       SELECT p.id FROM patients p
       WHERE p.facility_id = :facilityId AND p.deleted_at IS NULL AND p.merged_into_id IS NULL
         AND (CAST(:excludeId AS uuid) IS NULL OR p.id <> CAST(:excludeId AS uuid))
         AND (p.search_name % :name
              OR (CAST(:ph AS text) IS NOT NULL AND p.phone_hash = :ph)
              OR p.id IN (SELECT pi.patient_id FROM patient_identifiers pi
                          WHERE pi.value_hash = ANY(CAST(:hashes AS text[])) AND pi.deleted_at IS NULL))
       LIMIT 50)
     SELECT p.*,
       GREATEST(similarity(p.search_name, :name), similarity(lower(p.first_name || ' ' || p.last_name), :firstLast)) AS name_similarity,
       (CAST(:ph AS text) IS NOT NULL AND p.phone_hash = :ph) AS phone_match,
       (SELECT pi.type FROM patient_identifiers pi
         WHERE pi.patient_id = p.id AND pi.value_hash = ANY(CAST(:hashes AS text[])) AND pi.deleted_at IS NULL LIMIT 1) AS identifier_match
     FROM patients p WHERE p.id IN (SELECT id FROM cand)`,
    { facilityId, excludeId: opts.excludeId ?? null, name, firstLast, ph, hashes },
  );

  return rows
    .map((c) => ({ c, ...scoreCandidate(c, { dateOfBirth: dob, estimated }) }))
    .filter((x) => x.score >= DUPLICATE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(({ c, score, reasons }) => ({ ...toSummary(c, crypto), score, reasons }));
}

// ---- Registration ------------------------------------------------------------

/**
 * Register a patient. Refuses with 409 POSSIBLE_DUPLICATE (listing the
 * candidates) unless the clerk gives a reason to create a new record anyway.
 * Idempotent on clientId, for offline registration.
 * @param {Deps} deps @param {AuthContext} auth @param {any} input @param {Meta} meta
 */
export async function registerPatient(deps, auth, input, meta) {
  const { db, crypto, bus } = deps;
  const facilityId = requireFacility(auth);

  if (input.clientId) {
    const existing = await db('patients').where({ client_id: input.clientId }).first('id', 'facility_id');
    if (existing) {
      if (existing.facility_id !== facilityId) throw conflict('That client id belongs to another facility');
      return getPatient(deps, auth, existing.id, meta, { audit: false });
    }
  }

  const { dob, estimated } = resolveDob(input);
  if (!input.duplicateOverrideReason) {
    const candidates = await findDuplicates(deps, auth, input);
    if (candidates.length)
      throw new AppError(
        409,
        'POSSIBLE_DUPLICATE',
        'This patient may already be registered. Check the matches, or give a reason to create a new record.',
        { candidates },
      );
  }

  if (input.payerScheme) {
    const s = await db('schemes').where({ id: input.payerScheme.schemeId, active: true }).first('id');
    if (!s) throw badRequest('Payer scheme not found');
  }

  const facility = await db('facilities').where({ id: facilityId }).first();
  const consentVersion = await getSetting(db, facilityId, 'consent.current_version', '1');

  const id = await db.transaction(async (trx) => {
    const mrn = await nextMrn(trx, facility, Number(todayNairobi().slice(0, 4)));
    const [p] = await trx('patients')
      .insert({
        facility_id: facilityId,
        mrn,
        first_name: input.firstName,
        middle_name: input.middleName ?? null,
        last_name: input.lastName,
        sex: input.sex,
        date_of_birth: dob,
        dob_estimated: estimated,
        phone_enc: crypto.encrypt(input.phone ?? null),
        phone_hash: input.phone ? phoneHash(crypto, input.phone) : null,
        email: input.email ?? null,
        county_code: input.countyCode ?? null,
        sub_county_id: input.subCountyId ?? null,
        admin_ward_id: input.adminWardId ?? null,
        village: input.village ?? null,
        occupation: input.occupation ?? null,
        marital_status: input.maritalStatus ?? null,
        next_of_kin_name: input.nextOfKin?.name ?? null,
        next_of_kin_relation: input.nextOfKin?.relationship ?? null,
        next_of_kin_phone_enc: crypto.encrypt(input.nextOfKin?.phone ?? null),
        duplicate_override_reason: input.duplicateOverrideReason ?? null,
        client_id: input.clientId ?? null,
        created_by: auth.userId,
        updated_by: auth.userId,
      })
      .returning('*');

    if (input.identifiers.length)
      await trx('patient_identifiers').insert(
        input.identifiers.map((i) => ({
          facility_id: facilityId,
          patient_id: p.id,
          type: i.type,
          value_enc: crypto.encrypt(i.value),
          value_hash: idHash(crypto, i.value),
          value_last4: i.value.slice(-4),
          created_by: auth.userId,
          updated_by: auth.userId,
        })),
      );
    if (input.payerScheme) await insertScheme(trx, auth, p.id, input.payerScheme);
    if (input.consents.length)
      await trx('patient_consents').insert(
        input.consents.map((c) => ({
          facility_id: facilityId,
          patient_id: p.id,
          consent_type: c.consentType,
          granted: c.granted,
          consent_version: String(consentVersion),
          method: c.method,
          captured_by: auth.userId,
        })),
      );

    await recordAudit(trx, actorOf(auth), meta, {
      action: 'create',
      entityType: 'patient',
      entityId: p.id,
      patientId: p.id,
      after: p,
      reason: input.duplicateOverrideReason ?? null,
      metadata: {
        identifierTypes: input.identifiers.map((i) => i.type),
        duplicateOverride: !!input.duplicateOverrideReason,
      },
    });
    await bus.publish(trx, {
      type: 'patient.registered',
      aggregateType: 'patient',
      aggregateId: p.id,
      facilityId,
      payload: { mrn },
    });
    return p.id;
  });
  return getPatient(deps, auth, id, meta, { audit: false });
}

async function insertScheme(trx, auth, patientId, s) {
  if (s.isPrimary)
    await trx('patient_payer_schemes').where({ patient_id: patientId, active: true }).update({ is_primary: false });
  const [row] = await trx('patient_payer_schemes')
    .insert({
      facility_id: auth.facilityId,
      patient_id: patientId,
      scheme_id: s.schemeId,
      member_number: s.memberNumber,
      principal_name: s.principalName ?? null,
      relationship: s.relationship ?? null,
      valid_from: s.validFrom ? ymd(s.validFrom) : null,
      valid_to: s.validTo ? ymd(s.validTo) : null,
      is_primary: s.isPrimary,
      created_by: auth.userId,
      updated_by: auth.userId,
    })
    .returning('*');
  return row;
}

// ---- Search ------------------------------------------------------------------

/**
 * Search by MRN, phone, any identifier (national ID, SHA number…) or name.
 * Exact matches come first; name matches are ranked by trigram similarity.
 * @param {Deps} deps @param {AuthContext} auth @param {{q: string, limit: number, cursor?: string}} query
 */
export async function searchPatients({ db, crypto }, auth, query) {
  const facilityId = requireFacility(auth);
  const c = classifyQuery(query.q);
  const offset = Number(decodeCursor(query.cursor)?.o ?? 0);
  const base = () =>
    db('patients as p').where('p.facility_id', facilityId).whereNull('p.deleted_at').whereNull('p.merged_into_id');

  /** @type {Map<string, string>} id → how it matched */
  const exact = new Map();
  if (offset === 0) {
    const add = async (q, how) =>
      (await q.limit(20).pluck('p.id')).forEach((id) => exact.has(id) || exact.set(id, how));
    if (c.mrn) await add(base().whereRaw('lower(p.mrn) = ?', [c.mrn]), 'mrn');
    if (c.phone) await add(base().where('p.phone_hash', phoneHash(crypto, c.phone)), 'phone');
    if (c.identifier)
      await add(
        base().whereIn(
          'p.id',
          db('patient_identifiers')
            .where('value_hash', idHash(crypto, c.identifier))
            .whereNull('deleted_at')
            .select('patient_id'),
        ),
        'identifier',
      );
  }

  let nameIds = [];
  let hasMore = false;
  const canNameSearch = c.nameWords.some((w) => w.length >= 3);
  const fuzzy = { used: false };
  if (canNameSearch) {
    const text = c.nameWords.join(' ');
    // Every word must appear (substring); ranked nearest-first via the GiST trigram index.
    const q = base();
    for (const w of c.nameWords) q.whereRaw('p.search_name LIKE ?', [`%${w.replace(/[%_\\]/g, '\\$&')}%`]);
    let ids = await q
      .orderByRaw('p.search_name <-> ?, p.id', [text])
      .offset(offset)
      .limit(query.limit + 1)
      .pluck('p.id');
    // Nothing contains every word: fall back to typo-tolerant similarity (first page only).
    if (!ids.length && offset === 0) {
      // Nearest-neighbour scan on the GiST index (no WHERE %, which would make the planner
      // use GIN and recheck thousands of rows); keep only reasonably similar names.
      const near = await base()
        .select('p.id', db.raw('p.search_name <-> ? AS dist', [text]))
        .orderByRaw('p.search_name <-> ?', [text])
        .limit(query.limit);
      ids = near.filter((r) => r.dist <= 0.7).map((r) => r.id);
      fuzzy.used = ids.length > 0;
    }
    hasMore = !fuzzy.used && ids.length > query.limit;
    nameIds = ids.slice(0, query.limit).filter((id) => !exact.has(id));
  }

  const order = [...exact.keys(), ...nameIds];
  if (!order.length)
    return {
      data: [],
      nextCursor: null,
      hint:
        !canNameSearch && !c.mrn && !c.phone && !c.identifier
          ? 'Type at least 3 letters of a name, or an MRN, phone or ID number'
          : null,
    };
  const rows = await db('patients').whereIn('id', order);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    data: order.map((id) => ({
      ...toSummary(byId.get(id), crypto),
      matchedBy: exact.get(id) ?? (fuzzy.used ? 'similar_name' : 'name'),
    })),
    nextCursor: hasMore ? encodeCursor({ o: offset + query.limit }) : null,
    hint: fuzzy.used ? 'No exact name match; showing similar names' : null,
  };
}

// ---- Read ------------------------------------------------------------------

/**
 * Full demographic record, with allergies only when the caller has clinical
 * access. Every open is written to the audit log.
 * @param {Deps} deps @param {AuthContext} auth @param {string} id @param {Meta} meta @param {{audit?: boolean}} [opts]
 */
export async function getPatient({ db, crypto }, auth, id, meta, opts = {}) {
  const p = await loadPatient(db, auth, id);
  if (p.merged_into_id)
    throw new AppError(410, 'PATIENT_MERGED', 'This record was merged into another patient record.', {
      survivorId: p.merged_into_id,
    });

  const [identifiers, schemes, consents, access] = await Promise.all([
    db('patient_identifiers').where({ patient_id: id }).whereNull('deleted_at').orderBy('type'),
    db('patient_payer_schemes as ps')
      .join('schemes as s', 's.id', 'ps.scheme_id')
      .join('payers as py', 'py.id', 's.payer_id')
      .where({ 'ps.patient_id': id, 'ps.active': true })
      .orderBy('ps.is_primary', 'desc')
      .select(
        'ps.*',
        's.code as scheme_code',
        's.name as scheme_name',
        's.billing_mode',
        'py.code as payer_code',
        'py.name as payer_name',
        'py.type as payer_type',
      ),
    db('patient_consents').where({ patient_id: id }).orderBy('captured_at', 'desc'),
    clinicalAccess(db, auth, p),
  ]);
  const allergies = access.allowed
    ? await db('allergies')
        .where({ patient_id: id, status: 'active' })
        .whereNull('entered_in_error_at')
        .orderByRaw(
          "CASE severity WHEN 'life_threatening' THEN 0 WHEN 'severe' THEN 1 WHEN 'moderate' THEN 2 ELSE 3 END, allergen",
        )
    : null;

  if (opts.audit !== false)
    await recordAudit(db, actorOf(auth), meta, { action: 'view', entityType: 'patient', entityId: id, patientId: id });

  const latestConsent = {};
  for (const c of consents) latestConsent[c.consent_type] ??= c;

  return {
    ...toPatient(p, crypto),
    identifiers: identifiers.map((i) => {
      const value = crypto.decrypt(i.value_enc);
      return { id: i.id, type: i.type, value, masked: maskIdentifier(value), verifiedAt: i.verified_at };
    }),
    payerSchemes: schemes.map((s) => ({
      id: s.id,
      schemeId: s.scheme_id,
      schemeCode: s.scheme_code,
      schemeName: s.scheme_name,
      payerCode: s.payer_code,
      payerName: s.payer_name,
      payerType: s.payer_type,
      billingMode: s.billing_mode,
      memberNumber: s.member_number,
      principalName: s.principal_name,
      relationship: s.relationship,
      validFrom: s.valid_from,
      validTo: s.valid_to,
      isPrimary: s.is_primary,
    })),
    consents: Object.values(latestConsent).map((c) => ({
      consentType: c.consent_type,
      granted: c.granted && !c.withdrawn_at,
      version: c.consent_version,
      method: c.method,
      capturedAt: c.captured_at,
    })),
    clinical: { canView: access.allowed, reason: access.reason, breakGlassUntil: access.breakGlassUntil },
    allergies:
      allergies?.map((a) => ({
        id: a.id,
        category: a.category,
        allergen: a.allergen,
        reaction: a.reaction,
        severity: a.severity,
      })) ?? null,
  };
}

// ---- Update ----------------------------------------------------------------

/**
 * Edit demographics and identifiers. Encrypted fields are listed in the audit
 * entry's metadata (their values are never logged).
 * @param {Deps} deps @param {AuthContext} auth @param {string} id @param {any} input @param {Meta} meta
 */
export async function updatePatient(deps, auth, id, input, meta) {
  const { db, crypto } = deps;
  await db.transaction(async (trx) => {
    const before = await loadPatient(trx, auth, id, { forUpdate: true });
    if (before.merged_into_id)
      throw new AppError(410, 'PATIENT_MERGED', 'This record was merged into another patient record.', {
        survivorId: before.merged_into_id,
      });
    const patch = {};
    const sensitiveChanged = [];
    const map = {
      firstName: 'first_name',
      middleName: 'middle_name',
      lastName: 'last_name',
      sex: 'sex',
      email: 'email',
      countyCode: 'county_code',
      subCountyId: 'sub_county_id',
      adminWardId: 'admin_ward_id',
      village: 'village',
      occupation: 'occupation',
      maritalStatus: 'marital_status',
    };
    for (const [k, col] of Object.entries(map)) if (input[k] !== undefined) patch[col] = input[k];
    if (input.dateOfBirth || input.estimatedAge) {
      const { dob, estimated } = resolveDob(input);
      patch.date_of_birth = dob;
      patch.dob_estimated = estimated;
    }
    if (input.phone !== undefined && (input.phone ?? null) !== crypto.decrypt(before.phone_enc)) {
      patch.phone_enc = crypto.encrypt(input.phone ?? null);
      patch.phone_hash = input.phone ? phoneHash(crypto, input.phone) : null;
      sensitiveChanged.push('phone');
    }
    if (input.nextOfKin !== undefined) {
      patch.next_of_kin_name = input.nextOfKin?.name ?? null;
      patch.next_of_kin_relation = input.nextOfKin?.relationship ?? null;
      const nokPhone = input.nextOfKin?.phone ?? null;
      if (nokPhone !== crypto.decrypt(before.next_of_kin_phone_enc)) {
        patch.next_of_kin_phone_enc = crypto.encrypt(nokPhone);
        sensitiveChanged.push('next_of_kin_phone');
      }
    }

    if (input.identifiers) {
      const current = await trx('patient_identifiers').where({ patient_id: id }).whereNull('deleted_at');
      const wanted = new Map(input.identifiers.map((i) => [i.type, i.value]));
      for (const row of current) {
        const v = wanted.get(row.type);
        if (v === undefined) {
          await trx('patient_identifiers')
            .where({ id: row.id })
            .update({ deleted_at: trx.fn.now(), updated_by: auth.userId });
          sensitiveChanged.push(`identifier.${row.type}`);
        } else if (idHash(crypto, v) !== row.value_hash) {
          await trx('patient_identifiers')
            .where({ id: row.id })
            .update({
              value_enc: crypto.encrypt(v),
              value_hash: idHash(crypto, v),
              value_last4: v.slice(-4),
              verified_at: null,
              updated_by: auth.userId,
            });
          sensitiveChanged.push(`identifier.${row.type}`);
        }
        wanted.delete(row.type);
      }
      for (const [type, value] of wanted) {
        await trx('patient_identifiers').insert({
          facility_id: auth.facilityId,
          patient_id: id,
          type,
          value_enc: crypto.encrypt(value),
          value_hash: idHash(crypto, value),
          value_last4: value.slice(-4),
          created_by: auth.userId,
          updated_by: auth.userId,
        });
        sensitiveChanged.push(`identifier.${type}`);
      }
    }

    if (!Object.keys(patch).length && !sensitiveChanged.length) return;
    const [after] = Object.keys(patch).length
      ? await trx('patients')
          .where({ id })
          .update({ ...patch, updated_by: auth.userId })
          .returning('*')
      : [before];
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'patient',
      entityId: id,
      patientId: id,
      before,
      after,
      metadata: sensitiveChanged.length ? { sensitiveFieldsChanged: sensitiveChanged } : null,
    });
  });
  return getPatient(deps, auth, id, meta, { audit: false });
}

/** @param {Deps} deps @param {AuthContext} auth @param {string} id @param {{restricted: boolean, reason: string}} input @param {Meta} meta */
export async function setRestricted(deps, auth, id, input, meta) {
  await deps.db.transaction(async (trx) => {
    const before = await loadPatient(trx, auth, id, { forUpdate: true });
    const [after] = await trx('patients')
      .where({ id })
      .update({
        is_restricted: input.restricted,
        restricted_reason: input.restricted ? input.reason : null,
        updated_by: auth.userId,
      })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'patient',
      entityId: id,
      patientId: id,
      before,
      after,
      reason: input.reason,
    });
  });
  return getPatient(deps, auth, id, meta, { audit: false });
}

// ---- Consent and payer schemes ---------------------------------------------

/** @param {Deps} deps @param {AuthContext} auth @param {string} id @param {{consentType: string, granted: boolean, method: string}} input @param {Meta} meta */
export async function recordConsent(deps, auth, id, input, meta) {
  const { db } = deps;
  await loadPatient(db, auth, id);
  const version = await getSetting(db, auth.facilityId, 'consent.current_version', '1');
  await db.transaction(async (trx) => {
    if (!input.granted)
      await trx('patient_consents')
        .where({ patient_id: id, consent_type: input.consentType })
        .whereNull('withdrawn_at')
        .update({ withdrawn_at: trx.fn.now() });
    const [row] = await trx('patient_consents')
      .insert({
        facility_id: auth.facilityId,
        patient_id: id,
        consent_type: input.consentType,
        granted: input.granted,
        consent_version: String(version),
        method: input.method,
        captured_by: auth.userId,
      })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'create',
      entityType: 'patient_consent',
      entityId: row.id,
      patientId: id,
      after: row,
    });
  });
  return getPatient(deps, auth, id, meta, { audit: false });
}

/** Active schemes with their payer, for registration and check-in forms. @param {Deps} deps */
export async function listSchemes({ db }) {
  const rows = await db('schemes as s')
    .join('payers as p', 'p.id', 's.payer_id')
    .where({ 's.active': true, 'p.active': true })
    .orderBy(['p.name', 's.name'])
    .select(
      's.id',
      's.code',
      's.name',
      's.billing_mode',
      's.requires_preauth',
      'p.code as payer_code',
      'p.name as payer_name',
      'p.type as payer_type',
    );
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    billingMode: r.billing_mode,
    requiresPreauth: r.requires_preauth,
    payerCode: r.payer_code,
    payerName: r.payer_name,
    payerType: r.payer_type,
  }));
}

/** @param {Deps} deps @param {AuthContext} auth @param {string} id @param {any} input @param {Meta} meta */
export async function addPayerScheme(deps, auth, id, input, meta) {
  const { db } = deps;
  await loadPatient(db, auth, id);
  if (!(await db('schemes').where({ id: input.schemeId, active: true }).first('id')))
    throw badRequest('Payer scheme not found');
  await db.transaction(async (trx) => {
    const row = await insertScheme(trx, auth, id, input);
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'create',
      entityType: 'patient_payer_scheme',
      entityId: row.id,
      patientId: id,
      after: row,
    });
  });
  return getPatient(deps, auth, id, meta, { audit: false });
}

/** @param {Deps} deps @param {AuthContext} auth @param {string} id @param {string} schemeLinkId @param {Meta} meta */
export async function removePayerScheme(deps, auth, id, schemeLinkId, meta) {
  const { db } = deps;
  await loadPatient(db, auth, id);
  await db.transaction(async (trx) => {
    const before = await trx('patient_payer_schemes').where({ id: schemeLinkId, patient_id: id, active: true }).first();
    if (!before) throw notFound('Payer scheme');
    const [after] = await trx('patient_payer_schemes')
      .where({ id: schemeLinkId })
      .update({ active: false, is_primary: false, updated_by: auth.userId })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'patient_payer_scheme',
      entityId: schemeLinkId,
      patientId: id,
      before,
      after,
    });
  });
  return getPatient(deps, auth, id, meta, { audit: false });
}

// ---- Merge -----------------------------------------------------------------

/**
 * Merge a duplicate into the surviving record. Every linked row is repointed in
 * one transaction and listed in patient_merges.repointed so an unmerge can move
 * exactly those rows back. The duplicate stays (marked merged) for the audit trail.
 * @param {Deps} deps @param {AuthContext} auth @param {{survivorId: string, mergedId: string, reason: string}} input @param {Meta} meta
 */
export async function mergePatients(deps, auth, input, meta) {
  const { db, bus } = deps;
  const mergeId = await db.transaction(async (trx) => {
    const survivor = await loadPatient(trx, auth, input.survivorId, { forUpdate: true });
    const merged = await loadPatient(trx, auth, input.mergedId, { forUpdate: true });
    if (survivor.merged_into_id || merged.merged_into_id)
      throw conflict('One of these records has already been merged');
    const openVisits = await trx('encounters')
      .whereIn('patient_id', [survivor.id, merged.id])
      .where({ status: 'open' })
      .whereIn('type', ['opd', 'emergency'])
      .countDistinct({ n: 'patient_id' })
      .first();
    if (Number(openVisits.n) > 1)
      throw conflict('Both records have an open visit. Close one of the visits before merging.');

    await trx.raw(`SET LOCAL afyazuri.merging = 'on'`);
    const repointed = {};
    for (const table of PATIENT_LINKED_TABLES) {
      const ids = await trx(table).where({ patient_id: merged.id }).update({ patient_id: survivor.id }).returning('id');
      if (ids.length) repointed[table] = ids.map((r) => r.id);
    }
    // Identifiers the survivor already holds become duplicates: retire them (restored on unmerge).
    const dupIdentifiers = await trx('patient_identifiers as moved')
      .join('patient_identifiers as kept', function on() {
        this.on('kept.patient_id', 'moved.patient_id')
          .andOn('kept.type', 'moved.type')
          .andOn('kept.value_hash', 'moved.value_hash')
          .andOn('kept.id', '<>', 'moved.id');
      })
      .whereIn('moved.id', repointed.patient_identifiers ?? [])
      .whereNull('moved.deleted_at')
      .whereNull('kept.deleted_at')
      .pluck('moved.id');
    if (dupIdentifiers.length)
      await trx('patient_identifiers').whereIn('id', dupIdentifiers).update({ deleted_at: trx.fn.now() });

    await trx('patients').where({ id: merged.id }).update({ merged_into_id: survivor.id, updated_by: auth.userId });
    const [m] = await trx('patient_merges')
      .insert({
        facility_id: auth.facilityId,
        survivor_id: survivor.id,
        merged_id: merged.id,
        reason: input.reason,
        repointed: JSON.stringify({ ...repointed, _retiredIdentifiers: dupIdentifiers }),
        merged_by: auth.userId,
      })
      .returning('id');

    const counts = Object.fromEntries(Object.entries(repointed).map(([t, ids]) => [t, ids.length]));
    for (const pid of [survivor.id, merged.id])
      await recordAudit(trx, actorOf(auth), meta, {
        action: 'merge',
        entityType: 'patient',
        entityId: pid,
        patientId: pid,
        reason: input.reason,
        metadata: {
          mergeId: m.id,
          survivorId: survivor.id,
          survivorMrn: survivor.mrn,
          mergedId: merged.id,
          mergedMrn: merged.mrn,
          moved: counts,
        },
      });
    await bus.publish(trx, {
      type: 'patient.merged',
      aggregateType: 'patient',
      aggregateId: survivor.id,
      facilityId: auth.facilityId,
      payload: { mergedId: merged.id },
    });
    return m.id;
  });
  return { mergeId, patient: await getPatient(deps, auth, input.survivorId, meta, { audit: false }) };
}

/**
 * Reverse a merge: rows recorded at merge time go back to the duplicate.
 * @param {Deps} deps @param {AuthContext} auth @param {string} mergeId @param {string} reason @param {Meta} meta
 */
export async function unmergePatients(deps, auth, mergeId, reason, meta) {
  const { db, bus } = deps;
  const m = await db.transaction(async (trx) => {
    const m = await trx('patient_merges')
      .where({ id: mergeId, facility_id: requireFacility(auth) })
      .forUpdate()
      .first();
    if (!m) throw notFound('Merge');
    if (m.unmerged_at) throw conflict('This merge has already been reversed');
    await trx.raw(`SET LOCAL afyazuri.merging = 'on'`);
    const { _retiredIdentifiers: retired = [], ...repointed } = m.repointed;
    for (const [table, ids] of Object.entries(repointed)) {
      if (!PATIENT_LINKED_TABLES.includes(table)) continue;
      await trx(table).whereIn('id', ids).andWhere({ patient_id: m.survivor_id }).update({ patient_id: m.merged_id });
    }
    if (retired.length) await trx('patient_identifiers').whereIn('id', retired).update({ deleted_at: null });
    await trx('patients').where({ id: m.merged_id }).update({ merged_into_id: null, updated_by: auth.userId });
    await trx('patient_merges')
      .where({ id: m.id })
      .update({ unmerged_at: trx.fn.now(), unmerged_by: auth.userId, unmerge_reason: reason });
    for (const pid of [m.survivor_id, m.merged_id])
      await recordAudit(trx, actorOf(auth), meta, {
        action: 'unmerge',
        entityType: 'patient',
        entityId: pid,
        patientId: pid,
        reason,
        metadata: { mergeId: m.id },
      });
    await bus.publish(trx, {
      type: 'patient.unmerged',
      aggregateType: 'patient',
      aggregateId: m.merged_id,
      facilityId: auth.facilityId,
      payload: { survivorId: m.survivor_id },
    });
    return m;
  });
  return { survivorId: m.survivor_id, restoredId: m.merged_id };
}

/** Merge history involving a patient. @param {Deps} deps @param {AuthContext} auth @param {string} id */
export async function listMerges({ db }, auth, id) {
  await loadPatient(db, auth, id);
  const rows = await db('patient_merges as m')
    .join('patients as s', 's.id', 'm.survivor_id')
    .join('patients as d', 'd.id', 'm.merged_id')
    .join('users as u', 'u.id', 'm.merged_by')
    .where((w) => w.where('m.survivor_id', id).orWhere('m.merged_id', id))
    .orderBy('m.merged_at', 'desc')
    .select(
      'm.*',
      's.mrn as survivor_mrn',
      'd.mrn as merged_mrn',
      'd.first_name',
      'd.middle_name',
      'd.last_name',
      'u.full_name as merged_by_name',
    );
  return rows.map((r) => ({
    id: r.id,
    survivorId: r.survivor_id,
    survivorMrn: r.survivor_mrn,
    mergedId: r.merged_id,
    mergedMrn: r.merged_mrn,
    mergedName: fullName(r),
    reason: r.reason,
    mergedAt: r.merged_at,
    mergedBy: r.merged_by_name,
    unmergedAt: r.unmerged_at,
    unmergeReason: r.unmerge_reason,
    moved: Object.fromEntries(
      Object.entries(r.repointed)
        .filter(([k]) => !k.startsWith('_'))
        .map(([t, ids]) => [t, ids.length]),
    ),
  }));
}

// ---- Break the glass -------------------------------------------------------

/**
 * Time-limited emergency access to a restricted record. Requires a reason,
 * is audited, and notifies the facility's audit reviewers.
 * @param {Deps} deps @param {AuthContext} auth @param {string} id @param {string} reason @param {Meta} meta
 */
export async function breakGlass({ db }, auth, id, reason, meta) {
  const p = await loadPatient(db, auth, id);
  if (!p.is_restricted) throw badRequest('This record is not restricted; no emergency access is needed');
  const hours = Number(await getSetting(db, auth.facilityId, 'emr.break_glass_hours', BREAK_GLASS_HOURS_DEFAULT));
  return db.transaction(async (trx) => {
    const [grant] = await trx('break_glass_access')
      .insert({
        facility_id: auth.facilityId,
        user_id: auth.userId,
        patient_id: id,
        reason,
        expires_at: trx.raw('now() + make_interval(hours => ?)', [hours]),
      })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'break_glass',
      entityType: 'patient',
      entityId: id,
      patientId: id,
      reason,
      metadata: { grantId: grant.id, hours },
    });
    const reviewers = await trx('user_roles as ur')
      .join('role_permissions as rp', 'rp.role_id', 'ur.role_id')
      .join('users as u', 'u.id', 'ur.user_id')
      .where('rp.permission_code', 'audit.read')
      .andWhere('u.status', 'active')
      .andWhere((w) => w.where('ur.facility_id', auth.facilityId).orWhereNull('ur.facility_id'))
      .distinct('ur.user_id')
      .pluck('ur.user_id');
    if (reviewers.length)
      await trx('notifications').insert(
        reviewers.map((uid) => ({
          facility_id: auth.facilityId,
          user_id: uid,
          channel: 'in_app',
          template: 'break_glass.used',
          priority: 'high',
          payload: JSON.stringify({ grantId: grant.id, patientId: id, mrn: p.mrn, by: auth.fullName, reason }),
        })),
      );
    return { grantId: grant.id, expiresAt: grant.expires_at };
  });
}

/** Break-the-glass grants for review. @param {Deps} deps @param {AuthContext} auth @param {{status: string}} q */
export async function listBreakGlass({ db }, auth, q) {
  const query = db('break_glass_access as b')
    .join('users as u', 'u.id', 'b.user_id')
    .join('patients as p', 'p.id', 'b.patient_id')
    .leftJoin('users as r', 'r.id', 'b.reviewed_by')
    .where('b.facility_id', requireFacility(auth))
    .orderBy('b.granted_at', 'desc')
    .limit(200)
    .select('b.*', 'u.full_name as user_name', 'u.username', 'p.mrn', 'r.full_name as reviewer_name');
  if (q.status === 'unreviewed') query.whereNull('b.reviewed_at');
  return (await query).map((b) => ({
    id: b.id,
    userName: b.user_name,
    username: b.username,
    patientId: b.patient_id,
    mrn: b.mrn,
    reason: b.reason,
    grantedAt: b.granted_at,
    expiresAt: b.expires_at,
    reviewedAt: b.reviewed_at,
    reviewedBy: b.reviewer_name,
    outcome: b.review_outcome,
  }));
}

/** @param {Deps} deps @param {AuthContext} auth @param {string} grantId @param {{outcome: string, note?: string|null}} input @param {Meta} meta */
export async function reviewBreakGlass({ db }, auth, grantId, input, meta) {
  return db.transaction(async (trx) => {
    const before = await trx('break_glass_access')
      .where({ id: grantId, facility_id: requireFacility(auth) })
      .forUpdate()
      .first();
    if (!before) throw notFound('Emergency access record');
    if (before.reviewed_at) throw conflict('Already reviewed');
    if (before.user_id === auth.userId) throw forbidden('You cannot review your own emergency access');
    const [after] = await trx('break_glass_access')
      .where({ id: grantId })
      .update({ reviewed_by: auth.userId, reviewed_at: trx.fn.now(), review_outcome: input.outcome })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'break_glass_access',
      entityId: grantId,
      patientId: before.patient_id,
      before,
      after,
      reason: input.note ?? null,
    });
    return { id: grantId, outcome: input.outcome };
  });
}
