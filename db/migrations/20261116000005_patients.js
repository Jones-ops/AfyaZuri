// Patients, identifiers, payer schemes, merges, consent, break-the-glass access.
// Sensitive values (phone, national ID and other identifiers) are stored encrypted
// (AES-256-GCM, app-level) with an HMAC "blind index" for exact-match search.
import { AUDIT_COLS, inList, syncable, touch } from '../helpers.js';
import { CONSENT_TYPES, IDENTIFIER_TYPES, PAYER_TYPES, SEX } from '../../packages/shared/src/enums.js';

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    -- Payers are national reference data (facility_id NULL) unless a facility adds its own.
    CREATE TABLE payers (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id uuid REFERENCES facilities(id),
      code        text NOT NULL UNIQUE,
      name        text NOT NULL,
      type        text NOT NULL CHECK (type IN (${inList(PAYER_TYPES)})),
      config      jsonb NOT NULL DEFAULT '{}'::jsonb,
      active      boolean NOT NULL DEFAULT true,
      ${AUDIT_COLS}
    );

    CREATE TABLE schemes (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      payer_id         uuid NOT NULL REFERENCES payers(id),
      code             text NOT NULL,
      name             text NOT NULL,
      billing_mode     text NOT NULL DEFAULT 'bill_at_exit'
                       CHECK (billing_mode IN ('pay_first', 'bill_at_exit')),
      requires_preauth boolean NOT NULL DEFAULT false,
      active           boolean NOT NULL DEFAULT true,
      ${AUDIT_COLS},
      UNIQUE (payer_id, code)
    );

    CREATE TABLE mrn_sequences (
      facility_id uuid NOT NULL REFERENCES facilities(id),
      year        int  NOT NULL,
      last_value  int  NOT NULL DEFAULT 0,
      PRIMARY KEY (facility_id, year)
    );

    CREATE TABLE patients (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id           uuid NOT NULL REFERENCES facilities(id),
      mrn                   text NOT NULL,
      first_name            text NOT NULL,
      middle_name           text,
      last_name             text NOT NULL,
      search_name           text GENERATED ALWAYS AS
                              (lower(first_name || ' ' || COALESCE(middle_name || ' ', '') || last_name)) STORED,
      sex                   text NOT NULL CHECK (sex IN (${inList(SEX)})),
      date_of_birth         date NOT NULL,
      dob_estimated         boolean NOT NULL DEFAULT false,
      phone_enc             text,
      phone_hash            text,
      email                 text,
      county_code           text REFERENCES counties(code),
      sub_county_id         int REFERENCES sub_counties(id),
      admin_ward_id         int REFERENCES admin_wards(id),
      village               text,
      occupation            text,
      marital_status        text,
      next_of_kin_name      text,
      next_of_kin_relation  text,
      next_of_kin_phone_enc text,
      is_restricted         boolean NOT NULL DEFAULT false,
      deceased_at           timestamptz,
      merged_into_id        uuid REFERENCES patients(id),
      duplicate_override_reason text,
      client_id             uuid UNIQUE,
      ${AUDIT_COLS},
      deleted_at            timestamptz,
      UNIQUE (facility_id, mrn),
      UNIQUE (facility_id, id)
    );
    CREATE INDEX patients_search_name_trgm ON patients USING gin (search_name gin_trgm_ops);
    CREATE INDEX patients_last_name_trgm   ON patients USING gin (lower(last_name) gin_trgm_ops);
    CREATE INDEX patients_phone_hash       ON patients (facility_id, phone_hash);
    CREATE INDEX patients_dob              ON patients (facility_id, date_of_birth);
    CREATE INDEX patients_mrn_lower        ON patients (lower(mrn));

    CREATE TABLE patient_identifiers (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id uuid NOT NULL,
      patient_id  uuid NOT NULL,
      type        text NOT NULL CHECK (type IN (${inList(IDENTIFIER_TYPES)})),
      value_enc   text NOT NULL,
      value_hash  text NOT NULL,
      value_last4 text,
      verified_at timestamptz,
      ${AUDIT_COLS},
      deleted_at  timestamptz,
      FOREIGN KEY (facility_id, patient_id) REFERENCES patients(facility_id, id)
    );
    CREATE INDEX patient_identifiers_lookup ON patient_identifiers (type, value_hash) WHERE deleted_at IS NULL;
    CREATE INDEX patient_identifiers_patient ON patient_identifiers (patient_id);

    CREATE TABLE patient_payer_schemes (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id    uuid NOT NULL,
      patient_id     uuid NOT NULL,
      scheme_id      uuid NOT NULL REFERENCES schemes(id),
      member_number  text,
      principal_name text,
      relationship   text,
      valid_from     date,
      valid_to       date,
      is_primary     boolean NOT NULL DEFAULT false,
      active         boolean NOT NULL DEFAULT true,
      ${AUDIT_COLS},
      FOREIGN KEY (facility_id, patient_id) REFERENCES patients(facility_id, id)
    );
    CREATE INDEX patient_payer_schemes_patient ON patient_payer_schemes (patient_id) WHERE active;

    -- repointed holds {table: [row ids]} so an unmerge can move exactly those rows back.
    CREATE TABLE patient_merges (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id    uuid NOT NULL REFERENCES facilities(id),
      survivor_id    uuid NOT NULL REFERENCES patients(id),
      merged_id      uuid NOT NULL REFERENCES patients(id),
      reason         text NOT NULL,
      repointed      jsonb NOT NULL DEFAULT '{}'::jsonb,
      merged_by      uuid NOT NULL REFERENCES users(id),
      merged_at      timestamptz NOT NULL DEFAULT now(),
      unmerged_by    uuid REFERENCES users(id),
      unmerged_at    timestamptz,
      unmerge_reason text,
      CHECK (survivor_id <> merged_id)
    );

    CREATE TABLE patient_consents (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id     uuid NOT NULL,
      patient_id      uuid NOT NULL,
      consent_type    text NOT NULL CHECK (consent_type IN (${inList(CONSENT_TYPES)})),
      granted         boolean NOT NULL,
      consent_version text NOT NULL,
      method          text NOT NULL CHECK (method IN ('verbal', 'signed', 'digital', 'guardian')),
      captured_by     uuid NOT NULL REFERENCES users(id),
      captured_at     timestamptz NOT NULL DEFAULT now(),
      withdrawn_at    timestamptz,
      FOREIGN KEY (facility_id, patient_id) REFERENCES patients(facility_id, id)
    );
    CREATE INDEX patient_consents_patient ON patient_consents (patient_id, consent_type);

    CREATE TABLE break_glass_access (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id    uuid NOT NULL REFERENCES facilities(id),
      user_id        uuid NOT NULL REFERENCES users(id),
      patient_id     uuid NOT NULL REFERENCES patients(id),
      reason         text NOT NULL CHECK (length(reason) >= 10),
      granted_at     timestamptz NOT NULL DEFAULT now(),
      expires_at     timestamptz NOT NULL,
      reviewed_by    uuid REFERENCES users(id),
      reviewed_at    timestamptz,
      review_outcome text CHECK (review_outcome IN ('justified', 'unjustified'))
    );
    CREATE INDEX break_glass_active ON break_glass_access (user_id, patient_id, expires_at);
    CREATE INDEX break_glass_unreviewed ON break_glass_access (facility_id) WHERE reviewed_at IS NULL;
  `);
  for (const t of ['payers', 'schemes', 'patients', 'patient_identifiers', 'patient_payer_schemes'])
    await touch(knex, t);
  await syncable(knex, 'patients');
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS break_glass_access, patient_consents, patient_merges, patient_payer_schemes,
      patient_identifiers, patients, mrn_sequences, schemes, payers CASCADE;
  `);
}
