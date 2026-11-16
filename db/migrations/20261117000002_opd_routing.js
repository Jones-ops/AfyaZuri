// Phase 2 OPD: remember which route an encounter follows and where each ticket sits on it,
// so "send to next step" works and reports can measure each stage.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE encounters ADD COLUMN route_payer_type text;
    ALTER TABLE encounters ADD COLUMN priority smallint NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 2);
    ALTER TABLE queue_tickets ADD COLUMN route_step smallint;
    ALTER TABLE queue_tickets ADD COLUMN referred_from_ticket_id uuid REFERENCES queue_tickets(id);
    CREATE INDEX queue_tickets_daily ON queue_tickets (facility_id, ticket_date);
    CREATE UNIQUE INDEX encounters_one_open_opd ON encounters (patient_id)
      WHERE status = 'open' AND type IN ('opd', 'emergency');
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    DROP INDEX IF EXISTS encounters_one_open_opd;
    DROP INDEX IF EXISTS queue_tickets_daily;
    ALTER TABLE queue_tickets DROP COLUMN IF EXISTS referred_from_ticket_id;
    ALTER TABLE queue_tickets DROP COLUMN IF EXISTS route_step;
    ALTER TABLE encounters DROP COLUMN IF EXISTS priority;
    ALTER TABLE encounters DROP COLUMN IF EXISTS route_payer_type;
  `);
}
