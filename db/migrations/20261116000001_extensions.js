// Extensions, shared trigger functions and the sync change feed.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE EXTENSION IF NOT EXISTS citext;

    CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      NEW.updated_at := now();
      RETURN NEW;
    END $$;

    -- Monotonic change feed for delta sync (Phase 9 consumes it; triggers are attached
    -- to syncable tables as they are created). id is the server change sequence.
    CREATE TABLE sync_changes (
      id          bigserial PRIMARY KEY,
      table_name  text        NOT NULL,
      row_id      uuid        NOT NULL,
      facility_id uuid,
      op          char(1)     NOT NULL CHECK (op IN ('I', 'U', 'D')),
      changed_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX sync_changes_facility_seq ON sync_changes (facility_id, id);

    CREATE OR REPLACE FUNCTION capture_sync_change() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE r record;
    BEGIN
      IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
      INSERT INTO sync_changes (table_name, row_id, facility_id, op)
      VALUES (TG_TABLE_NAME, r.id, r.facility_id, left(TG_OP, 1));
      RETURN NULL;
    END $$;

    -- Generic guard for append-only tables.
    CREATE OR REPLACE FUNCTION forbid_modification() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'insufficient_privilege';
    END $$;
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS sync_changes;
    DROP FUNCTION IF EXISTS capture_sync_change();
    DROP FUNCTION IF EXISTS forbid_modification();
    DROP FUNCTION IF EXISTS set_updated_at();
  `);
}
