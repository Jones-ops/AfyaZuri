// Append-only audit log, transactional outbox, notifications, idempotency keys, DB grants.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE audit_log (
      id             bigserial PRIMARY KEY,
      occurred_at    timestamptz NOT NULL DEFAULT now(),
      request_id     text,
      actor_user_id  uuid,
      actor_username text,
      actor_roles    text[],
      facility_id    uuid,
      action         text NOT NULL,
      entity_type    text NOT NULL,
      entity_id      text,
      patient_id     uuid,
      before         jsonb,
      after          jsonb,
      changes        jsonb,
      ip             inet,
      user_agent     text,
      reason         text,
      metadata       jsonb
    );
    -- No foreign keys on purpose: the log must outlive anything it references.
    CREATE INDEX audit_log_time     ON audit_log (occurred_at DESC);
    CREATE INDEX audit_log_actor    ON audit_log (actor_user_id, occurred_at DESC);
    CREATE INDEX audit_log_patient  ON audit_log (patient_id, occurred_at DESC) WHERE patient_id IS NOT NULL;
    CREATE INDEX audit_log_entity   ON audit_log (entity_type, entity_id);
    CREATE INDEX audit_log_facility ON audit_log (facility_id, occurred_at DESC);

    CREATE TRIGGER trg_audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
      FOR EACH ROW EXECUTE FUNCTION forbid_modification();
    CREATE TRIGGER trg_audit_log_no_truncate BEFORE TRUNCATE ON audit_log
      FOR EACH STATEMENT EXECUTE FUNCTION forbid_modification();

    CREATE TABLE outbox_events (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id    uuid,
      event_type     text NOT NULL,
      aggregate_type text NOT NULL,
      aggregate_id   text NOT NULL,
      payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
      occurred_at    timestamptz NOT NULL DEFAULT now(),
      status         text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'processing', 'done', 'failed')),
      attempts       int NOT NULL DEFAULT 0,
      available_at   timestamptz NOT NULL DEFAULT now(),
      processed_at   timestamptz,
      last_error     text
    );
    CREATE INDEX outbox_pending ON outbox_events (available_at) WHERE status = 'pending';

    CREATE TABLE notifications (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id uuid,
      user_id     uuid REFERENCES users(id),
      channel     text NOT NULL CHECK (channel IN ('in_app', 'sms', 'email')),
      recipient   text,
      template    text NOT NULL,
      locale      text NOT NULL DEFAULT 'en',
      payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
      priority    text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high', 'critical')),
      status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'read')),
      error       text,
      created_at  timestamptz NOT NULL DEFAULT now(),
      sent_at     timestamptz,
      read_at     timestamptz
    );
    CREATE INDEX notifications_user_unread ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;

    CREATE TABLE idempotency_keys (
      key             text NOT NULL,
      user_id         uuid NOT NULL,
      method          text NOT NULL,
      path            text NOT NULL,
      request_hash    text NOT NULL,
      response_status int,
      response_body   jsonb,
      created_at      timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, key)
    );
  `);

  // Application role: CRUD everywhere except the audit log, which is insert/select only.
  // On managed Postgres without CREATEROLE this degrades to a notice; the triggers above
  // still make the audit log append-only for every role.
  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'afyazuri_app') THEN
        CREATE ROLE afyazuri_app NOLOGIN;
      END IF;
      EXECUTE 'GRANT USAGE ON SCHEMA public TO afyazuri_app';
      EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO afyazuri_app';
      EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO afyazuri_app';
      EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO afyazuri_app';
      EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO afyazuri_app';
      EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM afyazuri_app, PUBLIC';
      EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON sync_changes FROM afyazuri_app, PUBLIC';
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'Skipping afyazuri_app role grants: insufficient privilege';
    END $$;
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS idempotency_keys, notifications, outbox_events, audit_log CASCADE');
}
