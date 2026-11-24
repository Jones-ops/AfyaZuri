import '../../lib/db-types.js';
// Laboratory: catalogue, orders, samples and the worklist.
//
//   ordered → collected (one tube per specimen and container, with a barcode accession)
//           → received in the lab (scanned) → resulted → verified (released)
//
// Ordering posts each test's charge to the visit bill in the same transaction. A sample rejected
// in the lab sends its tests back to "ordered" for recollection; the rejected tube stays on record.
import { ageParts, LAB_PRIORITIES } from '@afyazuri/shared';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { nextDocNumber } from '../../lib/sequences.js';
import { recordAudit } from '../audit/service.js';
import { postCharge, recalcBill } from '../billing/service.js';
import { assertClinicalAccess, assertServiceAccess } from '../patients/access.js';

/**
 * @typedef {import('../../middleware/auth.js').AuthContext} AuthContext
 * @typedef {{ip?: string|null, userAgent?: string|null, requestId?: string|null}} Meta
 * @typedef {{db: import('knex').Knex, bus: import('../../lib/events.js').EventBus}} Deps
 */

export const actorOf = (a) => ({ userId: a.userId, username: a.username, roles: a.roles, facilityId: a.facilityId });
export const facilityOf = (auth) => {
  if (!auth.facilityId) throw badRequest('Select a facility first');
  return auth.facilityId;
};
const fullName = (p) => [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(' ');
export const assertLabAccess = (db, auth, patient) => assertServiceAccess(db, auth, patient, 'lab.read');
const ageLabel = (dob) => {
  const a = ageParts(dob);
  return a.years >= 2 ? `${a.years} y` : `${a.years * 12 + a.months} m`;
};

// ---- Catalogue -------------------------------------------------------------------------------

const toComponent = (c, ranges) => ({
  id: c.id,
  code: c.code,
  name: c.name,
  resultType: c.result_type,
  unit: c.unit,
  decimals: c.decimals,
  options: c.options,
  abnormalOptions: c.abnormal_options,
  ranges: ranges
    .filter((r) => r.component_id === c.id)
    .map((r) => ({
      id: r.id,
      sex: r.sex,
      ageMinDays: r.age_min_days,
      ageMaxDays: r.age_max_days,
      low: r.low === null ? null : Number(r.low),
      high: r.high === null ? null : Number(r.high),
      criticalLow: r.critical_low === null ? null : Number(r.critical_low),
      criticalHigh: r.critical_high === null ? null : Number(r.critical_high),
    })),
});

/** Tests with their components and ranges. @param {Deps} deps @param {AuthContext} auth */
export async function listTests({ db }, auth, q = {}) {
  const tests = await db('lab_tests as t')
    .leftJoin('charge_items as c', 'c.id', 't.charge_item_id')
    .where('t.facility_id', facilityOf(auth))
    .modify((x) => {
      if (q.active) x.andWhere('t.active', q.active === 'true');
      if (q.q)
        x.andWhereRaw('(lower(t.name) LIKE ? OR lower(t.code) LIKE ?)', [
          `%${q.q.toLowerCase()}%`,
          `%${q.q.toLowerCase()}%`,
        ]);
    })
    .orderBy('t.name')
    .select('t.*', 'c.name as charge_item_name');
  const comps = tests.length
    ? await db('lab_test_components')
        .whereIn(
          'test_id',
          tests.map((t) => t.id),
        )
        .orderBy(['test_id', 'sort'])
    : [];
  const ranges = comps.length
    ? await db('lab_reference_ranges').whereIn(
        'component_id',
        comps.map((c) => c.id),
      )
    : [];
  return tests.map((t) => ({
    id: t.id,
    code: t.code,
    name: t.name,
    section: t.section,
    specimenType: t.specimen_type,
    container: t.container,
    tatMinutes: t.tat_minutes,
    chargeItemId: t.charge_item_id,
    chargeItemName: t.charge_item_name,
    active: t.active,
    components: comps.filter((c) => c.test_id === t.id).map((c) => toComponent(c, ranges)),
  }));
}

/** @param {Deps} deps @param {AuthContext} auth @param {any} input @param {Meta} meta */
export async function createTest({ db }, auth, input, meta) {
  const f = facilityOf(auth);
  const id = await db.transaction(async (trx) => {
    if (await trx('lab_tests').where({ facility_id: f, code: input.code }).first('id'))
      throw conflict(`Test code ${input.code} is taken`);
    if (
      input.chargeItemId &&
      !(await trx('charge_items').where({ id: input.chargeItemId, facility_id: f }).first('id'))
    )
      throw badRequest('That billing item is not at this facility');
    const [t] = await trx('lab_tests')
      .insert({
        facility_id: f,
        code: input.code,
        name: input.name,
        section: input.section,
        specimen_type: input.specimenType,
        container: input.container,
        tat_minutes: input.tatMinutes,
        charge_item_id: input.chargeItemId ?? null,
        created_by: auth.userId,
        updated_by: auth.userId,
      })
      .returning('*');
    for (const [i, c] of input.components.entries()) {
      const [comp] = await trx('lab_test_components')
        .insert({
          test_id: t.id,
          code: c.code,
          name: c.name,
          result_type: c.resultType,
          unit: c.unit ?? null,
          decimals: c.decimals,
          options: c.options ? JSON.stringify(c.options) : null,
          abnormal_options: c.abnormalOptions ? JSON.stringify(c.abnormalOptions) : null,
          sort: i,
        })
        .returning('id');
      if (c.ranges.length)
        await trx('lab_reference_ranges').insert(
          c.ranges.map((r) => ({
            component_id: comp.id,
            sex: r.sex ?? null,
            age_min_days: r.ageMinDays,
            age_max_days: r.ageMaxDays ?? null,
            low: r.low ?? null,
            high: r.high ?? null,
            critical_low: r.criticalLow ?? null,
            critical_high: r.criticalHigh ?? null,
          })),
        );
    }
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'create',
      entityType: 'lab_test',
      entityId: t.id,
      after: input,
    });
    return t.id;
  });
  return (await listTests({ db }, auth)).find((t) => t.id === id);
}

/** @param {Deps} deps @param {AuthContext} auth @param {string} id @param {any} input @param {Meta} meta */
export async function updateTest({ db }, auth, id, input, meta) {
  const f = facilityOf(auth);
  await db.transaction(async (trx) => {
    const before = await trx('lab_tests').where({ id, facility_id: f }).forUpdate().first();
    if (!before) throw notFound('Test');
    if (
      input.chargeItemId &&
      !(await trx('charge_items').where({ id: input.chargeItemId, facility_id: f }).first('id'))
    )
      throw badRequest('That billing item is not at this facility');
    const patch = {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.tatMinutes !== undefined && { tat_minutes: input.tatMinutes }),
      ...(input.container !== undefined && { container: input.container }),
      ...(input.chargeItemId !== undefined && { charge_item_id: input.chargeItemId }),
      ...(input.active !== undefined && { active: input.active }),
      updated_by: auth.userId,
    };
    const [after] = await trx('lab_tests').where({ id }).update(patch).returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'lab_test',
      entityId: id,
      before,
      after,
    });
  });
  return (await listTests({ db }, auth)).find((t) => t.id === id);
}

// ---- Orders ------------------------------------------------------------------------------------

/**
 * Order tests in an open visit. Each test is charged to the visit bill at once.
 * @param {Deps} deps @param {AuthContext} auth @param {string} encounterId @param {any} input @param {Meta} meta
 */
export async function createLabOrder({ db, bus }, auth, encounterId, input, meta) {
  if (input.clientId) {
    const existing = await db('lab_orders').where({ client_id: input.clientId }).first('id');
    if (existing) return getLabOrder({ db }, auth, existing.id);
  }
  const id = await db.transaction(async (trx) => {
    const encounter = await trx('encounters')
      .where({ id: encounterId, facility_id: facilityOf(auth) })
      .first();
    if (!encounter) throw notFound('Visit');
    if (encounter.status !== 'open') throw conflict('This visit is closed');
    const patient = await trx('patients').where({ id: encounter.patient_id }).first();
    await assertClinicalAccess(trx, auth, patient);
    const tests = await trx('lab_tests')
      .whereIn('id', input.tests)
      .andWhere({ facility_id: encounter.facility_id, active: true });
    if (tests.length !== input.tests.length) throw badRequest('Some tests are not available at this lab');
    const [order] = await trx('lab_orders')
      .insert({
        facility_id: encounter.facility_id,
        order_number: await nextDocNumber(trx, encounter.facility_id, 'LAB'),
        encounter_id: encounter.id,
        patient_id: patient.id,
        ordered_by: auth.userId,
        priority: input.priority,
        clinical_notes: input.clinicalNotes ?? null,
        client_id: input.clientId ?? null,
        created_by: auth.userId,
        updated_by: auth.userId,
      })
      .returning('*');
    for (const t of tests) {
      const [item] = await trx('lab_order_items').insert({ order_id: order.id, test_id: t.id }).returning('*');
      if (t.charge_item_id) {
        const line = await postCharge(trx, auth, {
          encounter,
          chargeItemId: t.charge_item_id,
          quantity: 1,
          sourceType: 'lab_order_item',
          sourceId: item.id,
          description: t.name,
        });
        if (line) await trx('lab_order_items').where({ id: item.id }).update({ bill_item_id: line.id });
      }
    }
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'create',
      entityType: 'lab_order',
      entityId: order.id,
      patientId: patient.id,
      after: { ...order, tests: tests.map((t) => t.code) },
    });
    await bus.publish(trx, {
      type: 'lab.ordered',
      aggregateType: 'lab_order',
      aggregateId: order.id,
      facilityId: order.facility_id,
      payload: { encounterId: encounter.id, priority: order.priority, tests: tests.length },
    });
    return order.id;
  });
  return getLabOrder({ db }, auth, id);
}

/**
 * Cancel a test that has not been collected; its bill line is voided.
 * @param {Deps} deps @param {AuthContext} auth @param {string} itemId @param {string} reason @param {Meta} meta
 */
export async function cancelLabItem({ db }, auth, itemId, reason, meta) {
  const orderId = await db.transaction(async (trx) => {
    const item = await trx('lab_order_items as i')
      .join('lab_orders as o', 'o.id', 'i.order_id')
      .where({ 'i.id': itemId, 'o.facility_id': facilityOf(auth) })
      .forUpdate('i')
      .first('i.*', 'o.patient_id');
    if (!item) throw notFound('Test');
    if (item.status !== 'ordered') throw conflict(`This test is already ${item.status}; it cannot be cancelled`);
    const patient = await trx('patients').where({ id: item.patient_id }).first();
    await assertClinicalAccess(trx, auth, patient);
    await trx('lab_order_items')
      .where({ id: itemId })
      .update({ status: 'cancelled', cancelled_at: trx.fn.now(), cancel_reason: reason });
    if (item.bill_item_id) {
      const line = await trx('bill_items').where({ id: item.bill_item_id, status: 'active' }).forUpdate().first();
      if (line) {
        await trx('bills').where({ id: line.bill_id }).forUpdate().first('id');
        await trx('bill_items')
          .where({ id: line.id })
          .update({
            status: 'voided',
            void_reason: `Lab test cancelled: ${reason}`,
            voided_by: auth.userId,
            voided_at: trx.fn.now(),
          });
        await recalcBill(trx, line.bill_id);
      }
    }
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'lab_order_item',
      entityId: itemId,
      patientId: item.patient_id,
      before: { status: item.status },
      after: { status: 'cancelled' },
      reason,
    });
    return item.order_id;
  });
  return getLabOrder({ db }, auth, orderId);
}

// ---- Samples ------------------------------------------------------------------------------------

/**
 * Collect samples for an order's outstanding tests: one tube per specimen and container, each
 * with a new accession for its barcode label.
 * @param {Deps} deps @param {AuthContext} auth @param {string} orderId @param {{itemIds?: string[]}} input @param {Meta} meta
 */
export async function collectSamples({ db }, auth, orderId, input, meta) {
  const samples = await db.transaction(async (trx) => {
    const order = await trx('lab_orders')
      .where({ id: orderId, facility_id: facilityOf(auth) })
      .forUpdate()
      .first();
    if (!order) throw notFound('Lab order');
    const patient = await trx('patients').where({ id: order.patient_id }).first();
    await assertLabAccess(trx, auth, patient);
    const items = await trx('lab_order_items as i')
      .join('lab_tests as t', 't.id', 'i.test_id')
      .where({ 'i.order_id': orderId, 'i.status': 'ordered' })
      .modify((q) => input.itemIds?.length && q.whereIn('i.id', input.itemIds))
      .forUpdate('i')
      .select('i.id', 't.specimen_type', 't.container', 't.name');
    if (!items.length) throw conflict('Nothing on this order is waiting to be collected');
    const groups = new Map();
    for (const it of items) {
      const k = `${it.specimen_type}|${it.container}`;
      groups.set(k, [...(groups.get(k) ?? []), it]);
    }
    const out = [];
    for (const group of groups.values()) {
      const [s] = await trx('lab_samples')
        .insert({
          facility_id: order.facility_id,
          accession: await nextDocNumber(trx, order.facility_id, 'L'),
          order_id: order.id,
          patient_id: order.patient_id,
          specimen_type: group[0].specimen_type,
          container: group[0].container,
          collected_by: auth.userId,
        })
        .returning('*');
      await trx('lab_order_items')
        .whereIn(
          'id',
          group.map((g) => g.id),
        )
        .update({ status: 'collected', sample_id: s.id, collected_at: trx.fn.now() });
      out.push(s.id);
    }
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'create',
      entityType: 'lab_sample',
      entityId: out[0],
      patientId: order.patient_id,
      metadata: { order: order.order_number, samples: out.length, tests: items.length },
    });
    return out;
  });
  return Promise.all(samples.map((id) => sampleLabel({ db }, auth, id)));
}

/** Receive a tube in the lab by scanning its barcode. */
export async function receiveSample({ db }, auth, accession, meta) {
  const id = await db.transaction(async (trx) => {
    const s = await trx('lab_samples')
      .where({ accession, facility_id: facilityOf(auth) })
      .forUpdate()
      .first();
    if (!s) throw notFound(`Sample ${accession}`);
    if (s.status !== 'collected')
      throw conflict(s.status === 'received' ? `${accession} was already received` : `${accession} was rejected`);
    const patient = await trx('patients').where({ id: s.patient_id }).first();
    await assertLabAccess(trx, auth, patient);
    await trx('lab_samples')
      .where({ id: s.id })
      .update({ status: 'received', received_by: auth.userId, received_at: trx.fn.now() });
    await trx('lab_order_items')
      .where({ sample_id: s.id, status: 'collected' })
      .update({ status: 'received', received_at: trx.fn.now() });
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'lab_sample',
      entityId: s.id,
      patientId: s.patient_id,
      after: { status: 'received' },
    });
    return s.id;
  });
  return sampleLabel({ db }, auth, id);
}

/**
 * Reject an unsuitable sample (haemolysed, clotted, unlabelled…). Its tests go back to "ordered"
 * so a new sample can be collected; the rejected tube and reason stay on record.
 */
export async function rejectSample({ db }, auth, sampleId, reason, meta) {
  const orderId = await db.transaction(async (trx) => {
    const s = await trx('lab_samples')
      .where({ id: sampleId, facility_id: facilityOf(auth) })
      .forUpdate()
      .first();
    if (!s) throw notFound('Sample');
    if (s.status === 'rejected') throw conflict('This sample was already rejected');
    const done = await trx('lab_order_items')
      .where({ sample_id: s.id })
      .whereIn('status', ['resulted', 'verified'])
      .first('id');
    if (done) throw conflict('Results have been entered from this sample; amend the results instead');
    const patient = await trx('patients').where({ id: s.patient_id }).first();
    await assertLabAccess(trx, auth, patient);
    await trx('lab_samples')
      .where({ id: s.id })
      .update({ status: 'rejected', rejected_by: auth.userId, rejected_at: trx.fn.now(), rejection_reason: reason });
    await trx('lab_order_items')
      .where({ sample_id: s.id })
      .whereIn('status', ['collected', 'received'])
      .update({ status: 'ordered', sample_id: null, collected_at: null, received_at: null });
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'lab_sample',
      entityId: s.id,
      patientId: s.patient_id,
      after: { status: 'rejected' },
      reason,
    });
    return s.order_id;
  });
  return getLabOrder({ db }, auth, orderId);
}

/** What goes on the tube label: accession (barcode), patient, tests, container, time. */
export async function sampleLabel({ db }, auth, sampleId) {
  const s = await db('lab_samples as s')
    .join('patients as p', 'p.id', 's.patient_id')
    .join('lab_orders as o', 'o.id', 's.order_id')
    .where({ 's.id': sampleId, 's.facility_id': facilityOf(auth) })
    .first(
      's.*',
      'p.first_name',
      'p.middle_name',
      'p.last_name',
      'p.mrn',
      'p.sex',
      'p.date_of_birth',
      'p.is_restricted',
      'o.order_number',
      'o.priority',
    );
  if (!s) throw notFound('Sample');
  await assertLabAccess(db, auth, { id: s.patient_id, is_restricted: s.is_restricted });
  const tests = await db('lab_order_items as i')
    .join('lab_tests as t', 't.id', 'i.test_id')
    .where('i.sample_id', s.id)
    .orderBy('t.name')
    .pluck('t.code');
  return {
    id: s.id,
    accession: s.accession,
    status: s.status,
    specimenType: s.specimen_type,
    container: s.container,
    orderNumber: s.order_number,
    priority: s.priority,
    patient: {
      name: fullName(s),
      mrn: s.mrn,
      sex: s.sex,
      age: ageLabel(s.date_of_birth),
      dateOfBirth: s.date_of_birth,
    },
    tests,
    collectedAt: s.collected_at,
    receivedAt: s.received_at,
    rejectionReason: s.rejection_reason,
  };
}

// ---- Reading orders -----------------------------------------------------------------------------

const minutesSince = (t) => (t ? Math.round((Date.now() - new Date(t).getTime()) / 60000) : null);

/** @param {Deps} deps @param {AuthContext} auth @param {string} id */
export async function getLabOrder({ db }, auth, id) {
  const o = await db('lab_orders as o')
    .join('patients as p', 'p.id', 'o.patient_id')
    .join('users as u', 'u.id', 'o.ordered_by')
    .where({ 'o.id': id, 'o.facility_id': facilityOf(auth) })
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
    );
  if (!o) throw notFound('Lab order');
  await assertLabAccess(db, auth, { id: o.patient_id, is_restricted: o.is_restricted });
  const [items, samples] = await Promise.all([
    db('lab_order_items as i')
      .join('lab_tests as t', 't.id', 'i.test_id')
      .leftJoin('lab_samples as s', 's.id', 'i.sample_id')
      .where('i.order_id', id)
      .orderBy('t.name')
      .select('i.*', 't.code', 't.name', 't.specimen_type', 't.container', 't.tat_minutes', 's.accession'),
    db('lab_samples').where({ order_id: id }).orderBy('collected_at'),
  ]);
  return {
    id: o.id,
    orderNumber: o.order_number,
    encounterId: o.encounter_id,
    priority: o.priority,
    clinicalNotes: o.clinical_notes,
    orderedBy: o.ordered_by_name,
    orderedById: o.ordered_by,
    orderedAt: o.created_at,
    patient: { id: o.patient_id, name: fullName(o), mrn: o.mrn, sex: o.sex, age: ageLabel(o.date_of_birth) },
    items: items.map((i) => {
      const end = i.verified_at ?? (i.status === 'cancelled' ? i.cancelled_at : null);
      const elapsed = end ? Math.round((new Date(end) - new Date(i.ordered_at)) / 60000) : minutesSince(i.ordered_at);
      return {
        id: i.id,
        testId: i.test_id,
        code: i.code,
        name: i.name,
        status: i.status,
        specimenType: i.specimen_type,
        container: i.container,
        accession: i.accession,
        orderedAt: i.ordered_at,
        collectedAt: i.collected_at,
        receivedAt: i.received_at,
        resultedAt: i.resulted_at,
        verifiedAt: i.verified_at,
        cancelReason: i.cancel_reason,
        tatMinutes: i.tat_minutes,
        elapsedMinutes: elapsed,
        overdue: !['verified', 'cancelled'].includes(i.status) && elapsed > i.tat_minutes,
      };
    }),
    samples: samples.map((s) => ({
      id: s.id,
      accession: s.accession,
      specimenType: s.specimen_type,
      container: s.container,
      status: s.status,
      collectedAt: s.collected_at,
      receivedAt: s.received_at,
      rejectionReason: s.rejection_reason,
    })),
  };
}

/** Orders in a visit (for the clinician). */
export async function encounterLabOrders({ db }, auth, encounterId) {
  const e = await db('encounters')
    .where({ id: encounterId, facility_id: facilityOf(auth) })
    .first();
  if (!e) throw notFound('Visit');
  const patient = await db('patients').where({ id: e.patient_id }).first();
  await assertClinicalAccess(db, auth, patient);
  const ids = await db('lab_orders').where({ encounter_id: encounterId }).orderBy('created_at', 'desc').pluck('id');
  return Promise.all(ids.map((id) => getLabOrder({ db }, auth, id)));
}

const STAGE_STATUS = {
  collect: 'ordered',
  receive: 'collected',
  result: 'received',
  verify: 'resulted',
  done: 'verified',
};

/**
 * The lab's worklist for one stage, STAT first then oldest. Restricted patients appear without
 * their name unless you have emergency access.
 * @param {Deps} deps @param {AuthContext} auth @param {{stage: string, q?: string}} q
 */
export async function labWorklist({ db }, auth, q) {
  const status = STAGE_STATUS[q.stage];
  const rows = await db('lab_order_items as i')
    .join('lab_orders as o', 'o.id', 'i.order_id')
    .join('lab_tests as t', 't.id', 'i.test_id')
    .join('patients as p', 'p.id', 'o.patient_id')
    .leftJoin('lab_samples as s', 's.id', 'i.sample_id')
    .where({ 'o.facility_id': facilityOf(auth), 'i.status': status })
    .modify((x) => {
      if (q.stage === 'done') x.andWhere('i.verified_at', '>', db.raw("now() - interval '24 hours'"));
      if (q.q) {
        const like = `%${q.q.toLowerCase()}%`;
        x.andWhere((w) =>
          w
            .whereRaw('lower(p.mrn) LIKE ?', [like])
            .orWhereRaw('p.search_name LIKE ?', [like])
            .orWhereRaw('lower(o.order_number) LIKE ?', [like])
            .orWhereRaw('lower(s.accession) LIKE ?', [like]),
        );
      }
    })
    .orderBy('o.created_at')
    .limit(500)
    .select(
      'i.id',
      'i.status',
      'i.ordered_at',
      't.name as test',
      't.code',
      't.tat_minutes',
      's.accession',
      's.id as sample_id',
      'o.id as order_id',
      'o.order_number',
      'o.priority',
      'p.first_name',
      'p.middle_name',
      'p.last_name',
      'p.mrn',
      'p.is_restricted',
    );
  const orders = new Map();
  for (const r of rows) {
    const o = orders.get(r.order_id) ?? {
      orderId: r.order_id,
      orderNumber: r.order_number,
      priority: r.priority,
      patient: r.is_restricted ? 'Restricted patient' : fullName(r),
      mrn: r.mrn,
      orderedAt: r.ordered_at,
      tests: [],
    };
    const elapsed = minutesSince(r.ordered_at);
    o.tests.push({
      id: r.id,
      code: r.code,
      name: r.test,
      accession: r.accession,
      sampleId: r.sample_id,
      overdue: q.stage !== 'done' && elapsed > r.tat_minutes,
      elapsedMinutes: elapsed,
    });
    orders.set(r.order_id, o);
  }
  // STAT first, then urgent, then routine; oldest first within each.
  const rank = (p) => LAB_PRIORITIES.indexOf(p);
  return [...orders.values()].sort(
    (a, b) => rank(b.priority) - rank(a.priority) || new Date(a.orderedAt) - new Date(b.orderedAt),
  );
}

/** Active tests for ordering (no prices or ranges). */
export async function orderableTests({ db }, auth) {
  return db('lab_tests')
    .where({ facility_id: facilityOf(auth), active: true })
    .orderBy(['section', 'name'])
    .select('id', 'code', 'name', 'section', 'specimen_type as specimenType', 'tat_minutes as tatMinutes');
}
