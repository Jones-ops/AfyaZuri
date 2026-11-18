// Inventory core: stores, item master (with drug details and pack sizes), suppliers, batches,
// purchase orders, goods received notes, reorder levels and the stock ledger.
//
// stock_movements is an append-only ledger (updates and deletes are refused by trigger).
// stock_levels holds the on-hand quantity per store and batch; it only ever changes in the same
// transaction as the movement row that explains it, and can never go negative.
import { AUDIT_COLS, inList, touch } from '../helpers.js';
import { INVENTORY_CATEGORIES, MOVEMENT_TYPES, STORE_TYPES } from '../../packages/shared/src/enums.js';

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE document_sequences (
      facility_id uuid NOT NULL REFERENCES facilities(id),
      prefix      text NOT NULL,
      year        int  NOT NULL,
      last_value  int  NOT NULL DEFAULT 0,
      PRIMARY KEY (facility_id, prefix, year)
    );

    CREATE TABLE stores (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id   uuid NOT NULL REFERENCES facilities(id),
      code          text NOT NULL,
      name          text NOT NULL,
      type          text NOT NULL CHECK (type IN (${inList(STORE_TYPES)})),
      -- Who may work the store: department-scoped grants apply to the store's department.
      department_id uuid NOT NULL REFERENCES departments(id),
      dispensing    boolean NOT NULL DEFAULT false,
      active        boolean NOT NULL DEFAULT true,
      ${AUDIT_COLS},
      UNIQUE (facility_id, code),
      UNIQUE (facility_id, id)
    );

    CREATE TABLE items (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id    uuid NOT NULL REFERENCES facilities(id),
      code           text NOT NULL,
      name           text NOT NULL,
      category       text NOT NULL CHECK (category IN (${inList(INVENTORY_CATEGORIES)})),
      base_unit      text NOT NULL,
      -- What the patient is billed when this item is dispensed or sold (price comes from the price list).
      charge_item_id uuid,
      -- Weighted average cost per base unit across the facility, updated on every receipt.
      average_cost   numeric(14,4) NOT NULL DEFAULT 0 CHECK (average_cost >= 0),
      active         boolean NOT NULL DEFAULT true,
      ${AUDIT_COLS},
      UNIQUE (facility_id, code),
      UNIQUE (facility_id, id),
      FOREIGN KEY (facility_id, charge_item_id) REFERENCES charge_items(facility_id, id)
    );
    CREATE INDEX items_name_trgm ON items USING gin (lower(name) gin_trgm_ops);

    CREATE TABLE drugs (
      item_id        uuid PRIMARY KEY REFERENCES items(id),
      generic_name   text NOT NULL,
      brand_name     text,
      form           text NOT NULL,
      strength       text,
      strength_value numeric(12,4),
      strength_unit  text,
      default_route  text,
      keml           boolean NOT NULL DEFAULT false,
      atc_code       text,
      controlled     boolean NOT NULL DEFAULT false
    );
    CREATE INDEX drugs_generic_trgm ON drugs USING gin (lower(generic_name) gin_trgm_ops);
    CREATE INDEX drugs_atc ON drugs (atc_code);

    CREATE TABLE item_pack_sizes (
      id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      item_id  uuid NOT NULL REFERENCES items(id),
      name     text NOT NULL,
      base_qty numeric(12,3) NOT NULL CHECK (base_qty > 0),
      UNIQUE (item_id, name)
    );

    CREATE TABLE suppliers (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id uuid NOT NULL REFERENCES facilities(id),
      name        text NOT NULL,
      kra_pin     text,
      phone       text,
      email       text,
      address     text,
      active      boolean NOT NULL DEFAULT true,
      ${AUDIT_COLS},
      UNIQUE (facility_id, name),
      UNIQUE (facility_id, id)
    );

    CREATE TABLE item_batches (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id  uuid NOT NULL,
      item_id      uuid NOT NULL,
      batch_number text NOT NULL,
      expiry_date  date NOT NULL,
      supplier_id  uuid REFERENCES suppliers(id),
      unit_cost    numeric(14,4) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
      created_at   timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (facility_id, item_id) REFERENCES items(facility_id, id),
      UNIQUE (item_id, batch_number, expiry_date),
      UNIQUE (facility_id, id)
    );
    CREATE INDEX item_batches_expiry ON item_batches (facility_id, expiry_date);

    CREATE TABLE stock_levels (
      store_id   uuid NOT NULL REFERENCES stores(id),
      batch_id   uuid NOT NULL REFERENCES item_batches(id),
      item_id    uuid NOT NULL REFERENCES items(id),
      quantity   numeric(14,3) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (store_id, batch_id)
    );
    CREATE INDEX stock_levels_store_item ON stock_levels (store_id, item_id) WHERE quantity > 0;

    CREATE TABLE reorder_levels (
      store_id      uuid NOT NULL REFERENCES stores(id),
      item_id       uuid NOT NULL REFERENCES items(id),
      reorder_level numeric(14,3) NOT NULL CHECK (reorder_level >= 0),
      reorder_qty   numeric(14,3) NOT NULL CHECK (reorder_qty > 0),
      max_level     numeric(14,3) CHECK (max_level IS NULL OR max_level >= reorder_level),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      updated_by    uuid REFERENCES users(id),
      PRIMARY KEY (store_id, item_id)
    );

    CREATE TABLE purchase_orders (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id   uuid NOT NULL REFERENCES facilities(id),
      po_number     text NOT NULL,
      supplier_id   uuid NOT NULL,
      store_id      uuid NOT NULL,
      status        text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'sent', 'partially_received', 'received', 'cancelled')),
      expected_date date,
      notes         text,
      total_amount  numeric(14,2) NOT NULL DEFAULT 0,
      ${AUDIT_COLS},
      UNIQUE (facility_id, po_number),
      UNIQUE (facility_id, id),
      FOREIGN KEY (facility_id, supplier_id) REFERENCES suppliers(facility_id, id),
      FOREIGN KEY (facility_id, store_id) REFERENCES stores(facility_id, id)
    );

    CREATE TABLE purchase_order_items (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      po_id        uuid NOT NULL REFERENCES purchase_orders(id),
      item_id      uuid NOT NULL REFERENCES items(id),
      quantity     numeric(14,3) NOT NULL CHECK (quantity > 0),
      unit_cost    numeric(14,4) NOT NULL CHECK (unit_cost >= 0),
      received_qty numeric(14,3) NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
      UNIQUE (po_id, item_id)
    );

    CREATE TABLE goods_received_notes (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id   uuid NOT NULL REFERENCES facilities(id),
      grn_number    text NOT NULL,
      po_id         uuid REFERENCES purchase_orders(id),
      supplier_id   uuid NOT NULL,
      store_id      uuid NOT NULL,
      delivery_note text,
      invoice_ref   text,
      total_amount  numeric(14,2) NOT NULL DEFAULT 0,
      notes         text,
      received_by   uuid NOT NULL REFERENCES users(id),
      received_at   timestamptz NOT NULL DEFAULT now(),
      UNIQUE (facility_id, grn_number),
      FOREIGN KEY (facility_id, supplier_id) REFERENCES suppliers(facility_id, id),
      FOREIGN KEY (facility_id, store_id) REFERENCES stores(facility_id, id)
    );

    CREATE TABLE grn_items (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      grn_id     uuid NOT NULL REFERENCES goods_received_notes(id),
      po_item_id uuid REFERENCES purchase_order_items(id),
      item_id    uuid NOT NULL REFERENCES items(id),
      batch_id   uuid NOT NULL REFERENCES item_batches(id),
      quantity   numeric(14,3) NOT NULL CHECK (quantity > 0),
      unit_cost  numeric(14,4) NOT NULL CHECK (unit_cost >= 0)
    );

    CREATE TABLE stock_movements (
      id             bigserial PRIMARY KEY,
      facility_id    uuid NOT NULL REFERENCES facilities(id),
      store_id       uuid NOT NULL REFERENCES stores(id),
      item_id        uuid NOT NULL REFERENCES items(id),
      batch_id       uuid NOT NULL REFERENCES item_batches(id),
      movement_type  text NOT NULL CHECK (movement_type IN (${inList(MOVEMENT_TYPES)})),
      quantity       numeric(14,3) NOT NULL CHECK (quantity <> 0),
      balance_after  numeric(14,3) NOT NULL CHECK (balance_after >= 0),
      unit_cost      numeric(14,4) NOT NULL DEFAULT 0,
      reference_type text,
      reference_id   uuid,
      reason         text,
      created_by     uuid REFERENCES users(id),
      created_at     timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX stock_movements_store_item ON stock_movements (store_id, item_id, created_at DESC);
    CREATE INDEX stock_movements_reference ON stock_movements (reference_type, reference_id);
    CREATE INDEX stock_movements_day ON stock_movements (facility_id, created_at);

    CREATE TRIGGER trg_stock_movements_no_update BEFORE UPDATE OR DELETE ON stock_movements
      FOR EACH ROW EXECUTE FUNCTION forbid_modification();
    CREATE TRIGGER trg_stock_movements_no_truncate BEFORE TRUNCATE ON stock_movements
      FOR EACH STATEMENT EXECUTE FUNCTION forbid_modification();
  `);
  for (const t of ['stores', 'items', 'suppliers', 'purchase_orders']) await touch(knex, t);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS stock_movements, grn_items, goods_received_notes, purchase_order_items, purchase_orders,
      reorder_levels, stock_levels, item_batches, suppliers, item_pack_sizes, drugs, items, stores,
      document_sequences CASCADE;
  `);
}
