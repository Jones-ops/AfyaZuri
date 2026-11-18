// Waivers, credit notes and refunds get their own numbering and eTIMS fields;
// facilities get a KRA PIN for eTIMS; outgoing SMS are logged (phone encrypted).

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE bill_sequences DROP CONSTRAINT bill_sequences_kind_check;
    ALTER TABLE bill_sequences ADD CONSTRAINT bill_sequences_kind_check
      CHECK (kind IN ('bill', 'receipt', 'credit_note', 'refund'));

    ALTER TABLE facilities ADD COLUMN kra_pin text CHECK (kra_pin IS NULL OR kra_pin ~ '^[AP][0-9]{9}[A-Z]$');

    CREATE INDEX waivers_bill ON waivers (bill_id);
    CREATE INDEX waivers_pending ON waivers (facility_id, requested_at) WHERE status = 'requested';

    ALTER TABLE refunds
      ADD COLUMN document_number      text,
      ADD COLUMN reference            text,
      ADD COLUMN etims_status         text NOT NULL DEFAULT 'not_required'
        CHECK (etims_status IN ('pending', 'submitted', 'failed', 'not_required')),
      ADD COLUMN etims_invoice_number text,
      ADD COLUMN etims_response       jsonb,
      ADD CONSTRAINT refunds_document_number UNIQUE (facility_id, document_number),
      -- Paying out needs a shift and a method; a credit note is never "paid".
      ADD CONSTRAINT refunds_paid_shape CHECK (status <> 'paid' OR (kind = 'refund' AND method IS NOT NULL AND shift_id IS NOT NULL AND paid_by IS NOT NULL));
    CREATE INDEX refunds_bill ON refunds (bill_id);
    CREATE INDEX refunds_payment ON refunds (payment_id) WHERE payment_id IS NOT NULL;
    CREATE INDEX refunds_pending ON refunds (facility_id, requested_at) WHERE status IN ('requested', 'approved');

    CREATE TABLE sms_messages (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id         uuid NOT NULL REFERENCES facilities(id),
      patient_id          uuid REFERENCES patients(id),
      template            text NOT NULL,
      related_type        text NOT NULL,
      related_id          uuid NOT NULL,
      language            text NOT NULL CHECK (language IN ('en', 'sw')),
      phone_enc           text,
      phone_hash          text,
      body                text NOT NULL,
      status              text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'sent', 'failed', 'skipped_no_consent', 'skipped_no_phone', 'disabled')),
      provider            text,
      provider_message_id text,
      attempts            int NOT NULL DEFAULT 0,
      last_error          text,
      created_at          timestamptz NOT NULL DEFAULT now(),
      sent_at             timestamptz,
      -- One message per template per event: the outbox may deliver an event twice.
      UNIQUE (template, related_id)
    );
    CREATE INDEX sms_messages_patient ON sms_messages (patient_id, created_at DESC);
    CREATE INDEX sms_messages_facility ON sms_messages (facility_id, created_at DESC);
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS sms_messages;
    DROP INDEX IF EXISTS refunds_pending, refunds_payment, refunds_bill, waivers_pending, waivers_bill;
    ALTER TABLE refunds
      DROP CONSTRAINT IF EXISTS refunds_paid_shape,
      DROP CONSTRAINT IF EXISTS refunds_document_number,
      DROP COLUMN IF EXISTS etims_response,
      DROP COLUMN IF EXISTS etims_invoice_number,
      DROP COLUMN IF EXISTS etims_status,
      DROP COLUMN IF EXISTS reference,
      DROP COLUMN IF EXISTS document_number;
    ALTER TABLE facilities DROP COLUMN IF EXISTS kra_pin;
    DELETE FROM bill_sequences WHERE kind NOT IN ('bill', 'receipt');
    ALTER TABLE bill_sequences DROP CONSTRAINT bill_sequences_kind_check;
    ALTER TABLE bill_sequences ADD CONSTRAINT bill_sequences_kind_check CHECK (kind IN ('bill', 'receipt'));
  `);
}
