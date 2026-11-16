/** Fields never written to the audit log, even as before/after values. */
const SECRET_FIELDS = new Set([
  'password_hash',
  'totp_secret_enc',
  'token_hash',
  'phone_enc',
  'value_enc',
  'next_of_kin_phone_enc',
]);

/**
 * Remove secret fields and normalise Dates for JSON storage.
 * @param {Record<string, any>|null|undefined} row
 */
export function redact(row) {
  if (!row) return null;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (SECRET_FIELDS.has(k)) out[k] = v === null ? null : '[redacted]';
    else out[k] = v instanceof Date ? v.toISOString() : v;
  }
  return out;
}

/**
 * Field-level changes between two versions of a row.
 * Ignores updated_at/updated_by, which change on every write.
 * @param {Record<string, any>|null|undefined} before
 * @param {Record<string, any>|null|undefined} after
 * @returns {Record<string, {from: any, to: any}>|null}
 */
export function diff(before, after) {
  if (!before || !after) return null;
  const a = redact(before);
  const b = redact(after);
  const changes = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (k === 'updated_at' || k === 'updated_by') continue;
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) changes[k] = { from: a[k] ?? null, to: b[k] ?? null };
  }
  return Object.keys(changes).length ? changes : null;
}
