/**
 * One CSV cell. Values that a spreadsheet would run as a formula (=, +, -, @, tab, CR) are
 * prefixed with ' so an exported report can never execute anything when opened. Plain numbers,
 * including negative amounts, are left as numbers.
 * @param {unknown} v
 */
export function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const BOM = String.fromCharCode(0xfeff);

/**
 * Whole CSV document (with a UTF-8 BOM so Excel shows Kiswahili names correctly).
 * @param {string[]} header @param {unknown[][]} rows
 */
export const toCsv = (header, rows) =>
  `${BOM}${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
