// Lab results, verification and in-app notifications.
//
// lab_results is versioned: version 1 is the original; an amendment after release adds the next
// version with a reason and the earlier ones stay. Results are visible on the patient record
// only once their test is verified (released). Critical values notify the ordering clinician.
/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE lab_results (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_item_id  uuid NOT NULL REFERENCES lab_order_items(id),
      component_id   uuid NOT NULL REFERENCES lab_test_components(id),
      version        int NOT NULL DEFAULT 1 CHECK (version >= 1),
      is_current     boolean NOT NULL DEFAULT true,
      value_numeric  numeric(14,4),
      value_text     text,
      culture        jsonb,
      unit           text,
      flag           text CHECK (flag IN ('N', 'L', 'H', 'LL', 'HH', 'A')),
      critical       boolean NOT NULL DEFAULT false,
      range_text     text,
      entered_by     uuid NOT NULL REFERENCES users(id),
      entered_at     timestamptz NOT NULL DEFAULT now(),
      amend_reason   text,
      UNIQUE (order_item_id, component_id, version),
      CHECK (version = 1 OR amend_reason IS NOT NULL),
      CHECK (value_numeric IS NOT NULL OR value_text IS NOT NULL OR culture IS NOT NULL)
    );
    CREATE INDEX lab_results_current ON lab_results (order_item_id) WHERE is_current;

    ALTER TABLE lab_order_items
      ADD COLUMN version      int NOT NULL DEFAULT 1,
      ADD COLUMN comment      text,
      ADD COLUMN critical     boolean NOT NULL DEFAULT false,
      ADD COLUMN amended      boolean NOT NULL DEFAULT false,
      ADD COLUMN entered_by   uuid REFERENCES users(id),
      ADD COLUMN verified_by  uuid REFERENCES users(id);
    CREATE INDEX lab_order_items_verified ON lab_order_items (verified_at) WHERE status = 'verified';

    -- Who released which version, and amendments.
    CREATE TABLE lab_result_verifications (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_item_id uuid NOT NULL REFERENCES lab_order_items(id),
      version       int NOT NULL,
      action        text NOT NULL CHECK (action IN ('verified', 'amended')),
      by_user       uuid NOT NULL REFERENCES users(id),
      at            timestamptz NOT NULL DEFAULT now(),
      reason        text
    );
    CREATE INDEX lab_result_verifications_item ON lab_result_verifications (order_item_id);

    -- The Phase 1 notifications table becomes the in-app inbox: who, how urgent, what, and a link.
    ALTER TABLE notifications
      ADD COLUMN type       text,
      ADD COLUMN severity   text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
      ADD COLUMN title      text,
      ADD COLUMN body       text,
      ADD COLUMN link       text,
      ADD COLUMN patient_id uuid REFERENCES patients(id),
      ADD COLUMN dedupe_key text,
      ALTER COLUMN channel SET DEFAULT 'in_app',
      ALTER COLUMN template DROP NOT NULL;
    UPDATE notifications
       SET type = template,
           title = CASE template WHEN 'break_glass.used' THEN 'Emergency access used' ELSE template END,
           severity = CASE priority WHEN 'critical' THEN 'critical' WHEN 'high' THEN 'warning' ELSE 'info' END;
    ALTER TABLE notifications ALTER COLUMN type SET NOT NULL, ALTER COLUMN title SET NOT NULL;
    ALTER TABLE notifications ADD CONSTRAINT notifications_dedupe UNIQUE (user_id, dedupe_key);
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_dedupe,
      DROP COLUMN IF EXISTS dedupe_key, DROP COLUMN IF EXISTS patient_id, DROP COLUMN IF EXISTS link,
      DROP COLUMN IF EXISTS body, DROP COLUMN IF EXISTS title, DROP COLUMN IF EXISTS severity, DROP COLUMN IF EXISTS type;
    DROP TABLE IF EXISTS lab_result_verifications, lab_results CASCADE;
    DROP INDEX IF EXISTS lab_order_items_verified;
    ALTER TABLE lab_order_items
      DROP COLUMN IF EXISTS verified_by, DROP COLUMN IF EXISTS entered_by, DROP COLUMN IF EXISTS amended,
      DROP COLUMN IF EXISTS critical, DROP COLUMN IF EXISTS comment, DROP COLUMN IF EXISTS version;
  `);
}
