import { FREQUENCIES } from './enums.js';

/**
 * Units (in the item's base unit) per dose: a 1,000 mg dose of 500 mg tablets is 2 tablets.
 * Returns null when it cannot be worked out (e.g. a mg dose of a bottle of syrup).
 * @param {{doseValue: number, doseUnit: string}} dose
 * @param {{baseUnit: string, drug?: {strengthValue?: number|null, strengthUnit?: string|null}|null}} item
 */
export function unitsPerDose(dose, item) {
  const unit = dose.doseUnit.trim().toLowerCase();
  if (unit === item.baseUnit.trim().toLowerCase() || unit === `${item.baseUnit.trim().toLowerCase()}s`)
    return dose.doseValue;
  const s = item.drug;
  if (s?.strengthValue && s.strengthUnit && unit === s.strengthUnit.trim().toLowerCase())
    return dose.doseValue / s.strengthValue;
  return null;
}

/**
 * Suggested quantity to supply: units per dose × doses a day × days, rounded up. A single (STAT)
 * dose is one dose; as-needed (PRN) cannot be suggested.
 * @returns {number|null}
 */
export function suggestQuantity({ doseValue, doseUnit, frequency, durationDays }, item) {
  const per = unitsPerDose({ doseValue, doseUnit }, item);
  if (per === null) return null;
  if (frequency === 'STAT') return Math.ceil(per);
  const f = FREQUENCIES[frequency]?.perDay;
  if (!f || !durationDays) return null;
  return Math.ceil(per * f * durationDays - 1e-9);
}

/**
 * Dose in the rule's unit (usually mg): a mg dose as is, or tablets × strength.
 * @returns {number|null}
 */
export function doseIn(unit, dose, item) {
  const u = unit.trim().toLowerCase();
  if (dose.doseUnit.trim().toLowerCase() === u) return dose.doseValue;
  const per = unitsPerDose(dose, item);
  const s = item.drug;
  if (
    per !== null &&
    s?.strengthValue &&
    s.strengthUnit?.trim().toLowerCase() === u &&
    dose.doseUnit.trim().toLowerCase() !== u
  )
    return per * s.strengthValue;
  return null;
}
