/**
 * Read a setting: the facility's own value if set, otherwise the deployment default.
 * @template T
 * @param {import('knex').Knex | import('knex').Knex.Transaction} db
 * @param {string|null} facilityId
 * @param {string} key
 * @param {T} fallback
 * @returns {Promise<T>}
 */
export async function getSetting(db, facilityId, key, fallback) {
  const row = await db('system_settings')
    .where({ key })
    .andWhere((w) => w.where('facility_id', facilityId).orWhereNull('facility_id'))
    .orderByRaw('facility_id NULLS LAST')
    .first('value');
  return row ? row.value : fallback;
}
