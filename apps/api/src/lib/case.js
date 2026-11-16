const toCamel = (/** @type {string} */ s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const toSnake = (/** @type {string} */ s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * snake_case DB row → camelCase API object (shallow).
 * @param {Record<string, any>|null|undefined} row
 * @param {string[]} [omit] DB columns to leave out
 */
export function camel(row, omit = []) {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) if (!omit.includes(k)) out[toCamel(k)] = v;
  return out;
}

/**
 * camelCase API input → snake_case DB columns (shallow), skipping undefined.
 * @param {Record<string, any>} obj
 */
export function snake(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[toSnake(k)] = v;
  return out;
}
