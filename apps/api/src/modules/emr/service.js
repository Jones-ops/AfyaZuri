// Electronic medical record: vitals, SOAP notes (signed and locked, corrected by
// addenda), ICD-coded diagnoses, allergies, problem list and the patient timeline.
// Every read and write goes through the clinical-access check (emr.read, plus
// break-the-glass for restricted records), and every read is audited.
import { NOTE_TEMPLATES, ageParts, bmi, evaluateVitals, hasPermission } from '@afyazuri/shared';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { recordAudit } from '../audit/service.js';
import { assertClinicalAccess } from '../patients/access.js';

/**
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
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);

/** @param {AuthContext} auth */
function facilityOf(auth) {
  if (!auth.facilityId) throw badRequest('Select a facility first');
  return auth.facilityId;
}

async function loadPatient(db, auth, patientId) {
  const p = await db('patients')
    .where({ id: patientId, facility_id: facilityOf(auth) })
    .whereNull('deleted_at')
    .first();
  if (!p) throw notFound('Patient');
  if (p.merged_into_id)
    throw new AppError(410, 'PATIENT_MERGED', 'This record was merged into another patient record.', {
      survivorId: p.merged_into_id,
    });
  await assertClinicalAccess(db, auth, p);
  return p;
}

async function loadEncounter(db, auth, encounterId) {
  const e = await db('encounters')
    .where({ id: encounterId, facility_id: facilityOf(auth) })
    .first();
  if (!e) throw notFound('Visit');
  const p = await loadPatient(db, auth, e.patient_id);
  return { encounter: e, patient: p };
}

/** Return an existing row for an offline client id, or null. */
async function byClientId(db, table, clientId) {
  return clientId ? db(table).where({ client_id: clientId }).first() : null;
}

const viewAudit = (db, auth, meta, patientId, what, extra = {}) =>
  recordAudit(db, actorOf(auth), meta, {
    action: 'view',
    entityType: 'clinical_record',
    entityId: patientId,
    patientId,
    metadata: { what, ...extra },
  });

const userNames = async (db, ids) => {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map();
  const rows = await db('users')
    .whereIn('id', uniq)
    .select('id', 'full_name', 'cadre', 'licence_body', 'licence_number');
  return new Map(rows.map((u) => [u.id, u]));
};
const who = (u) =>
  u
    ? {
        name: u.full_name,
        cadre: u.cadre,
        licence: u.licence_body ? `${u.licence_body} ${u.licence_number ?? ''}`.trim() : null,
      }
    : null;
const errorOf = (r) =>
  r.entered_in_error_at ? { at: r.entered_in_error_at, reason: r.entered_in_error_reason } : null;

// ---- Vitals ------------------------------------------------------------------

const toVitals = (v, users) => ({
  id: v.id,
  encounterId: v.encounter_id,
  recordedAt: v.recorded_at,
  recordedBy: who(users?.get(v.recorded_by)),
  systolic: v.systolic,
  diastolic: v.diastolic,
  pulse: v.pulse,
  temperatureC: v.temperature_c && Number(v.temperature_c),
  respRate: v.resp_rate,
  spo2: v.spo2,
  weightKg: v.weight_kg && Number(v.weight_kg),
  heightCm: v.height_cm && Number(v.height_cm),
  bmi: v.bmi && Number(v.bmi),
  muacCm: v.muac_cm && Number(v.muac_cm),
  painScore: v.pain_score,
  notes: v.notes,
  flags: v.flags,
  enteredInError: errorOf(v),
});

/**
 * Record triage vitals. BMI is calculated and abnormal values flagged using
 * age-appropriate thresholds; critical flags raise an event for alerting.
 * @param {Deps} deps @param {AuthContext} auth @param {string} encounterId @param {any} input @param {Meta} meta
 */
export async function recordVitals({ db, bus }, auth, encounterId, input, meta) {
  const existing = await byClientId(db, 'triage_vitals', input.clientId);
  if (existing) return toVitals(existing);
  const { encounter, patient } = await loadEncounter(db, auth, encounterId);
  const ageMonths = ageParts(patient.date_of_birth).months;
  const flags = evaluateVitals(input, { ageMonths });
  return db.transaction(async (trx) => {
    const [v] = await trx('triage_vitals')
      .insert({
        facility_id: auth.facilityId,
        encounter_id: encounter.id,
        patient_id: patient.id,
        recorded_by: auth.userId,
        systolic: input.systolic ?? null,
        diastolic: input.diastolic ?? null,
        pulse: input.pulse ?? null,
        temperature_c: input.temperatureC ?? null,
        resp_rate: input.respRate ?? null,
        spo2: input.spo2 ?? null,
        weight_kg: input.weightKg ?? null,
        height_cm: input.heightCm ?? null,
        bmi: bmi(input.weightKg, input.heightCm),
        muac_cm: input.muacCm ?? null,
        pain_score: input.painScore ?? null,
        flags: JSON.stringify(flags),
        notes: input.notes ?? null,
        client_id: input.clientId ?? null,
      })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'create',
      entityType: 'triage_vitals',
      entityId: v.id,
      patientId: patient.id,
      after: v,
    });
    if (flags.some((f) => f.level === 'critical'))
      await bus.publish(trx, {
        type: 'vitals.critical',
        aggregateType: 'encounter',
        aggregateId: encounter.id,
        facilityId: auth.facilityId,
        payload: { patientId: patient.id, vitalsId: v.id, flags: flags.filter((f) => f.level === 'critical') },
      });
    return toVitals(v);
  });
}

// ---- Notes ------------------------------------------------------------------

async function notesWithAddenda(db, where) {
  const notes = await db('clinical_notes').where(where).orderBy('created_at');
  const addenda = notes.length
    ? await db('clinical_note_addenda')
        .whereIn(
          'note_id',
          notes.map((n) => n.id),
        )
        .orderBy('created_at')
    : [];
  const users = await userNames(db, [
    ...notes.map((n) => n.author_id),
    ...notes.map((n) => n.signed_by),
    ...addenda.map((a) => a.author_id),
  ]);
  return notes.map((n) =>
    toNote(
      n,
      users,
      addenda.filter((a) => a.note_id === n.id),
    ),
  );
}

const toNote = (n, users, addenda = []) => ({
  id: n.id,
  encounterId: n.encounter_id,
  noteType: n.note_type,
  templateCode: n.template_code,
  status: n.status,
  subjective: n.subjective,
  objective: n.objective,
  assessment: n.assessment,
  plan: n.plan,
  author: who(users?.get(n.author_id)),
  authorId: n.author_id,
  createdAt: n.created_at,
  signedAt: n.signed_at,
  signedBy: who(users?.get(n.signed_by)),
  enteredInError: errorOf(n),
  addenda: addenda.map((a) => ({
    id: a.id,
    body: a.body,
    author: who(users?.get(a.author_id)),
    createdAt: a.created_at,
  })),
});

/**
 * Write a clinical note. By default it is signed and locked on save; a draft
 * can be kept (sign: false) and signed later by its author.
 * @param {Deps} deps @param {AuthContext} auth @param {string} encounterId @param {any} input @param {Meta} meta
 */
export async function createNote({ db }, auth, encounterId, input, meta) {
  const existing = await byClientId(db, 'clinical_notes', input.clientId);
  if (existing) return (await notesWithAddenda(db, { id: existing.id }))[0];
  const { encounter, patient } = await loadEncounter(db, auth, encounterId);
  if (input.sign && !hasPermission(auth.grants, 'emr.notes.sign', { facilityId: auth.facilityId }))
    throw forbidden('Your role can save drafts but not sign notes', { required: ['emr.notes.sign'] });
  if (input.templateCode && !NOTE_TEMPLATES.some((t) => t.code === input.templateCode))
    throw badRequest('Unknown note template');
  const id = await db.transaction(async (trx) => {
    const [n] = await trx('clinical_notes')
      .insert({
        facility_id: auth.facilityId,
        encounter_id: encounter.id,
        patient_id: patient.id,
        note_type: input.noteType,
        template_code: input.templateCode ?? null,
        subjective: input.subjective,
        objective: input.objective,
        assessment: input.assessment,
        plan: input.plan,
        author_id: auth.userId,
        status: input.sign ? 'signed' : 'draft',
        signed_at: input.sign ? trx.fn.now() : null,
        signed_by: input.sign ? auth.userId : null,
        client_id: input.clientId ?? null,
        created_by: auth.userId,
        updated_by: auth.userId,
      })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: input.sign ? 'sign' : 'create',
      entityType: 'clinical_note',
      entityId: n.id,
      patientId: patient.id,
      after: n,
    });
    return n.id;
  });
  return (await notesWithAddenda(db, { id }))[0];
}

/** Edit a draft (author only). @param {Deps} deps @param {AuthContext} auth @param {string} noteId @param {any} input @param {Meta} meta */
export async function updateDraft({ db }, auth, noteId, input, meta) {
  await db.transaction(async (trx) => {
    const n = await trx('clinical_notes')
      .where({ id: noteId, facility_id: facilityOf(auth) })
      .forUpdate()
      .first();
    if (!n) throw notFound('Note');
    await loadPatient(trx, auth, n.patient_id);
    if (n.status !== 'draft')
      throw new AppError(409, 'NOTE_SIGNED', 'This note is signed and locked. Add an addendum instead.');
    if (n.author_id !== auth.userId) throw forbidden('Only the author can edit a draft');
    const [after] = await trx('clinical_notes')
      .where({ id: noteId })
      .update({ ...input, updated_by: auth.userId })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'clinical_note',
      entityId: noteId,
      patientId: n.patient_id,
      before: n,
      after,
    });
  });
  return (await notesWithAddenda(db, { id: noteId }))[0];
}

/** Sign and lock a draft (author only). @param {Deps} deps @param {AuthContext} auth @param {string} noteId @param {Meta} meta */
export async function signNote({ db }, auth, noteId, meta) {
  await db.transaction(async (trx) => {
    const n = await trx('clinical_notes')
      .where({ id: noteId, facility_id: facilityOf(auth) })
      .forUpdate()
      .first();
    if (!n) throw notFound('Note');
    await loadPatient(trx, auth, n.patient_id);
    if (n.status === 'signed') throw conflict('This note is already signed');
    if (n.author_id !== auth.userId) throw forbidden('Only the author can sign this note');
    const [after] = await trx('clinical_notes')
      .where({ id: noteId })
      .update({ status: 'signed', signed_at: trx.fn.now(), signed_by: auth.userId, updated_by: auth.userId })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'sign',
      entityType: 'clinical_note',
      entityId: noteId,
      patientId: n.patient_id,
      before: n,
      after,
    });
  });
  return (await notesWithAddenda(db, { id: noteId }))[0];
}

/** Add an addendum to a signed note. @param {Deps} deps @param {AuthContext} auth @param {string} noteId @param {string} body @param {Meta} meta */
export async function addAddendum({ db }, auth, noteId, body, meta) {
  await db.transaction(async (trx) => {
    const n = await trx('clinical_notes')
      .where({ id: noteId, facility_id: facilityOf(auth) })
      .first();
    if (!n) throw notFound('Note');
    await loadPatient(trx, auth, n.patient_id);
    if (n.status !== 'signed') throw badRequest('Edit the draft directly; addenda are for signed notes');
    const [a] = await trx('clinical_note_addenda')
      .insert({ facility_id: auth.facilityId, note_id: noteId, author_id: auth.userId, body })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'amend',
      entityType: 'clinical_note',
      entityId: noteId,
      patientId: n.patient_id,
      after: a,
    });
  });
  return (await notesWithAddenda(db, { id: noteId }))[0];
}

// ---- Diagnoses --------------------------------------------------------------

const toDiagnosis = (d, users) => ({
  id: d.id,
  encounterId: d.encounter_id,
  icdSystem: d.icd_system,
  icdCode: d.icd_code,
  description: d.description,
  icd10: d.icd10_map ?? null,
  certainty: d.certainty,
  rank: d.rank,
  recordedBy: who(users?.get(d.recorded_by)),
  createdAt: d.created_at,
  enteredInError: errorOf(d),
});

/** @param {Deps} deps @param {AuthContext} auth @param {string} encounterId @param {any} input @param {Meta} meta */
export async function addDiagnosis({ db }, auth, encounterId, input, meta) {
  const existing = await byClientId(db, 'diagnoses', input.clientId);
  if (existing) return toDiagnosis(existing);
  const { encounter, patient } = await loadEncounter(db, auth, encounterId);
  const code = await db('icd_codes').where({ system: input.icdSystem, code: input.icdCode.toUpperCase() }).first();
  if (!code) throw badRequest(`${input.icdCode} is not a known ${input.icdSystem.toUpperCase()} code`);
  const dup = await db('diagnoses')
    .where({ encounter_id: encounter.id, icd_system: code.system, icd_code: code.code })
    .whereNull('entered_in_error_at')
    .first('id');
  if (dup) throw conflict('This diagnosis is already recorded for the visit');
  return db.transaction(async (trx) => {
    if (input.rank === 'primary')
      await trx('diagnoses')
        .where({ encounter_id: encounter.id, rank: 'primary' })
        .whereNull('entered_in_error_at')
        .update({ rank: 'secondary' });
    const [d] = await trx('diagnoses')
      .insert({
        facility_id: auth.facilityId,
        encounter_id: encounter.id,
        patient_id: patient.id,
        icd_system: code.system,
        icd_code: code.code,
        description: code.title,
        certainty: input.certainty,
        rank: input.rank,
        recorded_by: auth.userId,
        client_id: input.clientId ?? null,
        created_by: auth.userId,
        updated_by: auth.userId,
      })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'create',
      entityType: 'diagnosis',
      entityId: d.id,
      patientId: patient.id,
      after: d,
    });
    return toDiagnosis({ ...d, icd10_map: code.icd10_map });
  });
}

/** Code lookup: exact or prefix code matches first, then fuzzy title matches. @param {Deps} deps @param {{q: string, system: string, limit: number}} q */
export async function searchIcd({ db }, q) {
  const term = q.q.trim();
  const codeLike = `${term.toUpperCase().replace(/[%_\\]/g, '\\$&')}%`;
  const titleLike = `%${term.toLowerCase().replace(/[%_\\]/g, '\\$&')}%`;
  const rows = await db('icd_codes')
    .where({ system: q.system })
    .andWhere((w) =>
      w
        .whereRaw('upper(code) LIKE ?', [codeLike])
        .orWhereRaw('lower(title) LIKE ?', [titleLike])
        .orWhereRaw('lower(title) % ?', [term.toLowerCase()]),
    )
    .orderByRaw('(upper(code) = ?) DESC, (upper(code) LIKE ?) DESC, similarity(lower(title), ?) DESC, code', [
      term.toUpperCase(),
      codeLike,
      term.toLowerCase(),
    ])
    .limit(q.limit)
    .select('system', 'code', 'title', 'chapter', 'icd10_map');
  return rows.map((r) => ({ system: r.system, code: r.code, title: r.title, chapter: r.chapter, icd10: r.icd10_map }));
}

// ---- Allergies and problems -------------------------------------------------

const toAllergy = (a, users) => ({
  id: a.id,
  category: a.category,
  allergen: a.allergen,
  reaction: a.reaction,
  severity: a.severity,
  status: a.status,
  recordedBy: who(users?.get(a.created_by)),
  createdAt: a.created_at,
  enteredInError: errorOf(a),
});
const toProblem = (p) => ({
  id: p.id,
  icdCode: p.icd_code,
  description: p.description,
  onsetDate: p.onset_date,
  status: p.status,
  resolvedAt: p.resolved_at,
  createdAt: p.created_at,
  enteredInError: errorOf(p),
});

/** @param {Deps} deps @param {AuthContext} auth @param {string} patientId @param {any} input @param {Meta} meta */
export async function addAllergy({ db, bus }, auth, patientId, input, meta) {
  const existing = await byClientId(db, 'allergies', input.clientId);
  if (existing) return toAllergy(existing);
  const p = await loadPatient(db, auth, patientId);
  const dup = await db('allergies')
    .where({ patient_id: p.id, status: 'active' })
    .whereNull('entered_in_error_at')
    .whereRaw('lower(allergen) = lower(?)', [input.allergen])
    .first('id');
  if (dup) throw conflict(`${input.allergen} is already recorded as an allergy`);
  return db.transaction(async (trx) => {
    const [a] = await trx('allergies')
      .insert({
        facility_id: auth.facilityId,
        patient_id: p.id,
        category: input.category,
        allergen: input.allergen,
        reaction: input.reaction,
        severity: input.severity,
        client_id: input.clientId ?? null,
        created_by: auth.userId,
        updated_by: auth.userId,
      })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'create',
      entityType: 'allergy',
      entityId: a.id,
      patientId: p.id,
      after: a,
    });
    await bus.publish(trx, {
      type: 'allergy.recorded',
      aggregateType: 'patient',
      aggregateId: p.id,
      facilityId: auth.facilityId,
      payload: { allergyId: a.id },
    });
    return toAllergy(a);
  });
}

/** Mark an allergy no longer active (e.g. disproved by challenge). @param {Deps} deps @param {AuthContext} auth @param {string} id @param {string} status @param {Meta} meta */
export async function setAllergyStatus({ db }, auth, id, status, meta) {
  return db.transaction(async (trx) => {
    const before = await trx('allergies')
      .where({ id, facility_id: facilityOf(auth) })
      .forUpdate()
      .first();
    if (!before) throw notFound('Allergy');
    await loadPatient(trx, auth, before.patient_id);
    const [after] = await trx('allergies').where({ id }).update({ status, updated_by: auth.userId }).returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'allergy',
      entityId: id,
      patientId: before.patient_id,
      before,
      after,
    });
    return toAllergy(after);
  });
}

/** @param {Deps} deps @param {AuthContext} auth @param {string} patientId @param {any} input @param {Meta} meta */
export async function addProblem({ db }, auth, patientId, input, meta) {
  const p = await loadPatient(db, auth, patientId);
  if (
    input.icdCode &&
    !(await db('icd_codes').where({ system: 'icd11', code: input.icdCode.toUpperCase() }).first('code'))
  )
    throw badRequest(`${input.icdCode} is not a known ICD-11 code`);
  return db.transaction(async (trx) => {
    const [row] = await trx('problem_list')
      .insert({
        facility_id: auth.facilityId,
        patient_id: p.id,
        icd_code: input.icdCode?.toUpperCase() ?? null,
        description: input.description,
        onset_date: input.onsetDate ? ymd(input.onsetDate) : null,
        created_by: auth.userId,
        updated_by: auth.userId,
      })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'create',
      entityType: 'problem',
      entityId: row.id,
      patientId: p.id,
      after: row,
    });
    return toProblem(row);
  });
}

/** @param {Deps} deps @param {AuthContext} auth @param {string} id @param {{status: string, resolvedAt?: Date|null}} input @param {Meta} meta */
export async function updateProblem({ db }, auth, id, input, meta) {
  return db.transaction(async (trx) => {
    const before = await trx('problem_list')
      .where({ id, facility_id: facilityOf(auth) })
      .forUpdate()
      .first();
    if (!before) throw notFound('Problem');
    await loadPatient(trx, auth, before.patient_id);
    const resolved = input.status === 'resolved' ? ymd(input.resolvedAt ?? new Date()) : null;
    const [after] = await trx('problem_list')
      .where({ id })
      .update({ status: input.status, resolved_at: resolved, updated_by: auth.userId })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'problem',
      entityId: id,
      patientId: before.patient_id,
      before,
      after,
    });
    return toProblem(after);
  });
}

// ---- Corrections ------------------------------------------------------------

const ERRORABLE = {
  vitals: ['triage_vitals', 'emr.vitals.write'],
  notes: ['clinical_notes', 'emr.notes.write'],
  diagnoses: ['diagnoses', 'emr.diagnoses.write'],
  allergies: ['allergies', 'emr.allergies.write'],
  problems: ['problem_list', 'emr.allergies.write'],
};
export const ERRORABLE_KINDS = Object.keys(ERRORABLE);

/**
 * Mark a clinical entry as entered in error. Nothing is deleted: the entry
 * stays visible (struck through) with who corrected it and why.
 * @param {Deps} deps @param {AuthContext} auth @param {string} kind @param {string} id @param {string} reason @param {Meta} meta
 */
export async function markEnteredInError({ db }, auth, kind, id, reason, meta) {
  const [table, perm] = ERRORABLE[kind];
  if (!hasPermission(auth.grants, perm, { facilityId: auth.facilityId }))
    throw forbidden(undefined, { required: [perm] });
  return db.transaction(async (trx) => {
    const before = await trx(table)
      .where({ id, facility_id: facilityOf(auth) })
      .forUpdate()
      .first();
    if (!before) throw notFound('Entry');
    await loadPatient(trx, auth, before.patient_id);
    if (before.entered_in_error_at) throw conflict('Already marked as entered in error');
    const [after] = await trx(table)
      .where({ id })
      .update({ entered_in_error_at: trx.fn.now(), entered_in_error_by: auth.userId, entered_in_error_reason: reason })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'amend',
      entityType: table,
      entityId: id,
      patientId: before.patient_id,
      before,
      after,
      reason,
    });
    return { id, enteredInError: errorOf(after) };
  });
}

// ---- Reading ----------------------------------------------------------------

/**
 * Everything recorded in one visit: vitals, notes (with addenda) and diagnoses.
 * @param {Deps} deps @param {AuthContext} auth @param {string} encounterId @param {Meta} meta
 */
export async function encounterClinical({ db }, auth, encounterId, meta) {
  const { encounter, patient } = await loadEncounter(db, auth, encounterId);
  const [vitals, notes, diagnoses] = await Promise.all([
    db('triage_vitals').where({ encounter_id: encounterId }).orderBy('recorded_at'),
    notesWithAddenda(db, { encounter_id: encounterId }),
    db('diagnoses as d')
      .leftJoin('icd_codes as c', function on() {
        this.on('c.system', 'd.icd_system').andOn('c.code', 'd.icd_code');
      })
      .where('d.encounter_id', encounterId)
      .orderBy([{ column: 'd.rank' }, { column: 'd.created_at' }])
      .select('d.*', 'c.icd10_map'),
  ]);
  const users = await userNames(db, [...vitals.map((v) => v.recorded_by), ...diagnoses.map((d) => d.recorded_by)]);
  await viewAudit(db, auth, meta, patient.id, 'encounter', { encounterId });
  return {
    encounter: {
      id: encounter.id,
      type: encounter.type,
      status: encounter.status,
      startedAt: encounter.started_at,
      endedAt: encounter.ended_at,
    },
    vitals: vitals.map((v) => toVitals(v, users)),
    notes,
    diagnoses: diagnoses.map((d) => toDiagnosis(d, users)),
  };
}

/**
 * Clinical summary for the chart header: active allergies and problems, last vitals, recent diagnoses.
 * @param {Deps} deps @param {AuthContext} auth @param {string} patientId @param {Meta} meta
 */
export async function clinicalSummary({ db }, auth, patientId, meta) {
  const p = await loadPatient(db, auth, patientId);
  const [allergies, problems, lastVitals, recentDx] = await Promise.all([
    db('allergies').where({ patient_id: p.id }).whereNull('entered_in_error_at').orderBy('created_at', 'desc'),
    db('problem_list')
      .where({ patient_id: p.id })
      .whereNull('entered_in_error_at')
      .orderBy([{ column: 'status' }, { column: 'created_at', order: 'desc' }]),
    db('triage_vitals')
      .where({ patient_id: p.id })
      .whereNull('entered_in_error_at')
      .orderBy('recorded_at', 'desc')
      .first(),
    db('diagnoses')
      .where({ patient_id: p.id })
      .whereNull('entered_in_error_at')
      .orderBy('created_at', 'desc')
      .limit(10),
  ]);
  const users = await userNames(
    db,
    allergies.map((a) => a.created_by),
  );
  await viewAudit(db, auth, meta, p.id, 'summary');
  return {
    allergies: allergies.map((a) => toAllergy(a, users)),
    problems: problems.map(toProblem),
    lastVitals: lastVitals ? toVitals(lastVitals) : null,
    recentDiagnoses: recentDx.map((d) => toDiagnosis(d)),
  };
}

/**
 * Chronological record across all visits, newest first, paged by time.
 * @param {Deps} deps @param {AuthContext} auth @param {string} patientId @param {{before?: Date, limit: number}} q @param {Meta} meta
 */
export async function timeline({ db }, auth, patientId, q, meta) {
  const p = await loadPatient(db, auth, patientId);
  const before = q.before ?? new Date(Date.now() + 60_000);
  const lim = q.limit + 1;
  const page = (table, col) =>
    db(table).where({ patient_id: p.id }).andWhere(col, '<', before).orderBy(col, 'desc').limit(lim);

  const [encs, vitals, notes, dx, allergies, problems] = await Promise.all([
    page('encounters', 'started_at'),
    page('triage_vitals', 'recorded_at'),
    page('clinical_notes', 'created_at'),
    page('diagnoses', 'created_at'),
    page('allergies', 'created_at'),
    page('problem_list', 'created_at'),
  ]);
  const addenda = notes.length
    ? await db('clinical_note_addenda')
        .whereIn(
          'note_id',
          notes.map((n) => n.id),
        )
        .orderBy('created_at')
    : [];
  const users = await userNames(db, [
    ...vitals.map((v) => v.recorded_by),
    ...notes.map((n) => n.author_id),
    ...addenda.map((a) => a.author_id),
    ...notes.map((n) => n.signed_by),
    ...dx.map((d) => d.recorded_by),
    ...allergies.map((a) => a.created_by),
  ]);

  const events = [
    ...encs.map((e) => ({
      kind: 'encounter',
      at: e.started_at,
      encounterId: e.id,
      data: { type: e.type, status: e.status, endedAt: e.ended_at },
    })),
    ...vitals.map((v) => ({
      kind: 'vitals',
      at: v.recorded_at,
      encounterId: v.encounter_id,
      data: toVitals(v, users),
    })),
    ...notes.map((n) => ({
      kind: 'note',
      at: n.created_at,
      encounterId: n.encounter_id,
      data: toNote(
        n,
        users,
        addenda.filter((a) => a.note_id === n.id),
      ),
    })),
    ...dx.map((d) => ({
      kind: 'diagnosis',
      at: d.created_at,
      encounterId: d.encounter_id,
      data: toDiagnosis(d, users),
    })),
    ...allergies.map((a) => ({ kind: 'allergy', at: a.created_at, encounterId: null, data: toAllergy(a, users) })),
    ...problems.map((x) => ({ kind: 'problem', at: x.created_at, encounterId: null, data: toProblem(x) })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at));

  const items = events.slice(0, q.limit);
  await viewAudit(db, auth, meta, p.id, 'timeline');
  return {
    data: items,
    nextBefore: events.length > q.limit ? new Date(items[items.length - 1].at).toISOString() : null,
  };
}
