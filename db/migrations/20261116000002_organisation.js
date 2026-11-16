// Kenyan admin units, facilities, departments, service points, wards, beds, settings.
import { AUDIT_COLS, inList, touch } from '../helpers.js';
import {
  BED_STATUS, DEPARTMENT_TYPES, FACILITY_LEVELS, FACILITY_OWNERSHIP, SERVICE_POINT_TYPES,
} from '../../packages/shared/src/enums.js';

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE counties (
      code text PRIMARY KEY,
      name text NOT NULL UNIQUE
    );
    CREATE TABLE sub_counties (
      id          serial PRIMARY KEY,
      county_code text NOT NULL REFERENCES counties(code),
      name        text NOT NULL,
      UNIQUE (county_code, name)
    );
    CREATE TABLE admin_wards (
      id            serial PRIMARY KEY,
      sub_county_id int  NOT NULL REFERENCES sub_counties(id),
      name          text NOT NULL,
      UNIQUE (sub_county_id, name)
    );

    CREATE TABLE facilities (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name        text NOT NULL,
      kmhfl_code  text NOT NULL UNIQUE,
      level       text NOT NULL CHECK (level IN (${inList(FACILITY_LEVELS)})),
      ownership   text NOT NULL CHECK (ownership IN (${inList(FACILITY_OWNERSHIP)})),
      county_code text REFERENCES counties(code),
      sub_county  text,
      address     text,
      phone       text,
      email       text,
      mrn_format  text NOT NULL DEFAULT '{facility_code}-{year}-{seq}',
      timezone    text NOT NULL DEFAULT 'Africa/Nairobi',
      currency    char(3) NOT NULL DEFAULT 'KES',
      active      boolean NOT NULL DEFAULT true,
      ${AUDIT_COLS}
    );

    CREATE TABLE departments (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id uuid NOT NULL REFERENCES facilities(id),
      name        text NOT NULL,
      code        text NOT NULL,
      type        text NOT NULL CHECK (type IN (${inList(DEPARTMENT_TYPES)})),
      active      boolean NOT NULL DEFAULT true,
      ${AUDIT_COLS},
      UNIQUE (facility_id, code),
      UNIQUE (facility_id, id)
    );

    CREATE TABLE service_points (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id   uuid NOT NULL REFERENCES facilities(id),
      department_id uuid NOT NULL,
      name          text NOT NULL,
      type          text NOT NULL CHECK (type IN (${inList(SERVICE_POINT_TYPES)})),
      active        boolean NOT NULL DEFAULT true,
      ${AUDIT_COLS},
      FOREIGN KEY (facility_id, department_id) REFERENCES departments(facility_id, id),
      UNIQUE (facility_id, name)
    );
    CREATE INDEX service_points_type ON service_points (facility_id, type) WHERE active;

    CREATE TABLE wards (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id   uuid NOT NULL REFERENCES facilities(id),
      department_id uuid NOT NULL,
      name          text NOT NULL,
      code          text NOT NULL,
      gender        text NOT NULL DEFAULT 'mixed' CHECK (gender IN ('male', 'female', 'mixed')),
      active        boolean NOT NULL DEFAULT true,
      ${AUDIT_COLS},
      FOREIGN KEY (facility_id, department_id) REFERENCES departments(facility_id, id),
      UNIQUE (facility_id, code),
      UNIQUE (facility_id, id)
    );

    CREATE TABLE beds (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id uuid NOT NULL,
      ward_id     uuid NOT NULL,
      label       text NOT NULL,
      status      text NOT NULL DEFAULT 'available' CHECK (status IN (${inList(BED_STATUS)})),
      active      boolean NOT NULL DEFAULT true,
      ${AUDIT_COLS},
      FOREIGN KEY (facility_id, ward_id) REFERENCES wards(facility_id, id),
      UNIQUE (ward_id, label)
    );
    CREATE INDEX beds_ward_status ON beds (ward_id, status);

    -- facility_id NULL = deployment-wide default; a facility row overrides it.
    CREATE TABLE system_settings (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id uuid REFERENCES facilities(id),
      key         text NOT NULL,
      value       jsonb NOT NULL,
      ${AUDIT_COLS}
    );
    CREATE UNIQUE INDEX system_settings_scope_key
      ON system_settings (COALESCE(facility_id, '00000000-0000-0000-0000-000000000000'::uuid), key);
  `);
  for (const t of ['facilities', 'departments', 'service_points', 'wards', 'beds', 'system_settings'])
    await touch(knex, t);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS system_settings, beds, wards, service_points, departments, facilities,
      admin_wards, sub_counties, counties CASCADE;
  `);
}
