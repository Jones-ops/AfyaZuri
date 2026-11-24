import '../../lib/db-types.js';
// Prescribing and dispensing.
//
// A prescriber writes a prescription in an open visit. Safety checks run first: a severe drug
// allergy blocks it; other warnings must be acknowledged with a reason, which is kept on the line.
// The pharmacy dispenses from a dispensing store: first-expiry-first-out batches, partial supply
// and substitution (with a reason, and the allergy check re-run for the substitute). Each
// dispensation's stock movement and bill line commit in one transaction.
import { ageParts, fromMilli, suggestQuantity, todayNairobi, toMilli } from '@afyazuri/shared';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { nextDocNumber } from '../../lib/sequences.js';
import { recordAudit } from '../audit/service.js';
import { postCharge } from '../billing/service.js';
import { storeFor } from '../inventory/service.js';
import { allocateFefo, moveStock } from '../inventory/stock.js';
import { assertClinicalAccess, assertServiceAccess } from '../patients/access.js';
import { runChecks } from './checks.js';

/**
 * @typedef {import('../../middleware/auth.js').AuthContext} AuthContext
 * @typedef {{ip?: string|null, userAgent?: string|null, requestId?: string|null}} Meta
 * @typedef {{db: import('knex').Knex, bus: import('../../lib/events.js').EventBus}} Deps
 */

const actorOf = (a) => ({ userId: a.userId, username: a.username, roles: a.roles, facilityId: a.facilityId });
const facilityOf = (auth) => {
  if (!auth.facilityId) throw badRequest('Select a facility first');
  return auth.facilityId;
};
const q3 = (v) => fromMilli(toMilli(v ?? 0));
const fullName = (p) => [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(' ');

const assertRxAccess = (db, auth, patient) => assertServiceAccess(db, auth, patient, 'pharmacy.read');

/** Active drug items of this facility, shaped for the checks and quantity helpers. */
async function loadDrugs(db, facilityId, ids) {
  const rows = await db('items as i')
    .join('drugs as d', 'd.item_id', 'i.id')
    .whereIn('i.id', ids)
    .andWhere({ 'i.facility_id': facilityId, 'i.active': true, 'i.category': 'drug' })
    .select('i.id', 'i.name', 'i.code', 'i.base_unit', 'i.charge_item_id', 'd.*');
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        name: r.name,
        code: r.code,
        baseUnit: r.base_unit,
        chargeItemId: r.charge_item_id,
        drug: {
          genericName: r.generic_name,
          brandName: r.brand_name,
          form: r.form,
          strength: r.strength,
          strengthValue: r.strength_value === null ? null : Number(r.strength_value),
          strengthUnit: r.strength_unit,
          atcCode: r.atc_code,
          controlled: r.controlled,
        },
      },
    ]),
  );
}

async function loadVisit(db, auth, encounterId) {
  const e = await db('encounters')
    .where({ id: encounterId, facility_id: facilityOf(auth) })
    .first();
  if (!e) throw notFound('Visit');
  const p = await db('patients').where({ id: e.patient_id }).first();
  await assertClinicalAccess(db, auth, p);
  return { encounter: e, patient: p };
}

/** Lines with their items and quantities worked out; 400 when a quantity cannot be worked out. */
async function prepareLines(db, facilityId, items) {
  const drugs = await loadDrugs(
    db,
    facilityId,
    items.map((i) => i.itemId),
  );
  const issues = [];
  const lines = items.map((l, n) => {
    const item = drugs.get(l.itemId);
    if (!item) {
      issues.push({ path: `items.${n}.itemId`, message: 'Not an active drug at this facility' });
      return null;
    }
    const qty = l.quantity ?? suggestQuantity(l, item);
    if (!qty) issues.push({ path: `items.${n}.quantity`, message: `Enter how many ${item.baseUnit}s to supply` });
    return { ...l, item, quantity: qty };
  });
  if (issues.length) throw new AppError(400, 'VALIDATION_FAILED', 'Check the prescription', { issues });
  return lines;
}

/**
 * Dry run for the prescribing screen: suggested quantities and every warning.
 * @param {Deps} deps @param {AuthContext} auth @param {string} encounterId @param {any} input
 */
export async function checkPrescription({ db }, auth, encounterId, input) {
  const { patient } = await loadVisit(db, auth, encounterId);
  const lines = await prepareLines(db, patient.facility_id, input.items);
  const warnings = await runChecks(db, { patient }, lines);
  return { items: lines.map((l) => ({ itemId: l.itemId, quantity: q3(l.quantity) })), warnings };
}

/** @param {Deps} deps @param {AuthContext} auth @param {string} encounterId @param {any} input @param {Meta} meta */
export async function createPrescription({ db, bus }, auth, encounterId, input, meta) {
  if (input.clientId) {
    const existing = await db('prescriptions').where({ client_id: input.clientId }).first('id');
    if (existing) return getPrescription({ db }, auth, existing.id);
  }
  const id = await db.transaction(async (trx) => {
    const { encounter, patient } = await loadVisit(trx, auth, encounterId);
    if (encounter.status !== 'open') throw conflict('This visit is closed');
    const lines = await prepareLines(trx, encounter.facility_id, input.items);
    const warnings = await runChecks(trx, { patient }, lines);
    const blocks = warnings.filter((w) => w.severity === 'block');
    if (blocks.length)
      throw new AppError(409, 'RX_BLOCKED', 'This prescription cannot be given: the patient has a severe allergy.', {
        warnings: blocks,
      });
    const reasonFor = (w) => input.overrides.find((o) => o.itemId === w.itemId && o.code === w.code)?.reason;
    const unacknowledged = warnings.filter((w) => !reasonFor(w));
    if (unacknowledged.length)
      throw new AppError(409, 'RX_WARNINGS', 'Review the warnings and give a reason to go ahead.', { warnings });

    const [rx] = await trx('prescriptions')
      .insert({
        facility_id: encounter.facility_id,
        rx_number: await nextDocNumber(trx, encounter.facility_id, 'RX'),
        encounter_id: encounter.id,
        patient_id: patient.id,
        prescriber_id: auth.userId,
        notes: input.notes ?? null,
        client_id: input.clientId ?? null,
        created_by: auth.userId,
        updated_by: auth.userId,
      })
      .returning('*');
    await trx('prescription_items').insert(
      lines.map((l) => ({
        prescription_id: rx.id,
        item_id: l.itemId,
        dose_value: l.doseValue,
        dose_unit: l.doseUnit,
        route: l.route,
        frequency: l.frequency,
        duration_days: l.durationDays ?? null,
        quantity: l.quantity,
        instructions: l.instructions ?? null,
        warnings: JSON.stringify(
          warnings.filter((w) => w.itemId === l.itemId).map((w) => ({ ...w, overrideReason: reasonFor(w) })),
        ),
      })),
    );
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'create',
      entityType: 'prescription',
      entityId: rx.id,
      patientId: patient.id,
      after: {
        ...rx,
        items: lines.map((l) => ({
          drug: l.item.name,
          dose: `${l.doseValue} ${l.doseUnit}`,
          frequency: l.frequency,
          quantity: l.quantity,
        })),
      },
      metadata: warnings.length ? { overridden: warnings.map((w) => w.code) } : undefined,
    });
    await bus.publish(trx, {
      type: 'prescription.created',
      aggregateType: 'prescription',
      aggregateId: rx.id,
      facilityId: encounter.facility_id,
      payload: { encounterId: encounter.id, items: lines.length },
    });
    return rx.id;
  });
  return getPrescription({ db }, auth, id);
}

const statusAfter = (items) => {
  const live = items.filter((i) => i.status !== 'cancelled');
  if (!live.length) return 'cancelled';
  if (live.every((i) => i.status === 'dispensed')) return 'dispensed';
  return live.some((i) => toMilli(i.dispensed_qty) > 0) ? 'partially_dispensed' : 'active';
};

/**
 * Stop what has not been supplied yet. Dispensed quantities stay on record.
 * @param {Deps} deps @param {AuthContext} auth @param {string} id @param {string} reason @param {Meta} meta
 */
export async function cancelPrescription({ db }, auth, id, reason, meta) {
  await db.transaction(async (trx) => {
    const rx = await trx('prescriptions')
      .where({ id, facility_id: facilityOf(auth) })
      .forUpdate()
      .first();
    if (!rx) throw notFound('Prescription');
    if (['dispensed', 'cancelled'].includes(rx.status)) throw conflict(`This prescription is ${rx.status}`);
    const p = await trx('patients').where({ id: rx.patient_id }).first();
    await assertClinicalAccess(trx, auth, p);
    const items = await trx('prescription_items').where({ prescription_id: id }).forUpdate();
    for (const i of items) {
      if (['dispensed', 'cancelled'].includes(i.status)) continue;
      const status = toMilli(i.dispensed_qty) > 0 ? 'dispensed' : 'cancelled';
      await trx('prescription_items').where({ id: i.id }).update({ status, cancel_reason: reason });
      i.status = status;
    }
    const [after] = await trx('prescriptions')
      .where({ id })
      .update({ status: statusAfter(items), updated_by: auth.userId })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'prescription',
      entityId: id,
      patientId: rx.patient_id,
      before: rx,
      after,
      reason,
    });
  });
  return getPrescription({ db }, auth, id);
}

/**
 * Dispense from a dispensing store. Partial supply is allowed; substitution needs a reason and a
 * substitute the patient is not severely allergic to.
 * @param {Deps} deps @param {AuthContext} auth @param {string} id @param {any} input @param {Meta} meta
 */
export async function dispense({ db, bus }, auth, id, input, meta) {
  const given = await db.transaction(async (trx) => {
    const rx = await trx('prescriptions')
      .where({ id, facility_id: facilityOf(auth) })
      .forUpdate()
      .first();
    if (!rx) throw notFound('Prescription');
    if (!['active', 'partially_dispensed'].includes(rx.status))
      throw conflict(`This prescription is ${rx.status.replace('_', ' ')}`);
    const store = await storeFor(trx, auth, input.storeId, 'pharmacy.dispense');
    if (!store.dispensing) throw badRequest(`${store.name} is not a dispensing store`);
    const patient = await trx('patients').where({ id: rx.patient_id }).first();
    await assertRxAccess(trx, auth, patient);
    const encounter = await trx('encounters').where({ id: rx.encounter_id }).first();
    const items = await trx('prescription_items').where({ prescription_id: id }).forUpdate();

    const issues = [];
    if (new Set(input.lines.map((l) => l.prescriptionItemId)).size !== input.lines.length)
      issues.push({ path: 'lines', message: 'Each line once' });
    const subIds = input.lines.map((l) => l.substituteItemId).filter(Boolean);
    const drugs = await loadDrugs(trx, rx.facility_id, [...new Set([...items.map((i) => i.item_id), ...subIds])]);
    for (const [n, l] of input.lines.entries()) {
      const pi = items.find((i) => i.id === l.prescriptionItemId);
      if (!pi) issues.push({ path: `lines.${n}.prescriptionItemId`, message: 'Not on this prescription' });
      else if (!['pending', 'partially_dispensed'].includes(pi.status))
        issues.push({ path: `lines.${n}.prescriptionItemId`, message: `Already ${pi.status.replace('_', ' ')}` });
      else if (toMilli(l.quantity) > toMilli(pi.quantity) - toMilli(pi.dispensed_qty))
        issues.push({
          path: `lines.${n}.quantity`,
          message: `Only ${fromMilli(toMilli(pi.quantity) - toMilli(pi.dispensed_qty))} left to supply`,
        });
      if (l.substituteItemId && !drugs.get(l.substituteItemId))
        issues.push({ path: `lines.${n}.substituteItemId`, message: 'Not an active drug at this facility' });
    }
    if (issues.length) throw new AppError(400, 'VALIDATION_FAILED', 'Check what you are dispensing', { issues });

    // A substitute gets the allergy check again.
    const subs = input.lines.filter((l) => l.substituteItemId);
    if (subs.length) {
      const checks = await runChecks(
        trx,
        { patient, excludePrescriptionId: id },
        subs.map((l) => {
          const pi = items.find((i) => i.id === l.prescriptionItemId);
          return {
            itemId: l.substituteItemId,
            doseValue: Number(pi.dose_value),
            doseUnit: pi.dose_unit,
            route: pi.route,
            frequency: pi.frequency,
            item: drugs.get(l.substituteItemId),
          };
        }),
      );
      const blocked = checks.filter((w) => w.code === 'ALLERGY' && w.severity === 'block');
      if (blocked.length)
        throw new AppError(409, 'RX_BLOCKED', 'The patient is severely allergic to that substitute.', {
          warnings: blocked,
        });
    }

    const out = [];
    for (const l of input.lines) {
      const pi = items.find((i) => i.id === l.prescriptionItemId);
      const item = drugs.get(l.substituteItemId ?? pi.item_id);
      const picks = await allocateFefo(trx, { storeId: store.id, itemId: item.id, quantity: l.quantity });
      const [d] = await trx('dispensations')
        .insert({
          facility_id: rx.facility_id,
          prescription_id: id,
          prescription_item_id: pi.id,
          store_id: store.id,
          item_id: item.id,
          quantity: l.quantity,
          substituted_from_item_id: l.substituteItemId ? pi.item_id : null,
          substitution_reason: l.substituteItemId ? l.substitutionReason : null,
          dispensed_by: auth.userId,
        })
        .returning('*');
      for (const p of picks) {
        await trx('dispensation_batches').insert({ dispensation_id: d.id, batch_id: p.batchId, quantity: p.quantity });
        await moveStock(trx, {
          facilityId: rx.facility_id,
          storeId: store.id,
          itemId: item.id,
          batchId: p.batchId,
          quantity: -p.quantity,
          type: 'dispense',
          unitCost: p.unitCost,
          referenceType: 'dispensation',
          referenceId: d.id,
          userId: auth.userId,
        });
      }
      let line = null;
      if (item.chargeItemId)
        line = await postCharge(trx, auth, {
          encounter,
          chargeItemId: item.chargeItemId,
          quantity: Number(Number(l.quantity).toFixed(2)),
          sourceType: 'dispensation',
          sourceId: d.id,
          departmentId: store.department_id,
          description: item.name,
        });
      if (line) await trx('dispensations').where({ id: d.id }).update({ bill_item_id: line.id });
      const dispensed = toMilli(pi.dispensed_qty) + toMilli(l.quantity);
      const status = dispensed >= toMilli(pi.quantity) ? 'dispensed' : 'partially_dispensed';
      await trx('prescription_items')
        .where({ id: pi.id })
        .update({ dispensed_qty: fromMilli(dispensed), status });
      pi.dispensed_qty = fromMilli(dispensed);
      pi.status = status;
      out.push({
        dispensationId: d.id,
        item: item.name,
        quantity: q3(l.quantity),
        substituted: !!l.substituteItemId,
        batches: picks.map((p) => ({ batchNumber: p.batchNumber, expiryDate: p.expiryDate, quantity: q3(p.quantity) })),
        billed: !!line,
      });
    }
    const [after] = await trx('prescriptions')
      .where({ id })
      .update({ status: statusAfter(items), updated_by: auth.userId })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'create',
      entityType: 'dispensation',
      entityId: id,
      patientId: rx.patient_id,
      after: { prescription: after.rx_number, store: store.code, lines: out },
    });
    await bus.publish(trx, {
      type: 'prescription.dispensed',
      aggregateType: 'prescription',
      aggregateId: id,
      facilityId: rx.facility_id,
      payload: { storeId: store.id, lines: out.length },
    });
    return out;
  });
  return { dispensed: given, prescription: await getPrescription({ db }, auth, id) };
}

/**
 * One prescription for the prescriber or the pharmacy: lines, what is left, stock in a store,
 * the patient's drug allergies and the warnings recorded at prescribing.
 * @param {Deps} deps @param {AuthContext} auth @param {string} id @param {{storeId?: string}} [q]
 */
export async function getPrescription({ db }, auth, id, q = {}) {
  const rx = await db('prescriptions as r')
    .join('users as u', 'u.id', 'r.prescriber_id')
    .join('patients as p', 'p.id', 'r.patient_id')
    .where({ 'r.id': id, 'r.facility_id': facilityOf(auth) })
    .first(
      'r.*',
      'u.full_name as prescriber',
      'p.first_name',
      'p.middle_name',
      'p.last_name',
      'p.mrn',
      'p.sex',
      'p.date_of_birth',
      'p.is_restricted',
      'p.id as pid',
    );
  if (!rx) throw notFound('Prescription');
  await assertRxAccess(db, auth, { id: rx.pid, is_restricted: rx.is_restricted });
  const today = todayNairobi();
  const [items, allergies, dispensed] = await Promise.all([
    db('prescription_items as pi')
      .join('items as i', 'i.id', 'pi.item_id')
      .leftJoin('drugs as d', 'd.item_id', 'pi.item_id')
      .where('pi.prescription_id', id)
      .orderBy('i.name')
      .select('pi.*', 'i.name', 'i.code', 'i.base_unit', 'd.generic_name', 'd.strength', 'd.form'),
    db('allergies')
      .where({ patient_id: rx.patient_id, status: 'active' })
      .whereNull('entered_in_error_at')
      .select('category', 'allergen', 'severity', 'reaction'),
    db('dispensations as x')
      .join('items as i', 'i.id', 'x.item_id')
      .join('users as u', 'u.id', 'x.dispensed_by')
      .join('stores as s', 's.id', 'x.store_id')
      .where('x.prescription_id', id)
      .orderBy('x.dispensed_at')
      .select('x.*', 'i.name', 'u.full_name as by', 's.name as store'),
  ]);
  let stock = new Map();
  if (q.storeId) {
    const rows = await db('stock_levels as l')
      .join('item_batches as b', 'b.id', 'l.batch_id')
      .where('l.store_id', q.storeId)
      .whereIn(
        'l.item_id',
        items.map((i) => i.item_id),
      )
      .andWhere('b.expiry_date', '>=', today)
      .groupBy('l.item_id')
      .select('l.item_id', db.raw('sum(l.quantity) AS q'));
    stock = new Map(rows.map((r) => [r.item_id, q3(r.q)]));
  }
  const age = ageParts(rx.date_of_birth);
  return {
    id: rx.id,
    rxNumber: rx.rx_number,
    status: rx.status,
    encounterId: rx.encounter_id,
    notes: rx.notes,
    prescriber: rx.prescriber,
    prescriberId: rx.prescriber_id,
    createdAt: rx.created_at,
    patient: {
      id: rx.pid,
      name: fullName(rx),
      mrn: rx.mrn,
      sex: rx.sex,
      age: age.years >= 2 ? `${age.years} y` : `${age.years * 12 + age.months} m`,
    },
    allergies: allergies.map((a) => ({
      category: a.category,
      allergen: a.allergen,
      severity: a.severity,
      reaction: a.reaction,
    })),
    items: items.map((i) => ({
      id: i.id,
      itemId: i.item_id,
      name: i.name,
      code: i.code,
      genericName: i.generic_name,
      strength: i.strength,
      form: i.form,
      baseUnit: i.base_unit,
      dose: `${Number(i.dose_value)} ${i.dose_unit}`,
      route: i.route,
      frequency: i.frequency,
      durationDays: i.duration_days,
      instructions: i.instructions,
      quantity: q3(i.quantity),
      dispensedQty: q3(i.dispensed_qty),
      remaining: fromMilli(Math.max(toMilli(i.quantity) - toMilli(i.dispensed_qty), 0)),
      status: i.status,
      warnings: i.warnings,
      cancelReason: i.cancel_reason,
      inStock: q.storeId ? (stock.get(i.item_id) ?? '0') : null,
    })),
    dispensations: dispensed.map((d) => ({
      id: d.id,
      item: d.name,
      quantity: q3(d.quantity),
      store: d.store,
      by: d.by,
      at: d.dispensed_at,
      substitutionReason: d.substitution_reason,
    })),
  };
}

/** Prescriptions of one visit (prescriber view). @param {Deps} deps @param {AuthContext} auth @param {string} encounterId */
export async function encounterPrescriptions({ db }, auth, encounterId) {
  await loadVisit(db, auth, encounterId);
  const ids = await db('prescriptions').where({ encounter_id: encounterId }).orderBy('created_at', 'desc').pluck('id');
  return Promise.all(ids.map((id) => getPrescription({ db }, auth, id)));
}

/**
 * Pharmacy worklist: prescriptions waiting (oldest first), or recently finished.
 * Restricted patients appear without their name unless you have break-the-glass access.
 * @param {Deps} deps @param {AuthContext} auth @param {{status: string, q?: string}} q
 */
export async function worklist({ db }, auth, q) {
  const statuses = { open: ['active', 'partially_dispensed'], dispensed: ['dispensed'], cancelled: ['cancelled'] }[
    q.status
  ];
  const rows = await db('prescriptions as r')
    .join('patients as p', 'p.id', 'r.patient_id')
    .join('users as u', 'u.id', 'r.prescriber_id')
    .where('r.facility_id', facilityOf(auth))
    .whereIn('r.status', statuses)
    .modify((x) => {
      if (q.q) {
        const like = `%${q.q.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
        x.andWhere((w) =>
          w
            .whereRaw('lower(p.mrn) LIKE ?', [like])
            .orWhereRaw('p.search_name LIKE ?', [like])
            .orWhereRaw('lower(r.rx_number) LIKE ?', [like]),
        );
      }
    })
    .orderBy('r.created_at', q.status === 'open' ? 'asc' : 'desc')
    .limit(200)
    .select(
      'r.id',
      'r.rx_number',
      'r.status',
      'r.created_at',
      'p.first_name',
      'p.middle_name',
      'p.last_name',
      'p.mrn',
      'p.is_restricted',
      'u.full_name as prescriber',
      db.raw('(SELECT count(*)::int FROM prescription_items pi WHERE pi.prescription_id = r.id) AS items'),
    );
  return rows.map((r) => ({
    id: r.id,
    rxNumber: r.rx_number,
    status: r.status,
    createdAt: r.created_at,
    patient: r.is_restricted ? 'Restricted patient' : fullName(r),
    mrn: r.mrn,
    prescriber: r.prescriber,
    items: r.items,
  }));
}

// ---- Dose rules ------------------------------------------------------------------------------

const toRule = (r) => ({
  id: r.id,
  scope: r.facility_id ? 'facility' : 'standard',
  genericName: r.generic_name,
  route: r.route,
  minAgeMonths: r.min_age_months,
  maxAgeMonths: r.max_age_months,
  doseUnit: r.dose_unit,
  minSingleDose: r.min_single_dose === null ? null : Number(r.min_single_dose),
  maxSingleDose: r.max_single_dose === null ? null : Number(r.max_single_dose),
  maxDailyDose: r.max_daily_dose === null ? null : Number(r.max_daily_dose),
  maxDailyPerKg: r.max_daily_per_kg === null ? null : Number(r.max_daily_per_kg),
  note: r.note,
  active: r.active,
});

/** @param {Deps} deps @param {AuthContext} auth */
export async function listDoseRules({ db }, auth) {
  const rows = await db('dose_rules')
    .where((w) => w.whereNull('facility_id').orWhere('facility_id', facilityOf(auth)))
    .orderBy(['generic_name', 'min_age_months']);
  return rows.map(toRule);
}

const ruleRow = (i) => ({
  generic_name: i.genericName.toLowerCase(),
  route: i.route ?? null,
  min_age_months: i.minAgeMonths ?? null,
  max_age_months: i.maxAgeMonths ?? null,
  dose_unit: i.doseUnit,
  min_single_dose: i.minSingleDose ?? null,
  max_single_dose: i.maxSingleDose ?? null,
  max_daily_dose: i.maxDailyDose ?? null,
  max_daily_per_kg: i.maxDailyPerKg ?? null,
  note: i.note ?? null,
});

/** A facility's own rule (standard rules are left as they are). */
export async function createDoseRule({ db }, auth, input, meta) {
  return db.transaction(async (trx) => {
    const [r] = await trx('dose_rules')
      .insert({ ...ruleRow(input), facility_id: facilityOf(auth), created_by: auth.userId, updated_by: auth.userId })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'create',
      entityType: 'dose_rule',
      entityId: r.id,
      after: r,
    });
    return toRule(r);
  });
}

/** Switch a rule on or off (a facility may switch off a standard rule only by adding its own). */
export async function setDoseRuleActive({ db }, auth, id, active, meta) {
  return db.transaction(async (trx) => {
    const before = await trx('dose_rules')
      .where({ id, facility_id: facilityOf(auth) })
      .first();
    if (!before) throw notFound('Dose rule (standard rules cannot be changed here)');
    const [after] = await trx('dose_rules').where({ id }).update({ active, updated_by: auth.userId }).returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'dose_rule',
      entityId: id,
      before,
      after,
    });
    return toRule(after);
  });
}

/**
 * Drug search for prescribers: active drugs with their strength and form, and whether any
 * dispensing store has them in date. No costs or batch details.
 * @param {Deps} deps @param {AuthContext} auth @param {{q: string}} q
 */
export async function formulary({ db }, auth, q) {
  const f = facilityOf(auth);
  const like = `%${q.q.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const rows = await db('items as i')
    .join('drugs as d', 'd.item_id', 'i.id')
    .where({ 'i.facility_id': f, 'i.active': true, 'i.category': 'drug' })
    .andWhere((w) =>
      w
        .whereRaw('lower(i.name) LIKE ?', [like])
        .orWhereRaw('lower(d.generic_name) LIKE ?', [like])
        .orWhereRaw('lower(d.brand_name) LIKE ?', [like])
        .orWhereRaw('lower(i.code) LIKE ?', [like]),
    )
    .orderBy('i.name')
    .limit(20)
    .select(
      'i.id',
      'i.code',
      'i.name',
      'i.base_unit',
      'd.*',
      db.raw(
        `EXISTS (SELECT 1 FROM stock_levels l JOIN stores s ON s.id = l.store_id JOIN item_batches b ON b.id = l.batch_id
                 WHERE l.item_id = i.id AND s.dispensing AND s.active AND l.quantity > 0 AND b.expiry_date >= ?) AS in_stock`,
        [todayNairobi()],
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    baseUnit: r.base_unit,
    inStock: r.in_stock,
    drug: {
      genericName: r.generic_name,
      brandName: r.brand_name,
      form: r.form,
      strength: r.strength,
      strengthValue: r.strength_value === null ? null : Number(r.strength_value),
      strengthUnit: r.strength_unit,
      defaultRoute: r.default_route,
      keml: r.keml,
      atcCode: r.atc_code,
    },
  }));
}
