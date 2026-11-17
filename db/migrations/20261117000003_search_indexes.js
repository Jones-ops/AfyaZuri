// Patient-search indexes, from the 500 000-patient benchmark (npm run bench:search).
// - Identifier search looks up a blind-index hash without knowing its type, so it
//   needs an index on value_hash alone (the (type, value_hash) index can't serve it).
// - A GiST trigram index lets name search return the closest matches directly
//   (ORDER BY search_name <-> query LIMIT n) instead of ranking every hit, and powers
//   the typo-tolerant fallback.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    CREATE INDEX patient_identifiers_hash ON patient_identifiers (value_hash) WHERE deleted_at IS NULL;
    CREATE INDEX patients_search_name_gist ON patients USING gist (search_name gist_trgm_ops);
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS patients_search_name_gist; DROP INDEX IF EXISTS patient_identifiers_hash;');
}
