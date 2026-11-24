import '../../lib/db-types.js';
// Imaging: ordered → scheduled → performed (accession number issued) → reported → released.
//
// A clinical indication is required to order. Clinicians see the report only once released;
// radiology staff see drafts. A released report is corrected by amendment (a new version with a
// reason; earlier versions stay) and the ordering clinician is told. Report PDFs and images can be
// attached; they are stored encrypted. The accession number (and an optional DICOM Study Instance
// UID) links the study to a PACS when one is added.
import { ageParts, hasPermission, LAB_PRIORITIES } from '@afyazuri/shared';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { nextDocNumber } from '../../lib/sequences.js';
import { recordAudit } from '../audit/service.js';
import { readAttachment, saveAttachment, toAttachment } from '../attachments/files.js';
import { postCharge, recalcBill } from '../billing/service.js';
import { notify } from '../notifications/inbox.js';
import { assertClinicalAccess, assertServiceAccess } from '../patients/access.js';

/**
 * @typedef {import('../../middleware/auth.js').AuthContext} AuthContext
 * @typedef {{ip?: string|null, userAgent?: string|null, requestId?: string|null}} Meta
 * @typedef {{db: import('knex').Knex, bus: import('../../lib/events.js').EventBus, config: any,
 *            crypto: import('../../lib/crypto.js').FieldCrypto}} Deps
 */

const actorOf = (a) => ({ userId: a.userId, username: a.username, roles: a.roles, facilityId: a.facilityId });
const facilityOf = (auth) => {
  if (!auth.facilityId) throw badRequest('Select a facility first');
  return auth.facilityId;
};
const fullName = (p) => [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(' ');
const assertImagingAccess = (db, auth, patient) => assertServiceAccess(db, auth, patient, 'imaging.read');
/** Radiology staff see unreleased reports; everyone else only released ones. */
const seesDrafts = (auth) =>
  ['imaging.report', 'imaging.perform'].some((p) => hasPermission(auth.grants, p, { facilityId: auth.facilityId }));

async function lockOrder(trx, auth, id) {
  const o = await trx('imaging_orders')
    .where({ id, facility_id: facilityOf(auth) })
    .forUpdate()
    .first();
  if (!o) throw notFound('Imaging order');
  const patient = await trx('patients').where({ id: o.patient_id }).first();
  await assertImagingAccess(trx, auth, patient);
  return { order: o, patient };
}
const expectStatus = (o, ...ok) => {
  if (!ok.includes(o.status)) throw conflict(`This study is ${o.status}`);
};

// ---- Catalogue ------------------------------------------------------------------------------

export async function listStudies({ db }, auth) {
  return db('imaging_studies')
    .where({ facility_id: facilityOf(auth), active: true })
    .orderBy(['modality', 'name'])
    .select('id', 'code', 'name', 'modality', 'body_part as bodyPart', 'preparation', 'tat_minutes as tatMinutes');
}

export async function listTemplates({ db }, auth, q = {}) {
  return db('imaging_report_templates')
    .where({ facility_id: facilityOf(auth), active: true })
    .modify((x) => q.modality && x.andWhere('modality', q.modality))
    .orderBy('name')
    .select('id', 'name', 'modality', 'study_id as studyId', 'findings', 'impression');
}

// ---- Orders ----------------------------------------------------------------------------------

/** @param {Deps} deps @param {AuthContext} auth @param {string} encounterId @param {any} input @param {Meta} meta */
export async function createImagingOrder({ db, bus, ...rest }, auth, encounterId, input, meta) {
  if (input.clientId) {
    const existing = await db('imaging_orders').where({ client_id: input.clientId }).first('id');
    if (existing) return getImagingOrder({ db, ...rest }, auth, existing.id);
  }
  const id = await db.transaction(async (trx) => {
    const encounter = await trx('encounters')
      .where({ id: encounterId, facility_id: facilityOf(auth) })
      .first();
    if (!encounter) throw notFound('Visit');
    if (encounter.status !== 'open') throw conflict('This visit is closed');
    const patient = await trx('patients').where({ id: encounter.patient_id }).first();
    await assertClinicalAccess(trx, auth, patient);
    const study = await trx('imaging_studies')
      .where({ id: input.studyId, facility_id: encounter.facility_id, active: true })
      .first();
    if (!study) throw badRequest('That study is not offered here');
    const [o] = await trx('imaging_orders')
      .insert({
        facility_id: encounter.facility_id,
        order_number: await nextDocNumber(trx, encounter.facility_id, 'IMG'),
        encounter_id: encounter.id,
        patient_id: patient.id,
        study_id: study.id,
        ordered_by: auth.userId,
        priority: input.priority,
        clinical_indication: input.clinicalIndication,
        client_id: input.clientId ?? null,
        created_by: auth.userId,
        updated_by: auth.userId,
      })
      .returning('*');
    if (study.charge_item_id) {
      const line = await postCharge(trx, auth, {
        encounter,
        chargeItemId: study.charge_item_id,
        quantity: 1,
        sourceType: 'imaging_order',
        sourceId: o.id,
        description: study.name,
      });
      if (line) await trx('imaging_orders').where({ id: o.id }).update({ bill_item_id: line.id });
    }
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'create',
      entityType: 'imaging_order',
      entityId: o.id,
      patientId: patient.id,
      after: { ...o, study: study.code },
    });
    await bus.publish(trx, {
      type: 'imaging.ordered',
      aggregateType: 'imaging_order',
      aggregateId: o.id,
      facilityId: o.facility_id,
      payload: { encounterId: encounter.id, priority: o.priority },
    });
    return o.id;
  });
  return getImagingOrder({ db, ...rest }, auth, id);
}

/** Book a time (or move it). */
export async function scheduleImaging(deps, auth, id, input, meta) {
  await deps.db.transaction(async (trx) => {
    const { order } = await lockOrder(trx, auth, id);
    expectStatus(order, 'ordered', 'scheduled');
    await trx('imaging_orders').where({ id }).update({
      status: 'scheduled',
      scheduled_for: input.scheduledFor,
      scheduled_by: auth.userId,
      updated_by: auth.userId,
    });
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'imaging_order',
      entityId: id,
      patientId: order.patient_id,
      after: { status: 'scheduled', scheduledFor: input.scheduledFor },
    });
  });
  return getImagingOrder(deps, auth, id);
}

/** The study was done: issue the accession number (and record the DICOM UID if known). */
export async function performImaging(deps, auth, id, input, meta) {
  await deps.db.transaction(async (trx) => {
    const { order } = await lockOrder(trx, auth, id);
    expectStatus(order, 'ordered', 'scheduled');
    await trx('imaging_orders')
      .where({ id })
      .update({
        status: 'performed',
        performed_at: trx.fn.now(),
        performed_by: auth.userId,
        accession_number: await nextDocNumber(trx, order.facility_id, 'ACC'),
        study_instance_uid: input.studyInstanceUid ?? null,
        technique_notes: input.techniqueNotes ?? null,
        updated_by: auth.userId,
      });
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'imaging_order',
      entityId: id,
      patientId: order.patient_id,
      after: { status: 'performed' },
    });
  });
  return getImagingOrder(deps, auth, id);
}

/** Write (or, before release, rewrite) the report. */
export async function writeReport(deps, auth, id, input, meta) {
  await deps.db.transaction(async (trx) => {
    const { order } = await lockOrder(trx, auth, id);
    expectStatus(order, 'performed', 'reported');
    await trx('imaging_reports').where({ order_id: id, version: 1 }).delete(); // unreleased draft only
    await trx('imaging_reports').insert({
      order_id: id,
      version: 1,
      findings: input.findings,
      impression: input.impression,
      reported_by: auth.userId,
    });
    await trx('imaging_orders')
      .where({ id })
      .update({ status: 'reported', reported_at: trx.fn.now(), report_version: 1, updated_by: auth.userId });
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'imaging_order',
      entityId: id,
      patientId: order.patient_id,
      after: { status: 'reported', impression: input.impression },
    });
  });
  return getImagingOrder(deps, auth, id);
}

/** Release the report to the record and tell the ordering clinician. */
export async function releaseReport(deps, auth, id, meta) {
  await deps.db.transaction(async (trx) => {
    const { order, patient } = await lockOrder(trx, auth, id);
    expectStatus(order, 'reported');
    const study = await trx('imaging_studies').where({ id: order.study_id }).first('name');
    await trx('imaging_orders')
      .where({ id })
      .update({ status: 'released', released_at: trx.fn.now(), released_by: auth.userId, updated_by: auth.userId });
    const report = await trx('imaging_reports').where({ order_id: id, is_current: true }).first('impression');
    await notify(trx, {
      userId: order.ordered_by,
      facilityId: order.facility_id,
      type: 'imaging.released',
      severity: order.priority === 'stat' ? 'warning' : 'info',
      title: `${study.name} reported: ${fullName(patient)}`,
      body: `${patient.mrn} · Impression: ${report.impression}`,
      link: `/encounters/${order.encounter_id}`,
      patientId: patient.id,
      dedupeKey: `img-release:${id}`,
    });
    await deps.bus.publish(trx, {
      type: 'imaging.released',
      aggregateType: 'imaging_order',
      aggregateId: id,
      facilityId: order.facility_id,
      payload: { encounterId: order.encounter_id },
    });
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'approve',
      entityType: 'imaging_order',
      entityId: id,
      patientId: order.patient_id,
      after: { status: 'released' },
    });
  });
  return getImagingOrder(deps, auth, id);
}

/** Correct a released report: a new version with a reason; earlier versions stay. */
export async function amendReport(deps, auth, id, input, meta) {
  await deps.db.transaction(async (trx) => {
    const { order, patient } = await lockOrder(trx, auth, id);
    expectStatus(order, 'released');
    const version = order.report_version + 1;
    await trx('imaging_reports').where({ order_id: id, is_current: true }).update({ is_current: false });
    await trx('imaging_reports').insert({
      order_id: id,
      version,
      findings: input.findings,
      impression: input.impression,
      reported_by: auth.userId,
      amend_reason: input.reason,
    });
    await trx('imaging_orders').where({ id }).update({
      report_version: version,
      amended: true,
      released_at: trx.fn.now(),
      released_by: auth.userId,
      updated_by: auth.userId,
    });
    const study = await trx('imaging_studies').where({ id: order.study_id }).first('name');
    await notify(trx, {
      userId: order.ordered_by,
      facilityId: order.facility_id,
      type: 'imaging.amended',
      severity: 'warning',
      title: `Amended report: ${study.name} for ${fullName(patient)}`,
      body: `${patient.mrn} · Reason: ${input.reason}`,
      link: `/encounters/${order.encounter_id}`,
      patientId: patient.id,
      dedupeKey: `img-amend:${id}:${version}`,
    });
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'amend',
      entityType: 'imaging_order',
      entityId: id,
      patientId: order.patient_id,
      reason: input.reason,
      after: { version, impression: input.impression },
    });
  });
  return getImagingOrder(deps, auth, id);
}

/** Cancel before the study is done; its bill line is voided. */
export async function cancelImaging(deps, auth, id, reason, meta) {
  await deps.db.transaction(async (trx) => {
    const { order } = await lockOrder(trx, auth, id);
    expectStatus(order, 'ordered', 'scheduled');
    await trx('imaging_orders')
      .where({ id })
      .update({ status: 'cancelled', cancelled_at: trx.fn.now(), cancel_reason: reason, updated_by: auth.userId });
    if (order.bill_item_id) {
      const line = await trx('bill_items').where({ id: order.bill_item_id, status: 'active' }).forUpdate().first();
      if (line) {
        await trx('bills').where({ id: line.bill_id }).forUpdate().first('id');
        await trx('bill_items')
          .where({ id: line.id })
          .update({
            status: 'voided',
            void_reason: `Imaging cancelled: ${reason}`,
            voided_by: auth.userId,
            voided_at: trx.fn.now(),
          });
        await recalcBill(trx, line.bill_id);
      }
    }
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'imaging_order',
      entityId: id,
      patientId: order.patient_id,
      after: { status: 'cancelled' },
      reason,
    });
  });
  return getImagingOrder(deps, auth, id);
}

// ---- Attachments ------------------------------------------------------------------------------

/** Attach a report PDF or image (radiology staff). */
export async function attachFile(deps, auth, id, file, meta) {
  const att = await deps.db.transaction(async (trx) => {
    const { order } = await lockOrder(trx, auth, id);
    if (['ordered', 'cancelled'].includes(order.status)) throw conflict('Attach files once the study has been done');
    const row = await saveAttachment(trx, deps, {
      facilityId: order.facility_id,
      patientId: order.patient_id,
      encounterId: order.encounter_id,
      category: 'imaging',
      fileName: file.name,
      buffer: file.buffer,
      userId: auth.userId,
      sourceType: 'imaging_order',
      sourceId: id,
    });
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'create',
      entityType: 'attachment',
      entityId: row.id,
      patientId: order.patient_id,
      metadata: { order: order.order_number, file: row.file_name, bytes: row.size_bytes },
    });
    return row;
  });
  return toAttachment(att);
}

/** Download an attachment (clinicians only once the report is released). Audited. */
export async function downloadFile(deps, auth, id, attachmentId, meta) {
  const order = await deps
    .db('imaging_orders')
    .where({ id, facility_id: facilityOf(auth) })
    .first();
  if (!order) throw notFound('Imaging order');
  const patient = await deps.db('patients').where({ id: order.patient_id }).first();
  await assertImagingAccess(deps.db, auth, patient);
  if (order.status !== 'released' && !seesDrafts(auth)) throw notFound('Attachment');
  const row = await deps
    .db('attachments')
    .where({ id: attachmentId, source_type: 'imaging_order', source_id: id })
    .whereNull('entered_in_error_at')
    .first();
  if (!row) throw notFound('Attachment');
  const buffer = await readAttachment(deps, row);
  await recordAudit(deps.db, actorOf(auth), meta, {
    action: 'view',
    entityType: 'attachment',
    entityId: row.id,
    patientId: order.patient_id,
  });
  return { row, buffer };
}

// ---- Reading -------------------------------------------------------------------------------------

const minutes = (a, b) => (a && b ? Math.round((new Date(b) - new Date(a)) / 60000) : null);

/** @param {Deps} deps @param {AuthContext} auth @param {string} id */
export async function getImagingOrder({ db }, auth, id) {
  const o = await db('imaging_orders as o')
    .join('imaging_studies as s', 's.id', 'o.study_id')
    .join('patients as p', 'p.id', 'o.patient_id')
    .join('users as u', 'u.id', 'o.ordered_by')
    .leftJoin('users as pf', 'pf.id', 'o.performed_by')
    .leftJoin('users as rl', 'rl.id', 'o.released_by')
    .where({ 'o.id': id, 'o.facility_id': facilityOf(auth) })
    .first(
      'o.*',
      's.code',
      's.name as study',
      's.modality',
      's.body_part',
      's.preparation',
      's.tat_minutes',
      'p.first_name',
      'p.middle_name',
      'p.last_name',
      'p.mrn',
      'p.sex',
      'p.date_of_birth',
      'p.is_restricted',
      'u.full_name as ordered_by_name',
      'pf.full_name as performed_by_name',
      'rl.full_name as released_by_name',
    );
  if (!o) throw notFound('Imaging order');
  await assertImagingAccess(db, auth, { id: o.patient_id, is_restricted: o.is_restricted });
  const visible = o.status === 'released' || (['reported'].includes(o.status) && seesDrafts(auth));
  const [reports, files] = await Promise.all([
    visible
      ? db('imaging_reports as r')
          .join('users as u', 'u.id', 'r.reported_by')
          .where('r.order_id', id)
          .orderBy('r.version')
          .select('r.*', 'u.full_name as reported_by_name')
      : [],
    visible || seesDrafts(auth)
      ? db('attachments as a')
          .leftJoin('users as u', 'u.id', 'a.uploaded_by')
          .where({ 'a.source_type': 'imaging_order', 'a.source_id': id })
          .whereNull('a.entered_in_error_at')
          .orderBy('a.created_at')
          .select('a.*', 'u.full_name as uploaded_by_name')
      : [],
  ]);
  const current = reports.find((r) => r.is_current);
  const a = ageParts(o.date_of_birth);
  const end = o.released_at ?? null;
  const elapsed = minutes(o.created_at, end ?? new Date());
  return {
    id: o.id,
    orderNumber: o.order_number,
    encounterId: o.encounter_id,
    status: o.status,
    priority: o.priority,
    clinicalIndication: o.clinical_indication,
    study: { code: o.code, name: o.study, modality: o.modality, bodyPart: o.body_part, preparation: o.preparation },
    patient: {
      id: o.patient_id,
      name: fullName(o),
      mrn: o.mrn,
      sex: o.sex,
      age: a.years >= 2 ? `${a.years} y` : `${a.years * 12 + a.months} m`,
    },
    orderedBy: o.ordered_by_name,
    orderedById: o.ordered_by,
    orderedAt: o.created_at,
    scheduledFor: o.scheduled_for,
    performedAt: o.performed_at,
    performedBy: o.performed_by_name,
    accessionNumber: o.accession_number,
    studyInstanceUid: o.study_instance_uid,
    techniqueNotes: o.technique_notes,
    releasedAt: o.released_at,
    releasedBy: o.released_by_name,
    amended: o.amended,
    cancelReason: o.cancel_reason,
    tatMinutes: o.tat_minutes,
    elapsedMinutes: elapsed,
    overdue: !['released', 'cancelled'].includes(o.status) && elapsed > o.tat_minutes,
    report: current
      ? {
          version: current.version,
          findings: current.findings,
          impression: current.impression,
          reportedBy: current.reported_by_name,
          reportedAt: current.reported_at,
        }
      : null,
    history: reports
      .filter((r) => !r.is_current)
      .map((r) => ({
        version: r.version,
        impression: r.impression,
        findings: r.findings,
        reportedBy: r.reported_by_name,
        reportedAt: r.reported_at,
      })),
    amendments: reports
      .filter((r) => r.amend_reason)
      .map((r) => ({ version: r.version, reason: r.amend_reason, by: r.reported_by_name, at: r.reported_at })),
    attachments: files.map(toAttachment),
  };
}

export async function encounterImaging({ db }, auth, encounterId) {
  const e = await db('encounters')
    .where({ id: encounterId, facility_id: facilityOf(auth) })
    .first();
  if (!e) throw notFound('Visit');
  await assertClinicalAccess(db, auth, await db('patients').where({ id: e.patient_id }).first());
  const ids = await db('imaging_orders').where({ encounter_id: encounterId }).orderBy('created_at', 'desc').pluck('id');
  return Promise.all(ids.map((id) => getImagingOrder({ db }, auth, id)));
}

const STAGE = {
  schedule: ['ordered'],
  perform: ['ordered', 'scheduled'],
  report: ['performed', 'reported'],
  done: ['released'],
};

/** Radiology worklist for a stage, STAT first. Restricted patients are shown without names. */
export async function imagingWorklist({ db }, auth, q) {
  const rows = await db('imaging_orders as o')
    .join('imaging_studies as s', 's.id', 'o.study_id')
    .join('patients as p', 'p.id', 'o.patient_id')
    .where('o.facility_id', facilityOf(auth))
    .whereIn('o.status', STAGE[q.stage])
    .modify((x) => {
      if (q.stage === 'done') x.andWhere('o.released_at', '>', db.raw("now() - interval '24 hours'"));
      if (q.modality) x.andWhere('s.modality', q.modality);
    })
    .orderByRaw('o.scheduled_for NULLS LAST, o.created_at')
    .limit(300)
    .select(
      'o.id',
      'o.order_number',
      'o.status',
      'o.priority',
      'o.created_at',
      'o.scheduled_for',
      'o.accession_number',
      'o.clinical_indication',
      's.name as study',
      's.modality',
      's.tat_minutes',
      'p.first_name',
      'p.middle_name',
      'p.last_name',
      'p.mrn',
      'p.is_restricted',
    );
  const rank = (p) => LAB_PRIORITIES.indexOf(p);
  return rows
    .map((r) => {
      const elapsed = minutes(r.created_at, new Date());
      return {
        id: r.id,
        orderNumber: r.order_number,
        status: r.status,
        priority: r.priority,
        study: r.study,
        modality: r.modality,
        clinicalIndication: r.clinical_indication,
        accessionNumber: r.accession_number,
        scheduledFor: r.scheduled_for,
        orderedAt: r.created_at,
        patient: r.is_restricted ? 'Restricted patient' : fullName(r),
        mrn: r.mrn,
        overdue: q.stage !== 'done' && elapsed > r.tat_minutes,
      };
    })
    .sort((a, b) => rank(b.priority) - rank(a.priority));
}
