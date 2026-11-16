// OPD queues, queue tickets and configurable patient routing.
import { AUDIT_COLS, inList, syncable, touch } from '../helpers.js';
import { QUEUE_TICKET_STATUS, SERVICE_POINT_TYPES } from '../../packages/shared/src/enums.js';

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE queues (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id      uuid NOT NULL REFERENCES facilities(id),
      service_point_id uuid NOT NULL UNIQUE REFERENCES service_points(id),
      name             text NOT NULL,
      ticket_prefix    text NOT NULL DEFAULT 'A',
      active           boolean NOT NULL DEFAULT true,
      ${AUDIT_COLS},
      UNIQUE (facility_id, id)
    );

    CREATE TABLE queue_tickets (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id        uuid NOT NULL,
      queue_id           uuid NOT NULL,
      encounter_id       uuid NOT NULL,
      patient_id         uuid NOT NULL REFERENCES patients(id),
      ticket_date        date NOT NULL DEFAULT (now() AT TIME ZONE 'Africa/Nairobi')::date,
      ticket_number      int  NOT NULL,
      priority           smallint NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 2),
      status             text NOT NULL DEFAULT 'waiting' CHECK (status IN (${inList(QUEUE_TICKET_STATUS)})),
      enqueued_at        timestamptz NOT NULL DEFAULT now(),
      called_at          timestamptz,
      service_started_at timestamptz,
      completed_at       timestamptz,
      called_by          uuid REFERENCES users(id),
      served_by          uuid REFERENCES users(id),
      next_queue_id      uuid REFERENCES queues(id),
      outcome_note       text,
      client_id          uuid UNIQUE,
      ${AUDIT_COLS},
      FOREIGN KEY (facility_id, queue_id) REFERENCES queues(facility_id, id),
      FOREIGN KEY (facility_id, encounter_id) REFERENCES encounters(facility_id, id),
      UNIQUE (queue_id, ticket_date, ticket_number)
    );
    CREATE INDEX queue_tickets_board ON queue_tickets (queue_id, status, priority DESC, enqueued_at)
      WHERE status IN ('waiting', 'called', 'in_service');
    CREATE INDEX queue_tickets_encounter ON queue_tickets (encounter_id);

    -- Ordered routing steps per facility and payer type (cash patients pay first,
    -- insured patients go straight to triage, etc.). payer_type NULL = default route.
    CREATE TABLE opd_routes (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id        uuid NOT NULL REFERENCES facilities(id),
      payer_type         text,
      step_order         smallint NOT NULL,
      service_point_type text NOT NULL CHECK (service_point_type IN (${inList(SERVICE_POINT_TYPES)})),
      ${AUDIT_COLS}
    );
    CREATE UNIQUE INDEX opd_routes_step ON opd_routes (facility_id, COALESCE(payer_type, '*'), step_order);
  `);
  for (const t of ['queues', 'queue_tickets', 'opd_routes']) await touch(knex, t);
  await syncable(knex, 'queue_tickets');
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS opd_routes, queue_tickets, queues CASCADE');
}
