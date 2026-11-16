// Encounters and the clinical record. Clinical rows are never hard-deleted: errors are
// marked entered-in-error, and signed notes are locked (changes go into addenda).
import { AUDIT_COLS, inList, syncable, touch } from '../helpers.js';
import {
  ALLERGY_CATEGORIES, ALLERGY_SEVERITY, ENCOUNTER_STATUS, ENCOUNTER_TYPES, NOTE_TYPES,
} from '../../packages/shared/src/enums.js';

const ERROR_COLS = `
  entered_in_error_at     timestamptz,
  entered_in_error_by     uuid,
  entered_in_error_reason text`;

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE icd_codes (
      system      text NOT NULL CHECK (system IN ('icd11', 'icd10')),
      code        text NOT NULL,
      title       text NOT NULL,
      chapter     text,
      parent_code text,
      icd10_map   text,
      PRIMARY KEY (system, code)
    );
    CREATE INDEX icd_codes_title_trgm ON icd_codes USING gin (lower(title) gin_trgm_ops);

    CREATE TABLE encounters (
      id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id            uuid NOT NULL,
      patient_id             uuid NOT NULL,
      type                   text NOT NULL CHECK (type IN (${inList(ENCOUNTER_TYPES)})),
      status                 text NOT NULL DEFAULT 'open' CHECK (status IN (${inList(ENCOUNTER_STATUS)})),
      department_id          uuid REFERENCES departments(id),
      patient_payer_scheme_id uuid REFERENCES patient_payer_schemes(id),
      billing_mode           text NOT NULL DEFAULT 'pay_first'
                             CHECK (billing_mode IN ('pay_first', 'bill_at_exit')),
      eligibility            jsonb,
      eligibility_checked_at timestamptz,
      attending_user_id      uuid REFERENCES users(id),
      started_at             timestamptz NOT NULL DEFAULT now(),
      ended_at               timestamptz,
      cancelled_reason       text,
      client_id              uuid UNIQUE,
      ${AUDIT_COLS},
      FOREIGN KEY (facility_id, patient_id) REFERENCES patients(facility_id, id),
      UNIQUE (facility_id, id)
    );
    CREATE INDEX encounters_patient ON encounters (patient_id, started_at DESC);
    CREATE INDEX encounters_open    ON encounters (facility_id, type, started_at) WHERE status = 'open';

    CREATE TABLE triage_vitals (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id      uuid NOT NULL,
      encounter_id     uuid NOT NULL,
      patient_id       uuid NOT NULL REFERENCES patients(id),
      recorded_at      timestamptz NOT NULL DEFAULT now(),
      recorded_by      uuid NOT NULL REFERENCES users(id),
      systolic         smallint CHECK (systolic BETWEEN 40 AND 300),
      diastolic        smallint CHECK (diastolic BETWEEN 20 AND 200),
      pulse            smallint CHECK (pulse BETWEEN 20 AND 250),
      temperature_c    numeric(4,1) CHECK (temperature_c BETWEEN 25 AND 45),
      resp_rate        smallint CHECK (resp_rate BETWEEN 4 AND 80),
      spo2             smallint CHECK (spo2 BETWEEN 40 AND 100),
      weight_kg        numeric(5,2) CHECK (weight_kg BETWEEN 0.3 AND 400),
      height_cm        numeric(5,1) CHECK (height_cm BETWEEN 20 AND 250),
      bmi              numeric(4,1),
      muac_cm          numeric(4,1) CHECK (muac_cm BETWEEN 5 AND 50),
      pain_score       smallint CHECK (pain_score BETWEEN 0 AND 10),
      flags            jsonb NOT NULL DEFAULT '[]'::jsonb,
      notes            text,
      client_id        uuid UNIQUE,
      created_at       timestamptz NOT NULL DEFAULT now(),
      ${ERROR_COLS},
      FOREIGN KEY (facility_id, encounter_id) REFERENCES encounters(facility_id, id)
    );
    CREATE INDEX triage_vitals_patient ON triage_vitals (patient_id, recorded_at DESC);

    CREATE TABLE clinical_notes (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id   uuid NOT NULL,
      encounter_id  uuid NOT NULL,
      patient_id    uuid NOT NULL REFERENCES patients(id),
      note_type     text NOT NULL CHECK (note_type IN (${inList(NOTE_TYPES)})),
      template_code text,
      subjective    text,
      objective     text,
      assessment    text,
      plan          text,
      body          jsonb NOT NULL DEFAULT '{}'::jsonb,
      status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'signed')),
      author_id     uuid NOT NULL REFERENCES users(id),
      signed_at     timestamptz,
      signed_by     uuid REFERENCES users(id),
      client_id     uuid UNIQUE,
      ${AUDIT_COLS},
      ${ERROR_COLS},
      FOREIGN KEY (facility_id, encounter_id) REFERENCES encounters(facility_id, id)
    );
    CREATE INDEX clinical_notes_patient ON clinical_notes (patient_id, created_at DESC);

    -- A signed note is locked. Only marking it entered-in-error is allowed afterwards.
    CREATE OR REPLACE FUNCTION lock_signed_note() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'clinical notes cannot be deleted' USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF OLD.status = 'signed' AND (
           NEW.subjective IS DISTINCT FROM OLD.subjective OR NEW.objective IS DISTINCT FROM OLD.objective
        OR NEW.assessment IS DISTINCT FROM OLD.assessment OR NEW.plan IS DISTINCT FROM OLD.plan
        OR NEW.body IS DISTINCT FROM OLD.body OR NEW.status IS DISTINCT FROM OLD.status
        OR NEW.signed_at IS DISTINCT FROM OLD.signed_at OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
      ) THEN
        RAISE EXCEPTION 'signed clinical note % is locked; add an addendum' , OLD.id
          USING ERRCODE = 'insufficient_privilege';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER trg_clinical_notes_lock BEFORE UPDATE OR DELETE ON clinical_notes
      FOR EACH ROW EXECUTE FUNCTION lock_signed_note();

    CREATE TABLE clinical_note_addenda (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id uuid NOT NULL REFERENCES facilities(id),
      note_id     uuid NOT NULL REFERENCES clinical_notes(id),
      author_id   uuid NOT NULL REFERENCES users(id),
      body        text NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE TRIGGER trg_addenda_append_only BEFORE UPDATE OR DELETE ON clinical_note_addenda
      FOR EACH ROW EXECUTE FUNCTION forbid_modification();

    CREATE TABLE diagnoses (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id  uuid NOT NULL,
      encounter_id uuid NOT NULL,
      patient_id   uuid NOT NULL REFERENCES patients(id),
      icd_system   text NOT NULL DEFAULT 'icd11',
      icd_code     text NOT NULL,
      description  text NOT NULL,
      certainty    text NOT NULL DEFAULT 'provisional' CHECK (certainty IN ('provisional', 'confirmed')),
      rank         text NOT NULL DEFAULT 'secondary' CHECK (rank IN ('primary', 'secondary')),
      recorded_by  uuid NOT NULL REFERENCES users(id),
      client_id    uuid UNIQUE,
      ${AUDIT_COLS},
      ${ERROR_COLS},
      FOREIGN KEY (facility_id, encounter_id) REFERENCES encounters(facility_id, id),
      FOREIGN KEY (icd_system, icd_code) REFERENCES icd_codes(system, code)
    );
    CREATE INDEX diagnoses_encounter ON diagnoses (encounter_id);
    CREATE INDEX diagnoses_patient   ON diagnoses (patient_id, created_at DESC);
    CREATE INDEX diagnoses_code      ON diagnoses (facility_id, icd_code, created_at);

    CREATE TABLE allergies (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id uuid NOT NULL REFERENCES facilities(id),
      patient_id  uuid NOT NULL REFERENCES patients(id),
      category    text NOT NULL CHECK (category IN (${inList(ALLERGY_CATEGORIES)})),
      allergen    text NOT NULL,
      allergen_code text,
      reaction    text,
      severity    text NOT NULL CHECK (severity IN (${inList(ALLERGY_SEVERITY)})),
      status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
      client_id   uuid UNIQUE,
      ${AUDIT_COLS},
      ${ERROR_COLS}
    );
    CREATE INDEX allergies_patient ON allergies (patient_id) WHERE status = 'active';

    CREATE TABLE problem_list (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id uuid NOT NULL REFERENCES facilities(id),
      patient_id  uuid NOT NULL REFERENCES patients(id),
      icd_system  text NOT NULL DEFAULT 'icd11',
      icd_code    text,
      description text NOT NULL,
      onset_date  date,
      status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved')),
      resolved_at date,
      ${AUDIT_COLS},
      ${ERROR_COLS}
    );
    CREATE INDEX problem_list_patient ON problem_list (patient_id);

    CREATE TABLE procedures (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id  uuid NOT NULL,
      encounter_id uuid NOT NULL,
      patient_id   uuid NOT NULL REFERENCES patients(id),
      code         text,
      description  text NOT NULL,
      performed_at timestamptz NOT NULL DEFAULT now(),
      performed_by uuid NOT NULL REFERENCES users(id),
      notes        text,
      ${AUDIT_COLS},
      ${ERROR_COLS},
      FOREIGN KEY (facility_id, encounter_id) REFERENCES encounters(facility_id, id)
    );
    CREATE INDEX procedures_encounter ON procedures (encounter_id);

    CREATE TABLE referrals (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id         uuid NOT NULL,
      encounter_id        uuid NOT NULL,
      patient_id          uuid NOT NULL REFERENCES patients(id),
      direction           text NOT NULL CHECK (direction IN ('internal', 'external')),
      to_department_id    uuid REFERENCES departments(id),
      to_service_point_id uuid REFERENCES service_points(id),
      to_facility_name    text,
      to_facility_kmhfl   text,
      urgency             text NOT NULL DEFAULT 'routine' CHECK (urgency IN ('routine', 'urgent', 'emergency')),
      reason              text NOT NULL,
      clinical_summary    text,
      status              text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'accepted', 'completed', 'cancelled')),
      referred_by         uuid NOT NULL REFERENCES users(id),
      ${AUDIT_COLS},
      FOREIGN KEY (facility_id, encounter_id) REFERENCES encounters(facility_id, id),
      CHECK (direction = 'internal' OR to_facility_name IS NOT NULL)
    );

    CREATE TABLE attachments (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id  uuid NOT NULL REFERENCES facilities(id),
      patient_id   uuid NOT NULL REFERENCES patients(id),
      encounter_id uuid REFERENCES encounters(id),
      category     text NOT NULL DEFAULT 'document',
      file_name    text NOT NULL,
      mime_type    text NOT NULL,
      size_bytes   bigint NOT NULL CHECK (size_bytes > 0),
      storage_key  text NOT NULL UNIQUE,
      sha256       char(64) NOT NULL,
      uploaded_by  uuid NOT NULL REFERENCES users(id),
      created_at   timestamptz NOT NULL DEFAULT now(),
      ${ERROR_COLS}
    );
    CREATE INDEX attachments_patient ON attachments (patient_id, created_at DESC);
  `);
  for (const t of ['encounters', 'clinical_notes', 'diagnoses', 'allergies', 'problem_list', 'procedures', 'referrals'])
    await touch(knex, t);
  for (const t of ['encounters', 'triage_vitals', 'clinical_notes', 'diagnoses', 'allergies'])
    await syncable(knex, t);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS attachments, referrals, procedures, problem_list, allergies, diagnoses,
      clinical_note_addenda, clinical_notes, triage_vitals, encounters, icd_codes CASCADE;
    DROP FUNCTION IF EXISTS lock_signed_note();
  `);
}
