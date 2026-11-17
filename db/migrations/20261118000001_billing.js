// Phase 3 billing: service catalogue, price lists with payer cover rules, bills and
// bill lines, payments, receipts, M-Pesa transactions, cashier shifts, waivers and
// refunds / credit notes. Money is numeric(14,2) everywhere (never floats).
import { AUDIT_COLS, inList, touch } from '../helpers.js';
import { CHARGE_CATEGORIES, PAYMENT_METHODS } from '../../packages/shared/src/enums.js';

const money = (col, extra = '') => `${col} numeric(14,2) NOT NULL DEFAULT 0 ${extra}`;

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE charge_items (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id   uuid NOT NULL REFERENCES facilities(id),
      code          text NOT NULL,
      name          text NOT NULL,
      category      text NOT NULL CHECK (category IN (${inList(CHARGE_CATEGORIES)})),
      department_id uuid REFERENCES departments(id),
      unit          text NOT NULL DEFAULT 'each',
      vat_rate      numeric(5,2) NOT NULL DEFAULT 0 CHECK (vat_rate BETWEEN 0 AND 100),
      tariff_code   text,
      active        boolean NOT NULL DEFAULT true,
      ${AUDIT_COLS},
      UNIQUE (facility_id, code),
      UNIQUE (facility_id, id)
    );

    -- scheme_id NULL = the cash price list. One default (cash) list per facility.
    CREATE TABLE price_lists (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id uuid NOT NULL REFERENCES facilities(id),
      code        text NOT NULL,
      name        text NOT NULL,
      scheme_id   uuid REFERENCES schemes(id),
      is_default  boolean NOT NULL DEFAULT false,
      active      boolean NOT NULL DEFAULT true,
      valid_from  date,
      valid_to    date,
      ${AUDIT_COLS},
      UNIQUE (facility_id, code),
      UNIQUE (facility_id, id),
      CHECK (NOT is_default OR scheme_id IS NULL)
    );
    CREATE UNIQUE INDEX price_lists_one_default ON price_lists (facility_id) WHERE is_default AND active;
    CREATE UNIQUE INDEX price_lists_one_per_scheme ON price_lists (facility_id, scheme_id) WHERE active AND scheme_id IS NOT NULL;

    -- cover_type: what the payer pays for the line. none = patient pays all; full = payer pays all;
    -- fixed = payer pays cover_value per unit (capped at the price); percent = payer pays cover_value %.
    CREATE TABLE price_list_items (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id      uuid NOT NULL,
      price_list_id    uuid NOT NULL,
      charge_item_id   uuid NOT NULL,
      ${money('unit_price', 'CHECK (unit_price >= 0)')},
      cover_type       text NOT NULL DEFAULT 'none' CHECK (cover_type IN ('none', 'full', 'fixed', 'percent')),
      ${money('cover_value', 'CHECK (cover_value >= 0)')},
      requires_preauth boolean NOT NULL DEFAULT false,
      ${AUDIT_COLS},
      FOREIGN KEY (facility_id, price_list_id) REFERENCES price_lists(facility_id, id) ON DELETE CASCADE,
      FOREIGN KEY (facility_id, charge_item_id) REFERENCES charge_items(facility_id, id),
      UNIQUE (price_list_id, charge_item_id),
      CHECK (cover_type <> 'percent' OR cover_value <= 100)
    );

    CREATE TABLE bill_sequences (
      facility_id uuid NOT NULL REFERENCES facilities(id),
      kind        text NOT NULL CHECK (kind IN ('bill', 'receipt')),
      year        int  NOT NULL,
      last_value  int  NOT NULL DEFAULT 0,
      PRIMARY KEY (facility_id, kind, year)
    );

    CREATE TABLE bills (
      id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id             uuid NOT NULL REFERENCES facilities(id),
      bill_number             text NOT NULL,
      encounter_id            uuid REFERENCES encounters(id),
      patient_id              uuid REFERENCES patients(id),
      customer_name           text,
      patient_payer_scheme_id uuid REFERENCES patient_payer_schemes(id),
      billing_mode            text NOT NULL DEFAULT 'pay_first' CHECK (billing_mode IN ('pay_first', 'bill_at_exit')),
      status                  text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'final', 'closed', 'cancelled')),
      ${money('total_amount')},
      ${money('payer_amount')},
      ${money('patient_amount')},
      ${money('paid_amount')},
      ${money('waived_amount')},
      ${money('credited_amount')},
      ${money('refunded_amount')},
      ${money('balance')},
      opened_at               timestamptz NOT NULL DEFAULT now(),
      finalized_at            timestamptz,
      closed_at               timestamptz,
      ${AUDIT_COLS},
      UNIQUE (facility_id, bill_number),
      UNIQUE (facility_id, id),
      CHECK (patient_id IS NOT NULL OR customer_name IS NOT NULL)
    );
    CREATE UNIQUE INDEX bills_one_per_encounter ON bills (encounter_id) WHERE status <> 'cancelled' AND encounter_id IS NOT NULL;
    CREATE INDEX bills_patient ON bills (patient_id, opened_at DESC);
    CREATE INDEX bills_outstanding ON bills (facility_id, opened_at) WHERE balance > 0 AND status <> 'cancelled';

    CREATE TABLE bill_items (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id    uuid NOT NULL,
      bill_id        uuid NOT NULL,
      charge_item_id uuid NOT NULL,
      price_list_id  uuid REFERENCES price_lists(id),
      department_id  uuid REFERENCES departments(id),
      description    text NOT NULL,
      quantity       numeric(10,2) NOT NULL CHECK (quantity > 0),
      ${money('unit_price', 'CHECK (unit_price >= 0)')},
      ${money('total_amount')},
      ${money('payer_amount')},
      ${money('patient_amount')},
      unpriced       boolean NOT NULL DEFAULT false,
      source_type    text NOT NULL DEFAULT 'manual',
      source_id      uuid,
      status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
      void_reason    text,
      voided_by      uuid REFERENCES users(id),
      voided_at      timestamptz,
      posted_by      uuid REFERENCES users(id),
      posted_at      timestamptz NOT NULL DEFAULT now(),
      created_at     timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (facility_id, bill_id) REFERENCES bills(facility_id, id),
      FOREIGN KEY (facility_id, charge_item_id) REFERENCES charge_items(facility_id, id),
      CHECK (total_amount = payer_amount + patient_amount)
    );
    CREATE INDEX bill_items_bill ON bill_items (bill_id);
    -- A clinical action posts its charge once: re-posting the same source is a no-op.
    CREATE UNIQUE INDEX bill_items_source ON bill_items (source_type, source_id) WHERE status = 'active' AND source_id IS NOT NULL;

    CREATE TABLE cashier_shifts (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id   uuid NOT NULL REFERENCES facilities(id),
      cashier_id    uuid NOT NULL REFERENCES users(id),
      status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
      opened_at     timestamptz NOT NULL DEFAULT now(),
      ${money('opening_float', 'CHECK (opening_float >= 0)')},
      closed_at     timestamptz,
      declared      jsonb,
      system_totals jsonb,
      variance      jsonb,
      notes         text
    );
    CREATE UNIQUE INDEX cashier_shifts_one_open ON cashier_shifts (cashier_id) WHERE status = 'open';

    CREATE TABLE payments (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id    uuid NOT NULL,
      bill_id        uuid NOT NULL,
      shift_id       uuid REFERENCES cashier_shifts(id),
      method         text NOT NULL CHECK (method IN (${inList(PAYMENT_METHODS)})),
      amount         numeric(14,2) NOT NULL CHECK (amount > 0),
      reference      text,
      status         text NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed', 'reversed')),
      received_by    uuid REFERENCES users(id),
      received_at    timestamptz,
      notes          text,
      client_id      uuid UNIQUE,
      created_at     timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (facility_id, bill_id) REFERENCES bills(facility_id, id)
    );
    CREATE INDEX payments_bill ON payments (bill_id);
    CREATE INDEX payments_shift ON payments (shift_id) WHERE status = 'completed';
    CREATE INDEX payments_day ON payments (facility_id, received_at) WHERE status = 'completed';
    CREATE UNIQUE INDEX payments_reference ON payments (method, reference) WHERE reference IS NOT NULL AND method IN ('mpesa', 'card', 'bank') AND status = 'completed';

    CREATE TABLE receipts (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id          uuid NOT NULL REFERENCES facilities(id),
      receipt_number       text NOT NULL,
      payment_id           uuid NOT NULL UNIQUE REFERENCES payments(id),
      issued_by            uuid REFERENCES users(id),
      issued_at            timestamptz NOT NULL DEFAULT now(),
      reprint_count        int NOT NULL DEFAULT 0,
      etims_status         text NOT NULL DEFAULT 'pending' CHECK (etims_status IN ('pending', 'submitted', 'failed', 'not_required')),
      etims_invoice_number text,
      etims_response       jsonb,
      UNIQUE (facility_id, receipt_number)
    );

    CREATE TABLE mpesa_transactions (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id         uuid NOT NULL REFERENCES facilities(id),
      bill_id             uuid REFERENCES bills(id),
      payment_id          uuid REFERENCES payments(id),
      shift_id            uuid REFERENCES cashier_shifts(id),
      kind                text NOT NULL CHECK (kind IN ('stk', 'c2b')),
      phone_enc           text,
      phone_hash          text,
      amount              numeric(14,2) NOT NULL CHECK (amount > 0),
      account_reference   text,
      merchant_request_id text,
      checkout_request_id text UNIQUE,
      mpesa_receipt       text UNIQUE,
      status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'cancelled', 'unmatched')),
      result_code         int,
      result_desc         text,
      raw_callback        jsonb,
      initiated_by        uuid REFERENCES users(id),
      created_at          timestamptz NOT NULL DEFAULT now(),
      completed_at        timestamptz
    );
    CREATE INDEX mpesa_pending ON mpesa_transactions (created_at) WHERE status = 'pending';

    CREATE TABLE waivers (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id   uuid NOT NULL,
      bill_id       uuid NOT NULL,
      amount        numeric(14,2) NOT NULL CHECK (amount > 0),
      reason        text NOT NULL,
      status        text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'rejected')),
      requested_by  uuid NOT NULL REFERENCES users(id),
      requested_at  timestamptz NOT NULL DEFAULT now(),
      decided_by    uuid REFERENCES users(id),
      decided_at    timestamptz,
      decision_note text,
      FOREIGN KEY (facility_id, bill_id) REFERENCES bills(facility_id, id),
      CHECK (decided_by IS NULL OR decided_by <> requested_by)
    );

    -- kind: credit_note reduces what the patient owes; refund pays money back (needs a payment).
    CREATE TABLE refunds (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id   uuid NOT NULL,
      bill_id       uuid NOT NULL,
      payment_id    uuid REFERENCES payments(id),
      kind          text NOT NULL CHECK (kind IN ('refund', 'credit_note')),
      amount        numeric(14,2) NOT NULL CHECK (amount > 0),
      reason        text NOT NULL,
      status        text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'rejected', 'paid')),
      method        text CHECK (method IN (${inList(PAYMENT_METHODS)})),
      shift_id      uuid REFERENCES cashier_shifts(id),
      requested_by  uuid NOT NULL REFERENCES users(id),
      requested_at  timestamptz NOT NULL DEFAULT now(),
      decided_by    uuid REFERENCES users(id),
      decided_at    timestamptz,
      decision_note text,
      paid_by       uuid REFERENCES users(id),
      paid_at       timestamptz,
      FOREIGN KEY (facility_id, bill_id) REFERENCES bills(facility_id, id),
      CHECK (decided_by IS NULL OR decided_by <> requested_by),
      CHECK (kind = 'credit_note' OR payment_id IS NOT NULL)
    );
  `);
  for (const t of ['charge_items', 'price_lists', 'price_list_items', 'bills']) await touch(knex, t);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS refunds, waivers, mpesa_transactions, receipts, payments, cashier_shifts, bill_items, bills,
      bill_sequences, price_list_items, price_lists, charge_items CASCADE;
  `);
}
