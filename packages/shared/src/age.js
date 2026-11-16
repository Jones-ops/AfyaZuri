/**
 * Date-of-birth and age helpers. Dates of birth are plain calendar dates
 * ('YYYY-MM-DD') with no time zone; "today" is taken in Africa/Nairobi.
 */

/** Today's calendar date in Nairobi as 'YYYY-MM-DD'. */
export function todayNairobi(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi' }).format(now);
}

/** @param {string} ymd */
const parts = (ymd) => ymd.split('-').map(Number);

/**
 * Estimated date of birth from an age in years and months, counted back from today.
 * @param {number} years @param {number} [months] @param {string} [today] 'YYYY-MM-DD'
 * @returns {string} 'YYYY-MM-DD'
 */
export function dobFromEstimatedAge(years, months = 0, today = todayNairobi()) {
  const [y, m, d] = parts(today);
  const totalMonths = y * 12 + (m - 1) - years * 12 - months;
  const by = Math.floor(totalMonths / 12);
  const bm = totalMonths - by * 12; // 0-based
  const lastDay = new Date(Date.UTC(by, bm + 1, 0)).getUTCDate();
  return `${String(by).padStart(4, '0')}-${String(bm + 1).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
}

/**
 * Exact age in whole years, months and days.
 * @param {string} dob 'YYYY-MM-DD' @param {string} [today]
 */
export function ageParts(dob, today = todayNairobi()) {
  const [by, bm, bd] = parts(dob);
  const [ty, tm, td] = parts(today);
  let months = (ty - by) * 12 + (tm - bm);
  if (td < bd) months -= 1;
  const years = Math.floor(months / 12);
  const days = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(by, bm - 1, bd)) / 86_400_000);
  return { years: Math.max(0, years), months: Math.max(0, months), days: Math.max(0, days) };
}

/**
 * Clinical age label: days under 1 month, months under 2 years, years after.
 * @param {string|null|undefined} dob @param {string} [today]
 */
export function ageLabel(dob, today = todayNairobi()) {
  if (!dob) return '';
  const a = ageParts(dob, today);
  if (a.months < 1) return `${a.days} d`;
  if (a.years < 2) return `${a.months} mo`;
  return `${a.years} y`;
}

/** Under-5 flag used for MOH reporting and MUAC prompts. @param {string} dob @param {string} [today] */
export const isUnderFive = (dob, today = todayNairobi()) => ageParts(dob, today).years < 5;
