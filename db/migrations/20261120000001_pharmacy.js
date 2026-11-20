// Prescribing and dispensing: prescriptions written in a visit, the pharmacy dispensing them
// (FEFO batches, partial supply, substitution with a reason), and configurable dose-range rules.
// Each dispensation's stock movement and bill line are written in the same transaction.
import { AUDIT_COLS, touch } from '../helpers.js';

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE prescriptions (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id   uuid NOT NULL REFERENCES facilities(id),
      rx_number     text NOT NULL,
      encounter_id  uuid NOT NULL REFERENCES encounters(id),
      patient_id    uuid NOT NULL,
      prescriber_id uuid NOT NULL REFERENCES users(id),
      status        text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'partially_dispensed', 'dispensed', 'cancelled')),
      notes         text,
      client_id     uuid UNIQUE,
      ${AUDIT_COLS},
      UNIQUE (facility_id, rx_number),
      FOREIGN KEY (facility_id, patient_id) REFERENCES patients(facility_id, id)
    );
    CREATE INDEX prescriptions_worklist ON prescriptions (facility_id, created_at) WHERE status IN ('active', 'partially_dispensed');
    CREATE INDEX prescriptions_patient ON prescriptions (patient_id, created_at DESC);
    CREATE INDEX prescriptions_encounter ON prescriptions (encounter_id);

    CREATE TABLE prescription_items (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      prescription_id uuid NOT NULL REFERENCES prescriptions(id),
      item_id         uuid NOT NULL REFERENCES items(id),
      dose_value      numeric(12,3) NOT NULL CHECK (dose_value > 0),
      dose_unit       text NOT NULL,
      route           text NOT NULL,
      frequency       text NOT NULL,
      duration_days   int CHECK (duration_days BETWEEN 1 AND 365),
      quantity        numeric(14,3) NOT NULL CHECK (quantity > 0),
      instructions    text,
      status          text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'partially_dispensed', 'dispensed', 'cancelled')),
      dispensed_qty   numeric(14,3) NOT NULL DEFAULT 0 CHECK (dispensed_qty >= 0 AND dispensed_qty <= quantity),
      -- Safety checks at prescribing time, with the prescriber's reason for each warning overridden.
      warnings        jsonb NOT NULL DEFAULT '[]',
      cancel_reason   text,
      UNIQUE (prescription_id, item_id)
    );

    CREATE TABLE dispensations (
      id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id              uuid NOT NULL REFERENCES facilities(id),
      prescription_id          uuid REFERENCES prescriptions(id),
      prescription_item_id     uuid REFERENCES prescription_items(id),
      store_id                 uuid NOT NULL REFERENCES stores(id),
      item_id                  uuid NOT NULL REFERENCES items(id),
      quantity                 numeric(14,3) NOT NULL CHECK (quantity > 0),
      substituted_from_item_id uuid REFERENCES items(id),
      substitution_reason      text,
      bill_item_id             uuid REFERENCES bill_items(id),
      dispensed_by             uuid NOT NULL REFERENCES users(id),
      dispensed_at             timestamptz NOT NULL DEFAULT now(),
      CHECK (substituted_from_item_id IS NULL OR substitution_reason IS NOT NULL)
    );
    CREATE INDEX dispensations_rx ON dispensations (prescription_id);
    CREATE INDEX dispensations_day ON dispensations (facility_id, dispensed_at);

    CREATE TABLE dispensation_batches (
      dispensation_id uuid NOT NULL REFERENCES dispensations(id),
      batch_id        uuid NOT NULL REFERENCES item_batches(id),
      quantity        numeric(14,3) NOT NULL CHECK (quantity > 0),
      PRIMARY KEY (dispensation_id, batch_id)
    );

    -- Dose limits by generic name (and optionally route and age band). facility_id NULL = applies everywhere.
    CREATE TABLE dose_rules (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id       uuid REFERENCES facilities(id),
      generic_name      text NOT NULL,
      route             text,
      min_age_months    int,
      max_age_months    int,
      dose_unit         text NOT NULL DEFAULT 'mg',
      min_single_dose   numeric(12,3),
      max_single_dose   numeric(12,3),
      max_daily_dose    numeric(12,3),
      max_daily_per_kg  numeric(12,3),
      note              text,
      active            boolean NOT NULL DEFAULT true,
      ${AUDIT_COLS},
      CHECK (min_age_months IS NULL OR max_age_months IS NULL OR min_age_months <= max_age_months)
    );
    CREATE INDEX dose_rules_generic ON dose_rules (lower(generic_name)) WHERE active;
  `);
  for (const t of ['prescriptions', 'dose_rules']) await touch(knex, t);

  // Reference dose limits for common essential medicines (adults ≥ 12 years unless stated).
  // Illustrative defaults for decision support; each facility's pharmacy can change them.
  const ADULT = 144;
  const rules = [
    ['paracetamol', 'oral', ADULT, null, null, 1000, 4000, null, 'Adult maximum 4 g a day'],
    ['paracetamol', 'oral', 0, ADULT - 1, null, null, null, 60, 'Children: up to 60 mg/kg a day'],
    ['amoxicillin', 'oral', ADULT, null, null, 1000, 4000, null, null],
    ['amoxicillin', 'oral', 0, ADULT - 1, null, null, null, 100, 'Children: up to 100 mg/kg a day (high dose)'],
    ['ibuprofen', 'oral', ADULT, null, null, 800, 2400, null, null],
    ['ibuprofen', 'oral', 3, ADULT - 1, null, null, null, 30, 'Children: up to 30 mg/kg a day'],
    ['metformin', 'oral', ADULT, null, null, 1000, 3000, null, null],
    ['amlodipine', 'oral', ADULT, null, null, 10, 10, null, null],
    ['diclofenac', 'oral', ADULT, null, null, 75, 150, null, null],
    ['metronidazole', 'oral', ADULT, null, null, 800, 2400, null, null],
    ['omeprazole', 'oral', ADULT, null, null, 40, 80, null, null],
    ['ceftriaxone', null, ADULT, null, null, 4000, 4000, null, null],
    ['zinc sulphate', 'oral', 0, 59, null, 20, 20, null, 'Under-fives with diarrhoea: 10–20 mg a day'],
  ];
  await knex('dose_rules').insert(
    rules.map(([g, route, minA, maxA, minSingle, maxSingle, maxDaily, perKg, note]) => ({
      generic_name: g,
      route,
      min_age_months: minA,
      max_age_months: maxA,
      min_single_dose: minSingle,
      max_single_dose: maxSingle,
      max_daily_dose: maxDaily,
      max_daily_per_kg: perKg,
      note,
    })),
  );
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS dose_rules, dispensation_batches, dispensations, prescription_items, prescriptions CASCADE;
  `);
}
