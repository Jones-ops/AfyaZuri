// Over-the-counter sales to walk-in customers. The pharmacy rings up the sale (a bill in the
// customer's name), the customer pays at the cashier, and only then is the stock handed over
// (FEFO, an 'otc_sale' movement). Only drugs marked as OTC, and consumables, can be sold this way.
import { AUDIT_COLS, touch } from '../helpers.js';

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE drugs ADD COLUMN otc_allowed boolean NOT NULL DEFAULT false;
    -- Controlled drugs are never sold over the counter.
    ALTER TABLE drugs ADD CONSTRAINT drugs_controlled_not_otc CHECK (NOT (controlled AND otc_allowed));

    CREATE TABLE otc_sales (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id        uuid NOT NULL REFERENCES facilities(id),
      sale_number        text NOT NULL,
      store_id           uuid NOT NULL REFERENCES stores(id),
      bill_id            uuid NOT NULL REFERENCES bills(id),
      customer_name      text NOT NULL,
      customer_phone_enc text,
      status             text NOT NULL DEFAULT 'awaiting_payment'
        CHECK (status IN ('awaiting_payment', 'completed', 'cancelled')),
      completed_by       uuid REFERENCES users(id),
      completed_at       timestamptz,
      cancel_reason      text,
      ${AUDIT_COLS},
      UNIQUE (facility_id, sale_number),
      UNIQUE (bill_id)
    );
    CREATE INDEX otc_sales_open ON otc_sales (facility_id, created_at) WHERE status = 'awaiting_payment';

    CREATE TABLE otc_sale_items (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sale_id      uuid NOT NULL REFERENCES otc_sales(id),
      item_id      uuid NOT NULL REFERENCES items(id),
      quantity     numeric(14,3) NOT NULL CHECK (quantity > 0),
      bill_item_id uuid REFERENCES bill_items(id),
      UNIQUE (sale_id, item_id)
    );

    ALTER TABLE dispensations
      ADD COLUMN otc_sale_id      uuid REFERENCES otc_sales(id),
      ADD COLUMN otc_sale_item_id uuid REFERENCES otc_sale_items(id),
      ADD CONSTRAINT dispensations_source CHECK ((prescription_id IS NULL) <> (otc_sale_id IS NULL));
  `);
  await touch(knex, 'otc_sales');
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    ALTER TABLE dispensations DROP CONSTRAINT IF EXISTS dispensations_source,
      DROP COLUMN IF EXISTS otc_sale_item_id, DROP COLUMN IF EXISTS otc_sale_id;
    DROP TABLE IF EXISTS otc_sale_items, otc_sales CASCADE;
    ALTER TABLE drugs DROP CONSTRAINT IF EXISTS drugs_controlled_not_otc, DROP COLUMN IF EXISTS otc_allowed;
  `);
}
