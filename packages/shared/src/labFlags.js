// Flagging lab results against reference ranges. Used by the API (authoritative) and by the
// result-entry screen (preview while typing).
//
//   N normal · L low · H high · LL critically low · HH critically high · A abnormal (an answer
//   listed as abnormal, e.g. "Positive")

/** Age in whole days on a date. @param {string} dob YYYY-MM-DD @param {Date} [on] */
export function ageInDays(dob, on = new Date()) {
  return Math.floor((on.getTime() - Date.parse(`${dob}T00:00:00Z`)) / 86_400_000);
}

/**
 * The reference range that applies to this patient: matching age band, preferring one for their
 * sex over one for either sex.
 * @param {Array<{sex: string|null, ageMinDays: number, ageMaxDays: number|null}>} ranges
 * @param {{sex: string, ageDays: number}} patient
 */
export function pickRange(ranges, patient) {
  const fits = ranges.filter(
    (r) => patient.ageDays >= (r.ageMinDays ?? 0) && (r.ageMaxDays == null || patient.ageDays <= r.ageMaxDays),
  );
  return fits.find((r) => r.sex === patient.sex) ?? fits.find((r) => !r.sex) ?? null;
}

/** "4.0–11.0", "< 5.0", "> 3.5" or null. */
export function rangeText(range, decimals = 1) {
  if (!range) return null;
  const f = (n) => Number(n).toFixed(decimals);
  if (range.low != null && range.high != null) return `${f(range.low)}–${f(range.high)}`;
  if (range.high != null) return `< ${f(range.high)}`;
  if (range.low != null) return `> ${f(range.low)}`;
  return null;
}

/**
 * Flag one value.
 * @param {{resultType: string, options?: string[]|null, abnormalOptions?: string[]|null}} component
 * @param {any} range from pickRange (numeric only)
 * @param {number|string|null} value
 * @returns {{flag: 'N'|'L'|'H'|'LL'|'HH'|'A'|null, critical: boolean}}
 */
export function flagFor(component, range, value) {
  if (value === null || value === undefined || value === '') return { flag: null, critical: false };
  if (component.resultType === 'options')
    return { flag: (component.abnormalOptions ?? []).includes(value) ? 'A' : 'N', critical: false };
  if (component.resultType !== 'numeric' || !range) return { flag: null, critical: false };
  const v = Number(value);
  if (range.criticalLow != null && v < range.criticalLow) return { flag: 'LL', critical: true };
  if (range.criticalHigh != null && v > range.criticalHigh) return { flag: 'HH', critical: true };
  if (range.low != null && v < range.low) return { flag: 'L', critical: false };
  if (range.high != null && v > range.high) return { flag: 'H', critical: false };
  return { flag: 'N', critical: false };
}

export const FLAG_LABEL = { N: '', L: 'Low', H: 'High', LL: 'Critically low', HH: 'Critically high', A: 'Abnormal' };
