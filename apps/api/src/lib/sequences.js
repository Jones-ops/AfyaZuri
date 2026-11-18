import { todayNairobi } from '@afyazuri/shared';

/**
 * Next document number for a facility, e.g. PO-2026-000001, GRN-2026-000042.
 * Atomic (row-level upsert), so concurrent requests never share a number.
 * @param {import('knex').Knex.Transaction} trx @param {string} facilityId @param {string} prefix
 */
export async function nextDocNumber(trx, facilityId, prefix) {
  const year = Number(todayNairobi().slice(0, 4));
  const { rows } = await trx.raw(
    `INSERT INTO document_sequences (facility_id, prefix, year, last_value) VALUES (?, ?, ?, 1)
     ON CONFLICT (facility_id, prefix, year) DO UPDATE SET last_value = document_sequences.last_value + 1
     RETURNING last_value`,
    [facilityId, prefix, year],
  );
  return `${prefix}-${year}-${String(rows[0].last_value).padStart(6, '0')}`;
}
