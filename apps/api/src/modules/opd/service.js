import '../../lib/db-types.js';
// Outpatient flow: check-in → encounter + queue ticket → service points along a
// configurable route (e.g. Registration → Cashier → Triage → Consultation → Exit),
// with detours (Consultation → Lab → back to Consultation).
import { ageLabel, hasPermission, todayNairobi } from '@afyazuri/shared';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { getSetting } from '../../lib/settings.js';
import { recordAudit } from '../audit/service.js';
import { onEncounterClosed, onEncounterOpened } from '../billing/service.js';

/**
 * @typedef {import('../../middleware/auth.js').AuthContext} AuthContext
 * @typedef {{ip?: string|null, userAgent?: string|null, requestId?: string|null}} Meta
 * @typedef {{db: import('knex').Knex, bus: import('../../lib/events.js').EventBus}} Deps
 */

export const ACTIVE_STATUSES = ['waiting', 'called', 'in_service'];

/** Which ticket statuses each action may start from. */
const TRANSITIONS = {
  call: ['waiting', 'called'],
  start: ['waiting', 'called'],
  complete: ['called', 'in_service'],
  no_show: ['waiting', 'called'],
  requeue: ['called', 'in_service'],
};

/** @param {keyof typeof TRANSITIONS} action @param {string} status */
export const canTransition = (action, status) => TRANSITIONS[action]?.includes(status) ?? false;

/** "T-004" @param {string} prefix @param {number} n */
export const ticketLabel = (prefix, n) => `${prefix}-${String(n).padStart(3, '0')}`;

const DEFAULT_ROUTE = ['registration', 'triage', 'consultation', 'exit'];
const actorOf = (/** @type {AuthContext} */ a) => ({
  userId: a.userId,
  username: a.username,
  roles: a.roles,
  facilityId: a.facilityId,
});
const minutesSince = (t) => (t ? Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 60_000)) : null);

/** @param {AuthContext} auth */
function facilityOf(auth) {
  if (!auth.facilityId) throw badRequest('Select a facility first');
  return auth.facilityId;
}

/**
 * Route steps (service point types) for a payer type, falling back to the
 * facility's default route, then to a built-in one.
 * @param {import('knex').Knex | import('knex').Knex.Transaction} db @param {string} facilityId @param {string|null} payerType
 */
export async function routeFor(db, facilityId, payerType) {
  const rows = await db('opd_routes')
    .where({ facility_id: facilityId })
    .andWhere((w) =>
      payerType ? w.where('payer_type', payerType).orWhereNull('payer_type') : w.whereNull('payer_type'),
    )
    .orderBy('step_order');
  const specific = rows.filter((r) => r.payer_type === payerType && payerType !== null);
  const chosen = specific.length ? specific : rows.filter((r) => r.payer_type === null);
  return chosen.length ? chosen.map((r) => r.service_point_type) : DEFAULT_ROUTE;
}

/**
 * The queue of an active service point of this type with the fewest active tickets.
 * @param {import('knex').Knex.Transaction} trx @param {string} facilityId @param {string} type
 */
async function pickQueue(trx, facilityId, type) {
  const q = await trx('queues as q')
    .join('service_points as sp', 'sp.id', 'q.service_point_id')
    .where({ 'q.facility_id': facilityId, 'q.active': true, 'sp.active': true, 'sp.type': type })
    .select('q.*', 'sp.name as service_point_name', 'sp.type as service_point_type', 'sp.department_id')
    .select(
      trx.raw(
        `(SELECT count(*) FROM queue_tickets t WHERE t.queue_id = q.id AND t.status IN ('waiting','called','in_service'))::int AS load`,
      ),
    )
    .orderBy([{ column: 'load' }, { column: 'sp.name' }])
    .first();
  if (!q) throw new AppError(409, 'NO_SERVICE_POINT', `No active ${type} service point is set up at this facility`);
  return q;
}

/** @param {import('knex').Knex | import('knex').Knex.Transaction} db @param {string} facilityId @param {string} queueId */
async function loadQueue(db, facilityId, queueId) {
  const q = await db('queues as q')
    .join('service_points as sp', 'sp.id', 'q.service_point_id')
    .where({ 'q.id': queueId, 'q.facility_id': facilityId })
    .first('q.*', 'sp.name as service_point_name', 'sp.type as service_point_type', 'sp.department_id');
  if (!q) throw notFound('Queue');
  return q;
}

/** Queue work is checked against the queue's department (department-scoped staff run only their own queues). */
function assertCanManage(auth, queue) {
  if (
    !hasPermission(auth.grants, 'opd.queue.manage', { facilityId: auth.facilityId, departmentId: queue.department_id })
  )
    throw forbidden('You can only manage queues in your own department', { required: ['opd.queue.manage'] });
}

/**
 * Put a patient in a queue with the next ticket number for today. The queue row
 * is locked so concurrent check-ins never share a number.
 */
async function enqueue(trx, auth, { encounter, queue, routeStep, priority, referredFrom = null }) {
  await trx('queues').where({ id: queue.id }).forUpdate().first('id');
  const today = todayNairobi();
  const { max } = await trx('queue_tickets')
    .where({ queue_id: queue.id, ticket_date: today })
    .max({ max: 'ticket_number' })
    .first();
  const [t] = await trx('queue_tickets')
    .insert({
      facility_id: auth.facilityId,
      queue_id: queue.id,
      encounter_id: encounter.id,
      patient_id: encounter.patient_id,
      ticket_date: today,
      ticket_number: (max ?? 0) + 1,
      priority,
      status: 'waiting',
      route_step: routeStep,
      referred_from_ticket_id: referredFrom,
      created_by: auth.userId,
      updated_by: auth.userId,
    })
    .returning('*');
  return {
    ...t,
    label: ticketLabel(queue.ticket_prefix, t.ticket_number),
    queueName: queue.name,
    servicePointName: queue.service_point_name,
  };
}

const toTicket = (t, queue) => ({
  id: t.id,
  label: ticketLabel(queue?.ticket_prefix ?? t.ticket_prefix, t.ticket_number),
  number: t.ticket_number,
  status: t.status,
  priority: t.priority,
  queueId: t.queue_id,
  queueName: queue?.name ?? t.queue_name,
  servicePointName: queue?.service_point_name ?? t.service_point_name,
  encounterId: t.encounter_id,
  patientId: t.patient_id,
  enqueuedAt: t.enqueued_at,
  calledAt: t.called_at,
  serviceStartedAt: t.service_started_at,
  completedAt: t.completed_at,
  routeStep: t.route_step,
});

// ---- Check-in ---------------------------------------------------------------

/**
 * Check a patient in: open an OPD/emergency encounter and queue them at the
 * first service point after registration on their payer's route.
 * @param {Deps} deps @param {AuthContext} auth @param {any} input @param {Meta} meta
 */
export async function checkIn({ db, bus }, auth, input, meta) {
  const facilityId = facilityOf(auth);
  if (input.clientId) {
    const existing = await db('encounters').where({ client_id: input.clientId, facility_id: facilityId }).first('id');
    if (existing) return getEncounter({ db }, auth, existing.id);
  }

  const patient = await db('patients')
    .where({ id: input.patientId, facility_id: facilityId })
    .whereNull('deleted_at')
    .first();
  if (!patient) throw notFound('Patient');
  if (patient.merged_into_id)
    throw new AppError(410, 'PATIENT_MERGED', 'This record was merged; check in the surviving record.', {
      survivorId: patient.merged_into_id,
    });
  if (patient.deceased_at) throw conflict('This patient is recorded as deceased');

  const open = await db('encounters')
    .where({ patient_id: patient.id, status: 'open' })
    .whereIn('type', ['opd', 'emergency'])
    .first('id');
  if (open)
    throw new AppError(409, 'ALREADY_CHECKED_IN', 'This patient already has an open visit today.', {
      encounterId: open.id,
    });

  let payerType = 'cash';
  let billingMode = await getSetting(db, facilityId, 'opd.billing_mode.cash', 'pay_first');
  if (input.patientPayerSchemeId) {
    const link = await db('patient_payer_schemes as ps')
      .join('schemes as s', 's.id', 'ps.scheme_id')
      .join('payers as p', 'p.id', 's.payer_id')
      .where({ 'ps.id': input.patientPayerSchemeId, 'ps.patient_id': patient.id, 'ps.active': true })
      .first('p.type as payer_type', 's.billing_mode');
    if (!link) throw badRequest('That payer scheme is not active for this patient');
    payerType = link.payer_type;
    billingMode = link.billing_mode;
  }

  const steps = await routeFor(db, facilityId, payerType);
  const firstStep = steps[0] === 'registration' ? 1 : 0;
  if (steps[firstStep] === 'exit' || !steps[firstStep])
    throw badRequest('The configured route has no service after registration');
  const priority = input.type === 'emergency' ? 2 : input.priority;

  const encounterId = await db.transaction(async (trx) => {
    const queue = await pickQueue(trx, facilityId, steps[firstStep]);
    const [enc] = await trx('encounters')
      .insert({
        facility_id: facilityId,
        patient_id: patient.id,
        type: input.type,
        status: 'open',
        department_id: queue.department_id,
        patient_payer_scheme_id: input.patientPayerSchemeId ?? null,
        billing_mode: billingMode,
        route_payer_type: payerType,
        priority,
        attending_user_id: null,
        client_id: input.clientId ?? null,
        created_by: auth.userId,
        updated_by: auth.userId,
      })
      .returning('*');
    await onEncounterOpened(trx, auth, enc); // consultation (and first-visit registration) fees, same transaction
    const ticket = await enqueue(trx, auth, { encounter: enc, queue, routeStep: firstStep, priority });
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'create',
      entityType: 'encounter',
      entityId: enc.id,
      patientId: patient.id,
      after: enc,
      metadata: { ticket: ticket.label, queue: queue.name, payerType, billingMode },
    });
    await bus.publish(trx, {
      type: 'encounter.opened',
      aggregateType: 'encounter',
      aggregateId: enc.id,
      facilityId,
      payload: { patientId: patient.id, type: enc.type, payerType, billingMode },
    });
    return enc.id;
  });
  return getEncounter({ db }, auth, encounterId);
}

// ---- Encounters --------------------------------------------------------------

/** @param {Deps} deps @param {AuthContext} auth @param {string} id */
export async function getEncounter({ db }, auth, id) {
  const e = await db('encounters as e')
    .join('patients as p', 'p.id', 'e.patient_id')
    .leftJoin('patient_payer_schemes as ps', 'ps.id', 'e.patient_payer_scheme_id')
    .leftJoin('schemes as s', 's.id', 'ps.scheme_id')
    .where({ 'e.id': id, 'e.facility_id': facilityOf(auth) })
    .first(
      'e.*',
      'p.mrn',
      'p.first_name',
      'p.middle_name',
      'p.last_name',
      'p.sex',
      'p.date_of_birth',
      's.name as scheme_name',
    );
  if (!e) throw notFound('Visit');
  const tickets = await db('queue_tickets as t')
    .join('queues as q', 'q.id', 't.queue_id')
    .join('service_points as sp', 'sp.id', 'q.service_point_id')
    .where('t.encounter_id', id)
    .orderBy('t.enqueued_at')
    .select('t.*', 'q.ticket_prefix', 'q.name as queue_name', 'sp.name as service_point_name');
  const all = tickets.map((t) => toTicket(t));
  return {
    id: e.id,
    type: e.type,
    status: e.status,
    startedAt: e.started_at,
    endedAt: e.ended_at,
    priority: e.priority,
    billingMode: e.billing_mode,
    payerType: e.route_payer_type,
    schemeName: e.scheme_name,
    patient: {
      id: e.patient_id,
      mrn: e.mrn,
      fullName: [e.first_name, e.middle_name, e.last_name].filter(Boolean).join(' '),
      sex: e.sex,
      age: ageLabel(e.date_of_birth),
    },
    currentTicket: all.find((t) => ACTIVE_STATUSES.includes(t.status)) ?? null,
    tickets: all,
  };
}

/** Open (or recent) visits, newest first. @param {Deps} deps @param {AuthContext} auth @param {any} q */
export async function listEncounters({ db }, auth, q) {
  const query = db('encounters')
    .where({ facility_id: facilityOf(auth) })
    .orderBy('started_at', 'desc')
    .limit(q.limit);
  if (q.status !== 'all') query.andWhere({ status: q.status });
  if (q.patientId) query.andWhere({ patient_id: q.patientId });
  const ids = await query.pluck('id');
  return Promise.all(ids.map((id) => getEncounter({ db }, auth, id)));
}

/** End a visit; any ticket still in a queue is closed with it. @param {Deps} deps @param {AuthContext} auth @param {string} id @param {string|null} reason @param {Meta} meta */
export async function closeEncounter({ db, bus }, auth, id, reason, meta) {
  await db.transaction(async (trx) => {
    const before = await trx('encounters')
      .where({ id, facility_id: facilityOf(auth) })
      .forUpdate()
      .first();
    if (!before) throw notFound('Visit');
    if (before.status !== 'open') throw conflict('This visit is already closed');
    await closeWithin(trx, auth, before, reason, meta);
    await bus.publish(trx, {
      type: 'encounter.closed',
      aggregateType: 'encounter',
      aggregateId: id,
      facilityId: auth.facilityId,
      payload: {},
    });
  });
  return getEncounter({ db }, auth, id);
}

async function closeWithin(trx, auth, enc, reason, meta) {
  await trx('queue_tickets')
    .where({ encounter_id: enc.id })
    .whereIn('status', ACTIVE_STATUSES)
    .update({ status: 'done', completed_at: trx.fn.now(), outcome_note: 'Visit closed', updated_by: auth.userId });
  const [after] = await trx('encounters')
    .where({ id: enc.id })
    .update({ status: 'closed', ended_at: trx.fn.now(), updated_by: auth.userId })
    .returning('*');
  await onEncounterClosed(trx, enc.id);
  await recordAudit(trx, actorOf(auth), meta, {
    action: 'update',
    entityType: 'encounter',
    entityId: enc.id,
    patientId: enc.patient_id,
    before: enc,
    after,
    reason: reason ?? null,
  });
}

// ---- Queues ------------------------------------------------------------------

/** All queues with live counts. @param {Deps} deps @param {AuthContext} auth */
export async function listQueues({ db }, auth) {
  const facilityId = facilityOf(auth);
  const rows = await db('queues as q')
    .join('service_points as sp', 'sp.id', 'q.service_point_id')
    .where({ 'q.facility_id': facilityId, 'q.active': true, 'sp.active': true })
    .orderBy('sp.name')
    .select(
      'q.id',
      'q.name',
      'q.ticket_prefix',
      'sp.id as service_point_id',
      'sp.type',
      'sp.department_id',
      db.raw(`(SELECT count(*) FROM queue_tickets t WHERE t.queue_id = q.id AND t.status = 'waiting')::int AS waiting`),
      db.raw(
        `(SELECT count(*) FROM queue_tickets t WHERE t.queue_id = q.id AND t.status IN ('called','in_service'))::int AS serving`,
      ),
      db.raw(
        `(SELECT min(t.enqueued_at) FROM queue_tickets t WHERE t.queue_id = q.id AND t.status = 'waiting') AS oldest_waiting`,
      ),
      db.raw(
        `(SELECT count(*) FROM queue_tickets t WHERE t.queue_id = q.id AND t.ticket_date = ? AND t.status IN ('done','referred'))::int AS served_today`,
        [todayNairobi()],
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.ticket_prefix,
    servicePointId: r.service_point_id,
    type: r.type,
    waiting: r.waiting,
    serving: r.serving,
    servedToday: r.served_today,
    longestWaitMinutes: minutesSince(r.oldest_waiting),
    canManage: hasPermission(auth.grants, 'opd.queue.manage', { facilityId, departmentId: r.department_id }),
  }));
}

/** Waiting, called and in-service tickets for one queue, with patient details. @param {Deps} deps @param {AuthContext} auth @param {string} queueId */
export async function queueBoard({ db }, auth, queueId) {
  const facilityId = facilityOf(auth);
  const queue = await loadQueue(db, facilityId, queueId);
  const rows = await db('queue_tickets as t')
    .join('patients as p', 'p.id', 't.patient_id')
    .join('encounters as e', 'e.id', 't.encounter_id')
    .leftJoin('bills as b', function bill() {
      this.on('b.encounter_id', 'e.id').andOnVal('b.status', '<>', 'cancelled');
    })
    .where('t.queue_id', queueId)
    .whereIn('t.status', ACTIVE_STATUSES)
    .orderBy([{ column: 't.priority', order: 'desc' }, { column: 't.enqueued_at' }])
    .select(
      'b.balance as bill_balance',
      'b.id as bill_id',
      't.*',
      'p.mrn',
      'p.first_name',
      'p.middle_name',
      'p.last_name',
      'p.sex',
      'p.date_of_birth',
      'p.is_restricted',
      'e.type as encounter_type',
      'e.billing_mode',
      'e.route_payer_type',
    );
  const steps = new Map();
  const tickets = [];
  for (const t of rows) {
    const key = t.route_payer_type ?? '';
    if (!steps.has(key)) steps.set(key, await routeFor(db, facilityId, t.route_payer_type));
    const route = steps.get(key);
    tickets.push({
      ...toTicket(t, queue),
      waitMinutes: minutesSince(t.enqueued_at),
      encounterType: t.encounter_type,
      billingMode: t.billing_mode,
      payerType: t.route_payer_type,
      billId: t.bill_id,
      balance: t.bill_balance ?? '0.00',
      /** Pay-before-service patient who still owes money (shown as a warning; the cashier collects). */
      unpaid: t.billing_mode === 'pay_first' && Number(t.bill_balance ?? 0) > 0,
      returnsToReferrer: !!t.referred_from_ticket_id,
      nextStep: t.referred_from_ticket_id ? 'return' : (route[(t.route_step ?? 0) + 1] ?? 'exit'),
      patient: {
        id: t.patient_id,
        mrn: t.mrn,
        fullName: [t.first_name, t.middle_name, t.last_name].filter(Boolean).join(' '),
        sex: t.sex,
        age: ageLabel(t.date_of_birth),
        isRestricted: t.is_restricted,
      },
    });
  }
  return {
    queue: {
      id: queue.id,
      name: queue.name,
      prefix: queue.ticket_prefix,
      type: queue.service_point_type,
      servicePointName: queue.service_point_name,
    },
    canManage: hasPermission(auth.grants, 'opd.queue.manage', { facilityId, departmentId: queue.department_id }),
    waiting: tickets.filter((t) => t.status === 'waiting'),
    called: tickets.filter((t) => t.status === 'called'),
    inService: tickets.filter((t) => t.status === 'in_service'),
  };
}

/**
 * Public-screen view: ticket numbers only, never names.
 * @param {Deps} deps @param {AuthContext} auth @param {string} queueId
 */
export async function queueDisplay({ db }, auth, queueId) {
  const queue = await loadQueue(db, facilityOf(auth), queueId);
  const nowServing = await db('queue_tickets')
    .where({ queue_id: queueId })
    .whereIn('status', ['called', 'in_service'])
    .orderBy('called_at', 'desc')
    .limit(6)
    .select('ticket_number', 'status', 'called_at');
  const { n } = await db('queue_tickets').where({ queue_id: queueId, status: 'waiting' }).count({ n: '*' }).first();
  return {
    queueName: queue.name,
    servicePointName: queue.service_point_name,
    nowServing: nowServing.map((t) => ({
      label: ticketLabel(queue.ticket_prefix, t.ticket_number),
      status: t.status,
      calledAt: t.called_at,
    })),
    waiting: Number(n),
  };
}

/** Call the next ticket: emergency first, then urgent, then longest waiting. @param {Deps} deps @param {AuthContext} auth @param {string} queueId @param {Meta} meta */
export async function callNext({ db }, auth, queueId, meta) {
  const facilityId = facilityOf(auth);
  const queue = await loadQueue(db, facilityId, queueId);
  assertCanManage(auth, queue);
  return db.transaction(async (trx) => {
    const t = await trx('queue_tickets')
      .where({ queue_id: queueId, status: 'waiting' })
      .orderBy([{ column: 'priority', order: 'desc' }, { column: 'enqueued_at' }])
      .forUpdate()
      .skipLocked()
      .first();
    if (!t) throw new AppError(409, 'QUEUE_EMPTY', 'Nobody is waiting in this queue');
    return transition(trx, auth, queue, t, 'call', meta);
  });
}

/**
 * Apply a ticket action (call, start, no_show, requeue).
 * @param {Deps} deps @param {AuthContext} auth @param {string} ticketId @param {'call'|'start'|'no_show'|'requeue'} action @param {Meta} meta
 */
export async function ticketAction({ db }, auth, ticketId, action, meta) {
  const facilityId = facilityOf(auth);
  return db.transaction(async (trx) => {
    const t = await trx('queue_tickets').where({ id: ticketId, facility_id: facilityId }).forUpdate().first();
    if (!t) throw notFound('Ticket');
    const queue = await loadQueue(trx, facilityId, t.queue_id);
    assertCanManage(auth, queue);
    return transition(trx, auth, queue, t, action, meta);
  });
}

async function transition(trx, auth, queue, t, action, meta) {
  if (!canTransition(action, t.status))
    throw new AppError(
      409,
      'INVALID_TRANSITION',
      `A ${t.status.replace('_', ' ')} ticket cannot be ${action.replace('_', '-')}ed`,
      { status: t.status },
    );
  const patch = {
    call: { status: 'called', called_at: trx.fn.now(), called_by: auth.userId },
    start: {
      status: 'in_service',
      service_started_at: trx.fn.now(),
      served_by: auth.userId,
      called_at: t.called_at ?? trx.fn.now(),
    },
    no_show: { status: 'no_show', completed_at: trx.fn.now() },
    requeue: { status: 'waiting', called_at: null, service_started_at: null },
  }[action];
  const [after] = await trx('queue_tickets')
    .where({ id: t.id })
    .update({ ...patch, updated_by: auth.userId })
    .returning('*');
  if (action === 'start' && queue.service_point_type === 'consultation')
    await trx('encounters')
      .where({ id: t.encounter_id })
      .whereNull('attending_user_id')
      .update({ attending_user_id: auth.userId });
  await recordAudit(trx, actorOf(auth), meta, {
    action: 'update',
    entityType: 'queue_ticket',
    entityId: t.id,
    patientId: t.patient_id,
    before: t,
    after,
    metadata: { action, queue: queue.name },
  });
  return toTicket(after, queue);
}

/**
 * Finish service at this point and move the patient on: to the next route
 * step, to a chosen service point (a detour that returns here), or out.
 * @param {Deps} deps @param {AuthContext} auth @param {string} ticketId @param {{next: any, note?: string|null}} input @param {Meta} meta
 */
export async function completeTicket({ db, bus }, auth, ticketId, input, meta) {
  const facilityId = facilityOf(auth);
  const result = await db.transaction(async (trx) => {
    const t = await trx('queue_tickets').where({ id: ticketId, facility_id: facilityId }).forUpdate().first();
    if (!t) throw notFound('Ticket');
    const queue = await loadQueue(trx, facilityId, t.queue_id);
    assertCanManage(auth, queue);
    if (!canTransition('complete', t.status))
      throw new AppError(409, 'INVALID_TRANSITION', `A ${t.status.replace('_', ' ')} ticket cannot be completed`, {
        status: t.status,
      });
    const enc = await trx('encounters').where({ id: t.encounter_id }).forUpdate().first();
    if (enc.status !== 'open') throw conflict('This visit is closed');

    let target = null; // { queue, routeStep, referredFrom }
    let finalStatus = 'done';
    if (input.next.kind === 'service_point') {
      const sp = await trx('queues as q')
        .join('service_points as sp', 'sp.id', 'q.service_point_id')
        .where({ 'sp.id': input.next.servicePointId, 'q.facility_id': facilityId, 'sp.active': true, 'q.active': true })
        .first('q.*', 'sp.name as service_point_name', 'sp.type as service_point_type', 'sp.department_id');
      if (!sp) throw badRequest('That service point has no active queue');
      if (sp.id === queue.id) throw badRequest('The patient is already at this service point');
      target = { queue: sp, routeStep: t.route_step, referredFrom: t.id };
      finalStatus = 'referred';
    } else if (input.next.kind === 'route') {
      if (t.referred_from_ticket_id) {
        // A detour (e.g. lab) returns the patient to whoever sent them.
        const origin = await trx('queue_tickets')
          .where({ id: t.referred_from_ticket_id })
          .first('queue_id', 'route_step');
        target = {
          queue: await loadQueue(trx, facilityId, origin.queue_id),
          routeStep: origin.route_step,
          referredFrom: null,
        };
      } else {
        const steps = await routeFor(trx, facilityId, enc.route_payer_type);
        const nextStep = (t.route_step ?? 0) + 1;
        const type = steps[nextStep];
        if (type && type !== 'exit')
          target = { queue: await pickQueue(trx, facilityId, type), routeStep: nextStep, referredFrom: null };
      }
    }

    const [after] = await trx('queue_tickets')
      .where({ id: t.id })
      .update({
        status: finalStatus,
        completed_at: trx.fn.now(),
        served_by: t.served_by ?? auth.userId,
        outcome_note: input.note ?? null,
        next_queue_id: target?.queue.id ?? null,
        updated_by: auth.userId,
      })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'queue_ticket',
      entityId: t.id,
      patientId: t.patient_id,
      before: t,
      after,
      metadata: { action: 'complete', next: input.next.kind, to: target?.queue.name ?? 'exit' },
    });

    if (!target) {
      await closeWithin(trx, auth, enc, input.note ?? 'Exited', meta);
      await bus.publish(trx, {
        type: 'encounter.closed',
        aggregateType: 'encounter',
        aggregateId: enc.id,
        facilityId,
        payload: {},
      });
      return { ticket: toTicket(after, queue), nextTicket: null, encounterClosed: true };
    }
    const next = await enqueue(trx, auth, {
      encounter: enc,
      queue: target.queue,
      routeStep: target.routeStep,
      priority: t.priority,
      referredFrom: target.referredFrom,
    });
    return { ticket: toTicket(after, queue), nextTicket: toTicket(next, target.queue), encounterClosed: false };
  });
  return result;
}

// ---- Route configuration -----------------------------------------------------

/** @param {Deps} deps @param {AuthContext} auth */
export async function listRoutes({ db }, auth) {
  const rows = await db('opd_routes')
    .where({ facility_id: facilityOf(auth) })
    .orderBy(['payer_type', 'step_order']);
  const map = new Map();
  for (const r of rows) {
    const k = r.payer_type ?? null;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r.service_point_type);
  }
  return [...map].map(([payerType, steps]) => ({ payerType, steps }));
}

/** Replace the route for one payer type (or the default). @param {Deps} deps @param {AuthContext} auth @param {{payerType: string|null, steps: string[]}} input @param {Meta} meta */
export async function setRoute({ db }, auth, input, meta) {
  const facilityId = facilityOf(auth);
  await db.transaction(async (trx) => {
    const del = trx('opd_routes').where({ facility_id: facilityId });
    if (input.payerType) del.andWhere({ payer_type: input.payerType });
    else del.whereNull('payer_type');
    const before = (await del.clone().orderBy('step_order').pluck('service_point_type')) ?? [];
    await del.delete();
    await trx('opd_routes').insert(
      input.steps.map((s, i) => ({
        facility_id: facilityId,
        payer_type: input.payerType,
        step_order: i + 1,
        service_point_type: s,
        created_by: auth.userId,
        updated_by: auth.userId,
      })),
    );
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'opd_route',
      entityId: input.payerType ?? 'default',
      before: { steps: before },
      after: { steps: input.steps },
    });
  });
  return listRoutes({ db }, auth);
}
