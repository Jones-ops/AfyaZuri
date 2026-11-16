// SQL helpers used by migrations. Kept outside db/migrations so Knex does not load it as one.

/** Standard audit columns for business tables. */
export const AUDIT_COLS = `
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid`;

/** @param {string[]} values */
export const inList = (values) => values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');

/**
 * Attach the updated_at trigger to a table.
 * @param {import('knex').Knex} knex
 * @param {string} table
 */
export const touch = (knex, table) =>
  knex.raw(
    `CREATE TRIGGER trg_${table}_updated_at BEFORE UPDATE ON ${table}
     FOR EACH ROW EXECUTE FUNCTION set_updated_at()`,
  );

/**
 * Record every insert/update/delete on a table in sync_changes so offline
 * clients can pull deltas by sequence number.
 * @param {import('knex').Knex} knex
 * @param {string} table
 */
export const syncable = (knex, table) =>
  knex.raw(
    `CREATE TRIGGER trg_${table}_sync AFTER INSERT OR UPDATE OR DELETE ON ${table}
     FOR EACH ROW EXECUTE FUNCTION capture_sync_change()`,
  );
