// Imaging: catalogue, report templates, orders (a clinical indication is mandatory), reports
// (versioned; amendments keep history) and a DICOM accession number for future PACS integration.
// Attachments (report PDFs, images) are linked to their source and stored encrypted on disk.
import { AUDIT_COLS, inList, touch } from '../helpers.js';
import { IMAGING_STATUS, LAB_PRIORITIES, MODALITIES } from '../../packages/shared/src/enums.js';

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE imaging_studies (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id    uuid NOT NULL REFERENCES facilities(id),
      code           text NOT NULL,
      name           text NOT NULL,
      modality       text NOT NULL CHECK (modality IN (${inList(MODALITIES)})),
      body_part      text,
      preparation    text,
      tat_minutes    int NOT NULL DEFAULT 1440 CHECK (tat_minutes > 0),
      charge_item_id uuid,
      active         boolean NOT NULL DEFAULT true,
      ${AUDIT_COLS},
      UNIQUE (facility_id, code),
      UNIQUE (facility_id, id),
      FOREIGN KEY (facility_id, charge_item_id) REFERENCES charge_items(facility_id, id)
    );

    CREATE TABLE imaging_report_templates (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id uuid NOT NULL REFERENCES facilities(id),
      modality    text NOT NULL CHECK (modality IN (${inList(MODALITIES)})),
      study_id    uuid REFERENCES imaging_studies(id),
      name        text NOT NULL,
      findings    text NOT NULL,
      impression  text,
      active      boolean NOT NULL DEFAULT true,
      ${AUDIT_COLS}
    );

    CREATE TABLE imaging_orders (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id         uuid NOT NULL REFERENCES facilities(id),
      order_number        text NOT NULL,
      encounter_id        uuid NOT NULL REFERENCES encounters(id),
      patient_id          uuid NOT NULL,
      study_id            uuid NOT NULL REFERENCES imaging_studies(id),
      ordered_by          uuid NOT NULL REFERENCES users(id),
      priority            text NOT NULL DEFAULT 'routine' CHECK (priority IN (${inList(LAB_PRIORITIES)})),
      clinical_indication text NOT NULL CHECK (length(trim(clinical_indication)) >= 5),
      status              text NOT NULL DEFAULT 'ordered' CHECK (status IN (${inList(IMAGING_STATUS)})),
      scheduled_for       timestamptz,
      scheduled_by        uuid REFERENCES users(id),
      performed_at        timestamptz,
      performed_by        uuid REFERENCES users(id),
      accession_number    text,
      study_instance_uid  text,
      technique_notes     text,
      reported_at         timestamptz,
      released_at         timestamptz,
      released_by         uuid REFERENCES users(id),
      report_version      int NOT NULL DEFAULT 0,
      amended             boolean NOT NULL DEFAULT false,
      bill_item_id        uuid REFERENCES bill_items(id),
      cancelled_at        timestamptz,
      cancel_reason       text,
      client_id           uuid UNIQUE,
      ${AUDIT_COLS},
      UNIQUE (facility_id, order_number),
      UNIQUE (facility_id, accession_number),
      FOREIGN KEY (facility_id, patient_id) REFERENCES patients(facility_id, id),
      CHECK (status NOT IN ('performed', 'reported', 'released') OR accession_number IS NOT NULL)
    );
    CREATE INDEX imaging_orders_worklist ON imaging_orders (facility_id, status, created_at);
    CREATE INDEX imaging_orders_encounter ON imaging_orders (encounter_id);
    CREATE INDEX imaging_orders_patient ON imaging_orders (patient_id, created_at DESC);

    CREATE TABLE imaging_reports (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id     uuid NOT NULL REFERENCES imaging_orders(id),
      version      int NOT NULL CHECK (version >= 1),
      is_current   boolean NOT NULL DEFAULT true,
      findings     text NOT NULL,
      impression   text NOT NULL,
      reported_by  uuid NOT NULL REFERENCES users(id),
      reported_at  timestamptz NOT NULL DEFAULT now(),
      amend_reason text,
      UNIQUE (order_id, version),
      CHECK (version = 1 OR amend_reason IS NOT NULL)
    );

    ALTER TABLE attachments
      ADD COLUMN source_type text,
      ADD COLUMN source_id   uuid;
    CREATE INDEX attachments_source ON attachments (source_type, source_id);
  `);
  for (const t of ['imaging_studies', 'imaging_report_templates', 'imaging_orders']) await touch(knex, t);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    DROP INDEX IF EXISTS attachments_source;
    ALTER TABLE attachments DROP COLUMN IF EXISTS source_id, DROP COLUMN IF EXISTS source_type;
    DROP TABLE IF EXISTS imaging_reports, imaging_orders, imaging_report_templates, imaging_studies CASCADE;
  `);
}
