// Internal requisitions (e.g. ward → main store: request → approve → issue → receive, with
// variances) and stock takes (count → submit → approve, with the variance posted to the ledger).
// Both are maker-checker: the person who raised or counted can never approve.
import { AUDIT_COLS, touch } from '../helpers.js';

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE requisitions (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id    uuid NOT NULL REFERENCES facilities(id),
      req_number     text NOT NULL,
      -- The store asking (and receiving) and the store supplying.
      from_store_id  uuid NOT NULL,
      to_store_id    uuid NOT NULL,
      status         text NOT NULL DEFAULT 'requested'
        CHECK (status IN ('requested', 'approved', 'issued', 'received', 'rejected', 'cancelled')),
      notes          text,
      requested_by   uuid NOT NULL REFERENCES users(id),
      requested_at   timestamptz NOT NULL DEFAULT now(),
      decided_by     uuid REFERENCES users(id),
      decided_at     timestamptz,
      decision_note  text,
      issued_by      uuid REFERENCES users(id),
      issued_at      timestamptz,
      received_by    uuid REFERENCES users(id),
      received_at    timestamptz,
      ${AUDIT_COLS},
      UNIQUE (facility_id, req_number),
      FOREIGN KEY (facility_id, from_store_id) REFERENCES stores(facility_id, id),
      FOREIGN KEY (facility_id, to_store_id) REFERENCES stores(facility_id, id),
      CHECK (from_store_id <> to_store_id),
      CHECK (decided_by IS NULL OR decided_by <> requested_by)
    );
    CREATE INDEX requisitions_open ON requisitions (facility_id, status, requested_at);

    CREATE TABLE requisition_items (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      requisition_id uuid NOT NULL REFERENCES requisitions(id),
      item_id        uuid NOT NULL REFERENCES items(id),
      requested_qty  numeric(14,3) NOT NULL CHECK (requested_qty > 0),
      approved_qty   numeric(14,3) CHECK (approved_qty >= 0),
      issued_qty     numeric(14,3) NOT NULL DEFAULT 0 CHECK (issued_qty >= 0),
      received_qty   numeric(14,3) NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
      UNIQUE (requisition_id, item_id)
    );

    -- Which batches went out (FEFO), and how much of each arrived.
    CREATE TABLE requisition_issue_lines (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      requisition_id      uuid NOT NULL REFERENCES requisitions(id),
      requisition_item_id uuid NOT NULL REFERENCES requisition_items(id),
      item_id             uuid NOT NULL REFERENCES items(id),
      batch_id            uuid NOT NULL REFERENCES item_batches(id),
      quantity            numeric(14,3) NOT NULL CHECK (quantity > 0),
      unit_cost           numeric(14,4) NOT NULL DEFAULT 0,
      received_qty        numeric(14,3) CHECK (received_qty >= 0 AND received_qty <= quantity),
      variance_reason     text,
      CHECK (received_qty IS NULL OR received_qty = quantity OR variance_reason IS NOT NULL)
    );

    CREATE TABLE stock_takes (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id   uuid NOT NULL REFERENCES facilities(id),
      st_number     text NOT NULL,
      store_id      uuid NOT NULL,
      status        text NOT NULL DEFAULT 'counting'
        CHECK (status IN ('counting', 'submitted', 'approved', 'rejected', 'cancelled')),
      notes         text,
      started_by    uuid NOT NULL REFERENCES users(id),
      started_at    timestamptz NOT NULL DEFAULT now(),
      submitted_by  uuid REFERENCES users(id),
      submitted_at  timestamptz,
      decided_by    uuid REFERENCES users(id),
      decided_at    timestamptz,
      decision_note text,
      ${AUDIT_COLS},
      UNIQUE (facility_id, st_number),
      FOREIGN KEY (facility_id, store_id) REFERENCES stores(facility_id, id),
      CHECK (decided_by IS NULL OR (decided_by <> started_by AND decided_by <> COALESCE(submitted_by, started_by)))
    );
    -- One count at a time per store.
    CREATE UNIQUE INDEX stock_takes_one_open ON stock_takes (store_id) WHERE status IN ('counting', 'submitted');

    CREATE TABLE stock_take_lines (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      stock_take_id uuid NOT NULL REFERENCES stock_takes(id),
      item_id       uuid NOT NULL REFERENCES items(id),
      batch_id      uuid NOT NULL REFERENCES item_batches(id),
      system_qty    numeric(14,3) NOT NULL CHECK (system_qty >= 0),
      counted_qty   numeric(14,3) CHECK (counted_qty >= 0),
      unit_cost     numeric(14,4) NOT NULL DEFAULT 0,
      reason        text,
      counted_by    uuid REFERENCES users(id),
      counted_at    timestamptz,
      UNIQUE (stock_take_id, batch_id)
    );
  `);
  for (const t of ['requisitions', 'stock_takes']) await touch(knex, t);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS stock_take_lines, stock_takes, requisition_issue_lines, requisition_items, requisitions CASCADE;
  `);
}
