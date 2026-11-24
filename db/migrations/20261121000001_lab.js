// Laboratory: test catalogue (every test has one or more components; panels have several, each
// with reference ranges by sex and age), orders from a visit, and samples with barcode accessions.
// Results, verification and release follow in a later migration.
import { AUDIT_COLS, inList, touch } from '../helpers.js';
import {
  LAB_ITEM_STATUS,
  LAB_PRIORITIES,
  LAB_RESULT_TYPES,
  LAB_SECTIONS,
  SPECIMEN_TYPES,
} from '../../packages/shared/src/enums.js';

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE lab_tests (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id    uuid NOT NULL REFERENCES facilities(id),
      code           text NOT NULL,
      name           text NOT NULL,
      section        text NOT NULL CHECK (section IN (${inList(LAB_SECTIONS)})),
      specimen_type  text NOT NULL CHECK (specimen_type IN (${inList(SPECIMEN_TYPES)})),
      container      text NOT NULL,
      -- Target turnaround from order to release, in minutes.
      tat_minutes    int NOT NULL DEFAULT 120 CHECK (tat_minutes > 0),
      charge_item_id uuid,
      active         boolean NOT NULL DEFAULT true,
      ${AUDIT_COLS},
      UNIQUE (facility_id, code),
      UNIQUE (facility_id, id),
      FOREIGN KEY (facility_id, charge_item_id) REFERENCES charge_items(facility_id, id)
    );
    CREATE INDEX lab_tests_name_trgm ON lab_tests USING gin (lower(name) gin_trgm_ops);

    CREATE TABLE lab_test_components (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      test_id          uuid NOT NULL REFERENCES lab_tests(id),
      code             text NOT NULL,
      name             text NOT NULL,
      result_type      text NOT NULL CHECK (result_type IN (${inList(LAB_RESULT_TYPES)})),
      unit             text,
      decimals         int NOT NULL DEFAULT 1 CHECK (decimals BETWEEN 0 AND 4),
      -- For 'options': the allowed answers, and which of them are abnormal.
      options          jsonb,
      abnormal_options jsonb,
      sort             int NOT NULL DEFAULT 0,
      UNIQUE (test_id, code)
    );

    CREATE TABLE lab_reference_ranges (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      component_id   uuid NOT NULL REFERENCES lab_test_components(id),
      sex            text CHECK (sex IN ('male', 'female')),
      age_min_days   int NOT NULL DEFAULT 0,
      age_max_days   int,
      low            numeric(14,4),
      high           numeric(14,4),
      critical_low   numeric(14,4),
      critical_high  numeric(14,4),
      CHECK (age_max_days IS NULL OR age_max_days >= age_min_days),
      CHECK (low IS NULL OR high IS NULL OR low <= high)
    );
    CREATE INDEX lab_reference_ranges_component ON lab_reference_ranges (component_id);

    CREATE TABLE lab_orders (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id    uuid NOT NULL REFERENCES facilities(id),
      order_number   text NOT NULL,
      encounter_id   uuid NOT NULL REFERENCES encounters(id),
      patient_id     uuid NOT NULL,
      ordered_by     uuid NOT NULL REFERENCES users(id),
      priority       text NOT NULL DEFAULT 'routine' CHECK (priority IN (${inList(LAB_PRIORITIES)})),
      clinical_notes text,
      client_id      uuid UNIQUE,
      ${AUDIT_COLS},
      UNIQUE (facility_id, order_number),
      FOREIGN KEY (facility_id, patient_id) REFERENCES patients(facility_id, id)
    );
    CREATE INDEX lab_orders_encounter ON lab_orders (encounter_id);
    CREATE INDEX lab_orders_patient ON lab_orders (patient_id, created_at DESC);

    -- One tube per specimen and container; the accession is printed as a barcode.
    CREATE TABLE lab_samples (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id      uuid NOT NULL REFERENCES facilities(id),
      accession        text NOT NULL,
      order_id         uuid NOT NULL REFERENCES lab_orders(id),
      patient_id       uuid NOT NULL REFERENCES patients(id),
      specimen_type    text NOT NULL,
      container        text NOT NULL,
      status           text NOT NULL DEFAULT 'collected' CHECK (status IN ('collected', 'received', 'rejected')),
      collected_by     uuid NOT NULL REFERENCES users(id),
      collected_at     timestamptz NOT NULL DEFAULT now(),
      received_by      uuid REFERENCES users(id),
      received_at      timestamptz,
      rejected_by      uuid REFERENCES users(id),
      rejected_at      timestamptz,
      rejection_reason text,
      UNIQUE (facility_id, accession),
      CHECK (status <> 'rejected' OR rejection_reason IS NOT NULL)
    );
    CREATE INDEX lab_samples_order ON lab_samples (order_id);

    CREATE TABLE lab_order_items (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id      uuid NOT NULL REFERENCES lab_orders(id),
      test_id       uuid NOT NULL REFERENCES lab_tests(id),
      status        text NOT NULL DEFAULT 'ordered' CHECK (status IN (${inList(LAB_ITEM_STATUS)})),
      sample_id     uuid REFERENCES lab_samples(id),
      bill_item_id  uuid REFERENCES bill_items(id),
      ordered_at    timestamptz NOT NULL DEFAULT now(),
      collected_at  timestamptz,
      received_at   timestamptz,
      resulted_at   timestamptz,
      verified_at   timestamptz,
      cancelled_at  timestamptz,
      cancel_reason text,
      UNIQUE (order_id, test_id)
    );
    CREATE INDEX lab_order_items_open ON lab_order_items (status) WHERE status IN ('ordered', 'collected', 'received', 'resulted');
  `);
  for (const t of ['lab_tests', 'lab_orders']) await touch(knex, t);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS lab_order_items, lab_samples, lab_orders, lab_reference_ranges, lab_test_components,
      lab_tests CASCADE;
  `);
}
