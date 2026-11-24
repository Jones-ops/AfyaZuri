import '../../lib/db-types.js';
// Lab results: entry (with automatic flags), verification and release, amendment, and the
// printable report.
//
//   received → resulted (entered; visible to the lab only) → verified (released to the record)
//
// Verification is maker-checker: whoever entered the results cannot verify them. A critical value
// alerts lab supervisors as soon as it is entered and the ordering clinician as soon as it is
// released. An amendment after release adds a new version (with a reason); earlier versions stay.
import { FLAG_LABEL, ageInDays, flagFor, hasPermission, pickRange, rangeText } from '@afyazuri/shared';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import { recordAudit } from '../audit/service.js';
import { notify, usersWith } from '../notifications/inbox.js';
import { assertClinicalAccess } from '../patients/access.js';
import { actorOf, assertLabAccess, facilityOf } from './service.js';

/**
 * @typedef {import('../../middleware/auth.js').AuthContext} AuthContext
 * @typedef {{ip?: string|null, userAgent?: string|null, requestId?: string|null}} Meta
 * @typedef {{db: import('knex').Knex, bus: import('../../lib/events.js').EventBus}} Deps
 */

const fullName = (p) => [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(' ');

/** The test line with everything needed to enter or show results. */
async function loadItem(db, auth, itemId, { lock = false } = {}) {
  const q = db('lab_order_items as i')
    .join('lab_orders as o', 'o.id', 'i.order_id')
    .join('lab_tests as t', 't.id', 'i.test_id')
    .join('patients as p', 'p.id', 'o.patient_id')
    .where({ 'i.id': itemId, 'o.facility_id': facilityOf(auth) })
    .first(
      'i.*',
      'o.order_number',
      'o.encounter_id',
      'o.ordered_by',
      'o.patient_id',
      'o.facility_id',
      't.name as test_name',
      't.code as test_code',
      'p.first_name',
      'p.middle_name',
      'p.last_name',
      'p.mrn',
      'p.sex',
      'p.date_of_birth',
      'p.is_restricted',
    );
  if (lock) q.forUpdate('i');
  const item = await q;
  if (!item) throw notFound('Test');
  await assertLabAccess(db, auth, { id: item.patient_id, is_restricted: item.is_restricted });
  const components = await db('lab_test_components').where({ test_id: item.test_id }).orderBy('sort');
  const ranges = await db('lab_reference_ranges').whereIn(
    'component_id',
    components.map((c) => c.id),
  );
  return { item, components, ranges };
}

const shapeRange = (r) => ({
  sex: r.sex,
  ageMinDays: r.age_min_days,
  ageMaxDays: r.age_max_days,
  low: r.low === null ? null : Number(r.low),
  high: r.high === null ? null : Number(r.high),
  criticalLow: r.critical_low === null ? null : Number(r.critical_low),
  criticalHigh: r.critical_high === null ? null : Number(r.critical_high),
});

/**
 * Check every component has a valid value and work out flags. Throws 400 with per-component issues.
 * @returns {Array<object>} rows ready for lab_results (without version, ids or user)
 */
function prepareResults({ item, components, ranges }, values) {
  const byId = new Map(values.map((v) => [v.componentId, v]));
  const patient = { sex: item.sex, ageDays: ageInDays(item.date_of_birth) };
  const issues = [];
  const rows = components.map((c) => {
    const v = byId.get(c.id);
    const path = `values.${c.code}`;
    if (!v) {
      issues.push({ path, message: `Enter ${c.name}` });
      return null;
    }
    const base = {
      component_id: c.id,
      unit: c.unit,
      value_numeric: null,
      value_text: null,
      culture: null,
      flag: null,
      critical: false,
      range_text: null,
    };
    if (c.result_type === 'numeric') {
      const n = typeof v.value === 'number' ? v.value : Number(String(v.value ?? '').replace(',', '.'));
      if (v.value === null || v.value === undefined || v.value === '' || !Number.isFinite(n)) {
        issues.push({ path, message: `${c.name} must be a number` });
        return null;
      }
      const range = pickRange(ranges.filter((r) => r.component_id === c.id).map(shapeRange), patient);
      const { flag, critical } = flagFor({ resultType: 'numeric' }, range, n);
      return {
        ...base,
        value_numeric: Number(n.toFixed(c.decimals)),
        flag,
        critical,
        range_text: rangeText(range, c.decimals),
      };
    }
    if (c.result_type === 'options') {
      if (!(c.options ?? []).includes(v.value)) {
        issues.push({ path, message: `Choose one of: ${(c.options ?? []).join(', ')}` });
        return null;
      }
      const { flag } = flagFor({ resultType: 'options', abnormalOptions: c.abnormal_options }, null, v.value);
      return { ...base, value_text: v.value, flag };
    }
    if (c.result_type === 'culture') {
      if (!v.culture) {
        issues.push({ path, message: 'Record the culture result' });
        return null;
      }
      return { ...base, culture: JSON.stringify(v.culture), flag: v.culture.growth === 'growth' ? 'A' : 'N' };
    }
    if (!v.text?.trim()) {
      issues.push({ path, message: `Enter ${c.name}` });
      return null;
    }
    return { ...base, value_text: v.text.trim() };
  });
  for (const v of values)
    if (!components.some((c) => c.id === v.componentId))
      issues.push({ path: 'values', message: 'A value is for another test' });
  if (issues.length) throw new AppError(400, 'VALIDATION_FAILED', 'Check the results', { issues });
  return rows;
}

const summary = (rows, components) =>
  rows
    .map((r) => {
      const c = components.find((x) => x.id === r.component_id);
      const culture = typeof r.culture === 'string' ? JSON.parse(r.culture) : r.culture;
      const v =
        r.value_numeric != null
          ? Number(r.value_numeric)
          : (r.value_text ?? (culture ? (culture.organism ?? culture.growth.replace('_', ' ')) : ''));
      return `${c.name} ${v}${c.unit ? ` ${c.unit}` : ''}${r.flag && r.flag !== 'N' ? ` (${FLAG_LABEL[r.flag]})` : ''}`;
    })
    .join('; ');

/**
 * Enter (or, before verification, re-enter) a test's results.
 * @param {Deps} deps @param {AuthContext} auth @param {string} itemId @param {{values: any[], comment?: string|null}} input @param {Meta} meta
 */
export async function enterResults({ db }, auth, itemId, input, meta) {
  await db.transaction(async (trx) => {
    const ctx = await loadItem(trx, auth, itemId, { lock: true });
    const { item, components } = ctx;
    if (!['received', 'resulted'].includes(item.status))
      throw conflict(
        item.status === 'verified'
          ? 'These results are released; a supervisor can amend them'
          : `The sample has not been received in the lab (status: ${item.status})`,
      );
    const rows = prepareResults(ctx, input.values);
    await trx('lab_results').where({ order_item_id: itemId, version: item.version }).delete(); // unreleased draft only
    await trx('lab_results').insert(
      rows.map((r) => ({ ...r, order_item_id: itemId, version: item.version, entered_by: auth.userId })),
    );
    const critical = rows.some((r) => r.critical);
    await trx('lab_order_items')
      .where({ id: itemId })
      .update({
        status: 'resulted',
        resulted_at: trx.fn.now(),
        entered_by: auth.userId,
        comment: input.comment ?? null,
        critical,
      });
    if (critical)
      for (const userId of await usersWith(trx, item.facility_id, 'lab.results.verify'))
        if (userId !== auth.userId)
          await notify(trx, {
            userId,
            facilityId: item.facility_id,
            type: 'lab.critical.unverified',
            severity: 'critical',
            title: `Critical result to verify: ${item.test_name}`,
            body: `${item.order_number} · ${fullName(item)} (${item.mrn}): ${summary(
              rows.filter((r) => r.critical),
              components,
            )}`,
            link: '/lab?stage=verify',
            patientId: item.patient_id,
            dedupeKey: `lab-crit-entry:${itemId}:${item.version}`,
          });
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'lab_order_item',
      entityId: itemId,
      patientId: item.patient_id,
      after: { status: 'resulted', results: summary(rows, components), critical },
    });
  });
  return itemResults({ db }, auth, itemId);
}

/**
 * Verify and release. Never by the person who entered the results.
 * @param {Deps} deps @param {AuthContext} auth @param {string} itemId @param {Meta} meta
 */
export async function verifyResults({ db, bus }, auth, itemId, meta) {
  await db.transaction(async (trx) => {
    const { item, components } = await loadItem(trx, auth, itemId, { lock: true });
    if (item.status !== 'resulted') throw conflict(`Nothing to verify (status: ${item.status})`);
    if (item.entered_by === auth.userId)
      throw new AppError(403, 'SELF_VERIFICATION', 'Someone else must verify results you entered.');
    await trx('lab_order_items')
      .where({ id: itemId })
      .update({ status: 'verified', verified_at: trx.fn.now(), verified_by: auth.userId });
    await trx('lab_result_verifications').insert({
      order_item_id: itemId,
      version: item.version,
      action: 'verified',
      by_user: auth.userId,
    });
    const rows = await trx('lab_results').where({ order_item_id: itemId, is_current: true });
    if (item.critical) {
      await notify(trx, {
        userId: item.ordered_by,
        facilityId: item.facility_id,
        type: 'lab.critical',
        severity: 'critical',
        title: `CRITICAL: ${item.test_name} for ${fullName(item)}`,
        body: `${item.mrn} · ${summary(
          rows.filter((r) => r.critical),
          components,
        )}. Act now and acknowledge.`,
        link: `/encounters/${item.encounter_id}`,
        patientId: item.patient_id,
        dedupeKey: `lab-crit:${itemId}:${item.version}`,
      });
      await bus.publish(trx, {
        type: 'lab.result.critical',
        aggregateType: 'lab_order_item',
        aggregateId: itemId,
        facilityId: item.facility_id,
        payload: { orderedBy: item.ordered_by, encounterId: item.encounter_id },
      });
    }
    await bus.publish(trx, {
      type: 'lab.result.released',
      aggregateType: 'lab_order_item',
      aggregateId: itemId,
      facilityId: item.facility_id,
      payload: { encounterId: item.encounter_id, critical: item.critical },
    });
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'approve',
      entityType: 'lab_order_item',
      entityId: itemId,
      patientId: item.patient_id,
      after: { status: 'verified', version: item.version },
    });
  });
  return itemResults({ db }, auth, itemId);
}

/**
 * Correct released results: a new version with a reason, released by the supervisor making it.
 * Earlier versions stay. The ordering clinician is told.
 */
export async function amendResults({ db, bus }, auth, itemId, input, meta) {
  await db.transaction(async (trx) => {
    const ctx = await loadItem(trx, auth, itemId, { lock: true });
    const { item, components } = ctx;
    if (item.status !== 'verified')
      throw conflict('Only released results are amended; correct unreleased ones directly');
    const rows = prepareResults(ctx, input.values);
    const version = item.version + 1;
    await trx('lab_results').where({ order_item_id: itemId, is_current: true }).update({ is_current: false });
    await trx('lab_results').insert(
      rows.map((r) => ({ ...r, order_item_id: itemId, version, entered_by: auth.userId, amend_reason: input.reason })),
    );
    const critical = rows.some((r) => r.critical);
    await trx('lab_order_items')
      .where({ id: itemId })
      .update({
        version,
        amended: true,
        critical,
        comment: input.comment ?? item.comment,
        verified_at: trx.fn.now(),
        verified_by: auth.userId,
      });
    await trx('lab_result_verifications').insert({
      order_item_id: itemId,
      version,
      action: 'amended',
      by_user: auth.userId,
      reason: input.reason,
    });
    await notify(trx, {
      userId: item.ordered_by,
      facilityId: item.facility_id,
      type: 'lab.amended',
      severity: critical ? 'critical' : 'warning',
      title: `Amended result: ${item.test_name} for ${fullName(item)}`,
      body: `${item.mrn} · ${summary(rows, components)}. Reason: ${input.reason}`,
      link: `/encounters/${item.encounter_id}`,
      patientId: item.patient_id,
      dedupeKey: `lab-amend:${itemId}:${version}`,
    });
    await bus.publish(trx, {
      type: 'lab.result.amended',
      aggregateType: 'lab_order_item',
      aggregateId: itemId,
      facilityId: item.facility_id,
      payload: { version, critical },
    });
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'amend',
      entityType: 'lab_order_item',
      entityId: itemId,
      patientId: item.patient_id,
      reason: input.reason,
      after: { version, results: summary(rows, components) },
    });
  });
  return itemResults({ db }, auth, itemId);
}

/**
 * Unreleased results are seen only by the lab staff who enter or verify them; everyone else
 * (including clinicians who can read the lab worklist) sees results once released.
 */
const seesDrafts = (auth) =>
  ['lab.results.enter', 'lab.results.verify'].some((p) =>
    hasPermission(auth.grants, p, { facilityId: auth.facilityId }),
  );

const toValue = (r) => ({
  value: r.value_numeric !== null ? Number(r.value_numeric) : r.value_text,
  culture: r.culture,
  unit: r.unit,
  flag: r.flag,
  critical: r.critical,
  rangeText: r.range_text,
});

/**
 * Results of one test: current values by component, and (once released) every earlier version.
 * Clinicians see nothing until the results are verified.
 */
export async function itemResults({ db }, auth, itemId) {
  const { item, components, ranges } = await loadItem(db, auth, itemId);
  const visible = item.status === 'verified' || (item.status === 'resulted' && seesDrafts(auth));
  const rows = visible
    ? await db('lab_results as r')
        .leftJoin('users as u', 'u.id', 'r.entered_by')
        .where('r.order_item_id', itemId)
        .orderBy(['r.version'])
        .select('r.*', 'u.full_name as entered_by_name')
    : [];
  const verifications = await db('lab_result_verifications as v')
    .join('users as u', 'u.id', 'v.by_user')
    .where('v.order_item_id', itemId)
    .orderBy('v.at')
    .select('v.*', 'u.full_name');
  const patient = { sex: item.sex, ageDays: ageInDays(item.date_of_birth) };
  return {
    itemId,
    test: { code: item.test_code, name: item.test_name },
    status: item.status,
    version: item.version,
    amended: item.amended,
    critical: visible ? item.critical : false,
    comment: visible ? item.comment : null,
    enteredById: item.entered_by,
    components: components.map((c) => {
      const range = pickRange(ranges.filter((r) => r.component_id === c.id).map(shapeRange), patient);
      const current = rows.find((r) => r.component_id === c.id && r.is_current);
      return {
        id: c.id,
        code: c.code,
        name: c.name,
        resultType: c.result_type,
        unit: c.unit,
        decimals: c.decimals,
        options: c.options,
        abnormalOptions: c.abnormal_options,
        range,
        rangeText: rangeText(range, c.decimals),
        current: current ? toValue(current) : null,
        history: rows
          .filter((r) => r.component_id === c.id && !r.is_current)
          .map((r) => ({ version: r.version, ...toValue(r), enteredBy: r.entered_by_name, enteredAt: r.entered_at })),
      };
    }),
    verifications: verifications.map((v) => ({
      version: v.version,
      action: v.action,
      by: v.full_name,
      at: v.at,
      reason: v.reason,
    })),
  };
}

/**
 * Printable report for an order: released tests only, on the facility letterhead, with
 * turnaround times.
 */
export async function labReport({ db }, auth, orderId) {
  const o = await db('lab_orders as o')
    .join('patients as p', 'p.id', 'o.patient_id')
    .join('users as u', 'u.id', 'o.ordered_by')
    .join('facilities as f', 'f.id', 'o.facility_id')
    .where({ 'o.id': orderId, 'o.facility_id': facilityOf(auth) })
    .first(
      'o.*',
      'p.first_name',
      'p.middle_name',
      'p.last_name',
      'p.mrn',
      'p.sex',
      'p.date_of_birth',
      'p.is_restricted',
      'u.full_name as ordered_by_name',
      'f.name as facility_name',
      'f.kmhfl_code',
      'f.address',
      'f.phone as facility_phone',
    );
  if (!o) throw notFound('Lab order');
  await assertLabAccess(db, auth, { id: o.patient_id, is_restricted: o.is_restricted });
  const items = await db('lab_order_items as i')
    .join('lab_tests as t', 't.id', 'i.test_id')
    .leftJoin('users as v', 'v.id', 'i.verified_by')
    .leftJoin('lab_samples as s', 's.id', 'i.sample_id')
    .where({ 'i.order_id': orderId, 'i.status': 'verified' })
    .orderBy('t.name')
    .select(
      'i.id',
      't.name',
      't.section',
      'i.ordered_at',
      'i.collected_at',
      'i.received_at',
      'i.verified_at',
      'i.amended',
      'v.full_name as verified_by',
      's.accession',
      's.specimen_type',
    );
  const tests = await Promise.all(items.map((i) => itemResults({ db }, auth, i.id)));
  await recordAudit(
    db,
    actorOf(auth),
    {},
    {
      action: 'view',
      entityType: 'lab_report',
      entityId: orderId,
      patientId: o.patient_id,
    },
  );
  return {
    facility: { name: o.facility_name, kmhflCode: o.kmhfl_code, address: o.address, phone: o.facility_phone },
    orderNumber: o.order_number,
    priority: o.priority,
    clinicalNotes: o.clinical_notes,
    orderedBy: o.ordered_by_name,
    orderedAt: o.created_at,
    patient: { name: fullName(o), mrn: o.mrn, sex: o.sex, dateOfBirth: o.date_of_birth },
    tests: items.map((i, n) => ({
      ...tests[n],
      section: i.section,
      accession: i.accession,
      specimenType: i.specimen_type,
      collectedAt: i.collected_at,
      receivedAt: i.received_at,
      verifiedAt: i.verified_at,
      verifiedBy: i.verified_by,
      turnaroundMinutes: Math.round((new Date(i.verified_at) - new Date(i.ordered_at)) / 60000),
    })),
  };
}

/**
 * Released lab results for a patient, newest first (the record shows nothing unreleased).
 * @param {Deps} deps @param {AuthContext} auth @param {string} patientId
 */
export async function patientLabResults({ db }, auth, patientId) {
  const p = await db('patients')
    .where({ id: patientId, facility_id: facilityOf(auth) })
    .first();
  if (!p) throw notFound('Patient');
  await assertClinicalAccess(db, auth, p);
  const items = await db('lab_order_items as i')
    .join('lab_orders as o', 'o.id', 'i.order_id')
    .where({ 'o.patient_id': patientId, 'i.status': 'verified' })
    .orderBy('i.verified_at', 'desc')
    .limit(50)
    .select('i.id', 'i.verified_at', 'o.order_number', 'o.id as order_id');
  const out = [];
  for (const i of items)
    out.push({
      ...(await itemResults({ db }, auth, i.id)),
      orderId: i.order_id,
      orderNumber: i.order_number,
      verifiedAt: i.verified_at,
    });
  await recordAudit(db, actorOf(auth), {}, { action: 'view', entityType: 'lab_results', patientId });
  return out;
}
