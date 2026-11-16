// Pure helpers for patient identity: MRN formatting, search-query classification,
// duplicate scoring and display masking. No database access here, so they are unit-tested.
import { kenyanPhone, normaliseIdentifier } from '@afyazuri/shared';

/**
 * Render an MRN from a facility format.
 * Tokens: {facility_code} (KMHFL code), {year}, {yy}, {seq} (6 digits) or {seq:N} (N digits).
 * @param {string} format e.g. '{facility_code}-{year}-{seq}'
 * @param {{facilityCode: string, year: number, seq: number}} v
 */
export function formatMrn(format, { facilityCode, year, seq }) {
  return format
    .replace(/\{facility_code\}/g, facilityCode)
    .replace(/\{year\}/g, String(year))
    .replace(/\{yy\}/g, String(year).slice(-2))
    .replace(/\{seq(?::(\d))?\}/g, (_, n) => String(seq).padStart(Number(n ?? 6), '0'));
}

/**
 * Next MRN for a facility and year. The sequence row is incremented atomically,
 * so concurrent registrations never get the same number.
 * @param {import('knex').Knex.Transaction} trx
 * @param {{id: string, kmhfl_code: string, mrn_format: string}} facility
 * @param {number} year
 */
export async function nextMrn(trx, facility, year) {
  const { rows } = await trx.raw(
    `INSERT INTO mrn_sequences (facility_id, year, last_value) VALUES (?, ?, 1)
     ON CONFLICT (facility_id, year) DO UPDATE SET last_value = mrn_sequences.last_value + 1
     RETURNING last_value`,
    [facility.id, year],
  );
  return formatMrn(facility.mrn_format, { facilityCode: facility.kmhfl_code, year, seq: rows[0].last_value });
}

/**
 * Work out what a search box entry could be. Several kinds can apply at once
 * (e.g. "12345678" may be a national ID, an alien ID or an SHA number).
 * @param {string} raw
 * @returns {{mrn: string|null, phone: string|null, identifier: string|null, nameWords: string[]}}
 */
export function classifyQuery(raw) {
  const q = raw.trim();
  const phone = /^[+\d][\d\s-]{8,15}$/.test(q) ? kenyanPhone.safeParse(q) : null;
  const ident = normaliseIdentifier(q);
  const hasDigit = /\d/.test(q);
  const nameWords = hasDigit
    ? []
    : q
        .toLowerCase()
        .split(/\s+/)
        .map((w) => w.replace(/[^\p{L}\p{M}'-]/gu, ''))
        .filter((w) => w.length >= 2);
  return {
    mrn: hasDigit && /^[A-Za-z0-9/-]{4,40}$/.test(q) ? q.toLowerCase() : null,
    phone: phone?.success ? phone.data : null,
    identifier: hasDigit && /^[A-Z0-9/-]{4,20}$/.test(ident) ? ident : null,
    nameWords,
  };
}

/**
 * Score how likely an existing patient is the same person as a new registration.
 * @param {{first_name: string, middle_name: string|null, last_name: string, date_of_birth: string, dob_estimated: boolean,
 *          name_similarity: number, phone_match: boolean, identifier_match: string|null}} c
 * @param {{dateOfBirth: string, estimated: boolean}} input
 * @returns {{score: number, reasons: string[]}}
 */
export function scoreCandidate(c, input) {
  const reasons = [];
  let score = 0;
  if (c.identifier_match) {
    score += 100;
    reasons.push(`Same ${c.identifier_match.replace(/_/g, ' ')}`);
  }
  if (c.phone_match) {
    score += 35;
    reasons.push('Same phone number');
  }
  const sim = Number(c.name_similarity) || 0;
  if (sim >= 0.9) {
    score += 40;
    reasons.push('Same name');
  } else if (sim >= 0.5) {
    score += 25;
    reasons.push('Similar name');
  }
  const years = Math.abs(yearsBetween(c.date_of_birth, input.dateOfBirth));
  if (c.date_of_birth === input.dateOfBirth) {
    score += 30;
    reasons.push('Same date of birth');
  } else if ((c.dob_estimated || input.estimated) && years <= 2) {
    score += 15;
    reasons.push('Similar age');
  } else if (years > 5 && !c.identifier_match) {
    score -= 30; // clearly different ages: probably a namesake
  }
  return { score: Math.max(0, Math.min(100, score)), reasons };
}

/** @param {string} a @param {string} b 'YYYY-MM-DD' */
const yearsBetween = (a, b) => (Date.parse(a) - Date.parse(b)) / (365.25 * 86_400_000);

/** "+254712345678" → "07•• ••• 678" for lists and receipts. @param {string|null} phone */
export function maskPhone(phone) {
  if (!phone) return null;
  const local = phone.startsWith('+254') ? `0${phone.slice(4)}` : phone;
  return `${local.slice(0, 2)}•• ••• ${local.slice(-3)}`;
}

/** "12345678" → "••••5678". @param {string} v */
export const maskIdentifier = (v) => (v.length <= 4 ? v : `${'•'.repeat(Math.min(6, v.length - 4))}${v.slice(-4)}`);
