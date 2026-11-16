// Users, roles, permissions, scoped role assignments, sessions and refresh tokens.
import { AUDIT_COLS, touch } from '../helpers.js';

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE users (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      username             citext NOT NULL UNIQUE,
      full_name            text NOT NULL,
      email                citext,
      phone                text,
      password_hash        text NOT NULL,
      status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      must_change_password boolean NOT NULL DEFAULT true,
      password_changed_at  timestamptz,
      failed_login_count   int NOT NULL DEFAULT 0,
      locked_until         timestamptz,
      last_login_at        timestamptz,
      totp_secret_enc      text,
      totp_enabled         boolean NOT NULL DEFAULT false,
      licence_body         text,
      licence_number       text,
      cadre                text,
      default_facility_id  uuid REFERENCES facilities(id),
      disabled_at          timestamptz,
      disabled_reason      text,
      ${AUDIT_COLS},
      deleted_at           timestamptz
    );
    CREATE INDEX users_full_name_trgm ON users USING gin (lower(full_name) gin_trgm_ops);

    CREATE TABLE roles (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code        text NOT NULL UNIQUE,
      name        text NOT NULL,
      description text,
      is_clinical boolean NOT NULL DEFAULT false,
      is_system   boolean NOT NULL DEFAULT true,
      ${AUDIT_COLS}
    );

    CREATE TABLE permissions (
      code        text PRIMARY KEY,
      group_name  text NOT NULL,
      description text NOT NULL
    );

    CREATE TABLE role_permissions (
      role_id         uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      permission_code text NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
      PRIMARY KEY (role_id, permission_code)
    );

    -- facility_id NULL = every facility; department_id NULL = every department.
    CREATE TABLE user_roles (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       uuid NOT NULL REFERENCES users(id),
      role_id       uuid NOT NULL REFERENCES roles(id),
      facility_id   uuid REFERENCES facilities(id),
      department_id uuid REFERENCES departments(id),
      created_at    timestamptz NOT NULL DEFAULT now(),
      created_by    uuid
    );
    CREATE UNIQUE INDEX user_roles_unique ON user_roles (
      user_id, role_id,
      COALESCE(facility_id, '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(department_id, '00000000-0000-0000-0000-000000000000'::uuid)
    );

    CREATE TABLE sessions (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id        uuid NOT NULL REFERENCES users(id),
      facility_id    uuid REFERENCES facilities(id),
      created_at     timestamptz NOT NULL DEFAULT now(),
      last_seen_at   timestamptz NOT NULL DEFAULT now(),
      expires_at     timestamptz NOT NULL,
      revoked_at     timestamptz,
      revoked_reason text,
      ip             inet,
      user_agent     text,
      mfa_verified   boolean NOT NULL DEFAULT false
    );
    CREATE INDEX sessions_user_active ON sessions (user_id) WHERE revoked_at IS NULL;

    -- Rotating refresh tokens. Each rotation marks the old token used; presenting a
    -- used token again is treated as theft and revokes the whole session.
    CREATE TABLE refresh_tokens (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,
      parent_id  uuid REFERENCES refresh_tokens(id),
      issued_at  timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      used_at    timestamptz,
      revoked_at timestamptz
    );
    CREATE INDEX refresh_tokens_session ON refresh_tokens (session_id);
  `);
  await touch(knex, 'users');
  await touch(knex, 'roles');
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(
    'DROP TABLE IF EXISTS refresh_tokens, sessions, user_roles, role_permissions, permissions, roles, users CASCADE',
  );
}
