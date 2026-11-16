// Phase 2: patient merge support and restricted-record reasons.
//
// A merge moves every clinical row from the duplicate to the surviving patient,
// including signed (locked) notes. The note lock still forbids changing
// patient_id, except inside a transaction that has declared itself a merge
// with SET LOCAL afyazuri.merging = 'on'. Only the patients service does that.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION lock_signed_note() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE merging boolean := COALESCE(current_setting('afyazuri.merging', true), '') = 'on';
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'clinical notes cannot be deleted' USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF OLD.status = 'signed' AND (
           NEW.subjective IS DISTINCT FROM OLD.subjective OR NEW.objective IS DISTINCT FROM OLD.objective
        OR NEW.assessment IS DISTINCT FROM OLD.assessment OR NEW.plan IS DISTINCT FROM OLD.plan
        OR NEW.body IS DISTINCT FROM OLD.body OR NEW.status IS DISTINCT FROM OLD.status
        OR NEW.signed_at IS DISTINCT FROM OLD.signed_at
        OR (NEW.patient_id IS DISTINCT FROM OLD.patient_id AND NOT merging)
      ) THEN
        RAISE EXCEPTION 'signed clinical note % is locked; add an addendum', OLD.id
          USING ERRCODE = 'insufficient_privilege';
      END IF;
      RETURN NEW;
    END $$;

    ALTER TABLE patients ADD COLUMN restricted_reason text;
    CREATE INDEX patients_facility_created ON patients (facility_id, created_at DESC) WHERE deleted_at IS NULL;
    CREATE INDEX patient_merges_merged ON patient_merges (merged_id) WHERE unmerged_at IS NULL;
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    DROP INDEX IF EXISTS patient_merges_merged;
    DROP INDEX IF EXISTS patients_facility_created;
    ALTER TABLE patients DROP COLUMN IF EXISTS restricted_reason;
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
  `);
}
