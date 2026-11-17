// A Paybill (C2B) payment whose account reference matches no bill belongs to no facility
// until someone matches it by hand, so mpesa_transactions.facility_id becomes optional.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE mpesa_transactions ALTER COLUMN facility_id DROP NOT NULL;
    ALTER TABLE mpesa_transactions ADD CONSTRAINT mpesa_facility_when_matched
      CHECK (facility_id IS NOT NULL OR status = 'unmatched');
    CREATE INDEX mpesa_unmatched ON mpesa_transactions (created_at DESC) WHERE status = 'unmatched';
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    DROP INDEX IF EXISTS mpesa_unmatched;
    ALTER TABLE mpesa_transactions DROP CONSTRAINT IF EXISTS mpesa_facility_when_matched;
    DELETE FROM mpesa_transactions WHERE facility_id IS NULL;
    ALTER TABLE mpesa_transactions ALTER COLUMN facility_id SET NOT NULL;
  `);
}
