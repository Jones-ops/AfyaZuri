// Prescribing safety checks: allergy, duplicate therapy and dose range.
//
//   ALLERGY    a severe or life-threatening drug allergy that matches blocks the prescription
//              outright; a mild or moderate one is a warning the prescriber must acknowledge.
//   DUPLICATE  the patient already has an active prescription in the same therapeutic subgroup
//              (ATC level 3, e.g. M01A: two NSAIDs) or the same generic, or two lines here overlap.
//   DOSE_HIGH / DOSE_LOW  outside the configured dose rules for the drug, route and the
//              patient's age (and weight, for mg/kg limits).
//
// Warnings are decision support: they can be overridden with a reason, which is stored.
import { FREQUENCIES, ageParts, doseIn } from '@afyazuri/shared';

/** Allergen words that mean a whole class of drugs, by ATC prefix. */
const CLASS_ALLERGENS = [
  [/penicillin|amoxicillin|ampicillin|flucloxacillin|augmentin/i, ['J01C']],
  [/cephalosporin|ceftriaxone|cefuroxime|cefalexin|cephalexin|cefixime/i, ['J01D']],
  [/sulfa|sulpha|sulfonamide|sulphonamide|cotrimoxazole|septrin/i, ['J01E']],
  [/nsaid|aspirin|ibuprofen|diclofenac|non-steroidal/i, ['M01A', 'N02BA']],
  [/quinolone|ciprofloxacin|levofloxacin/i, ['J01M']],
  [/macrolide|erythromycin|azithromycin|clarithromycin/i, ['J01FA']],
];

const words = (s) =>
  String(s ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4);

/** Does this allergy apply to this drug? @returns {string|null} why */
export function allergyMatch(allergy, drug) {
  if (!drug) return null;
  const atc = (drug.atcCode ?? '').toUpperCase();
  if (allergy.allergen_code && atc && atc.startsWith(allergy.allergen_code.toUpperCase())) return 'coded match';
  const generic = drug.genericName.toLowerCase();
  const allergen = String(allergy.allergen).toLowerCase();
  const brand = (drug.brandName ?? '').toLowerCase();
  if (generic.includes(allergen) || allergen.includes(generic) || (brand && allergen.includes(brand)))
    return 'same drug';
  if (words(allergen).some((w) => words(generic).includes(w))) return 'same drug';
  for (const [re, prefixes] of CLASS_ALLERGENS)
    if (re.test(allergen) && atc && prefixes.some((p) => atc.startsWith(p))) return 'same drug class';
  return null;
}

/**
 * Run every check for a set of prescription lines.
 * @param {import('knex').Knex} db
 * @param {{patient: any, encounterId?: string|null, excludePrescriptionId?: string|null}} ctx
 * @param {Array<{itemId: string, doseValue: number, doseUnit: string, route: string, frequency: string, item: any}>} lines
 *   item: the stock item with .drug (genericName, atcCode, strengthValue, strengthUnit) and .baseUnit
 * @returns {Promise<Array<{itemId: string, code: string, severity: 'block'|'warn', message: string}>>}
 */
export async function runChecks(db, ctx, lines) {
  const { patient } = ctx;
  const out = [];
  const allergies = await db('allergies')
    .where({ patient_id: patient.id, status: 'active', category: 'drug' })
    .whereNull('entered_in_error_at')
    .select('allergen', 'allergen_code', 'severity', 'reaction');

  const active = await db('prescription_items as pi')
    .join('prescriptions as p', 'p.id', 'pi.prescription_id')
    .join('drugs as d', 'd.item_id', 'pi.item_id')
    .where('p.patient_id', patient.id)
    .whereIn('pi.status', ['pending', 'partially_dispensed'])
    .andWhere('p.created_at', '>', db.raw("now() - interval '30 days'"))
    .modify((q) => ctx.excludePrescriptionId && q.whereNot('p.id', ctx.excludePrescriptionId))
    .select('pi.item_id', 'd.generic_name', 'd.atc_code', 'p.rx_number');

  const months = ageParts(patient.date_of_birth).years * 12 + ageParts(patient.date_of_birth).months;
  const latestWeight = await db('triage_vitals')
    .where({ patient_id: patient.id })
    .whereNotNull('weight_kg')
    .whereNull('entered_in_error_at')
    .orderBy('recorded_at', 'desc')
    .first('weight_kg');
  const weight = latestWeight ? Number(latestWeight.weight_kg) : null;

  const generics = [...new Set(lines.map((l) => l.item.drug?.genericName.toLowerCase()).filter(Boolean))];
  const rules = generics.length
    ? await db('dose_rules')
        .where({ active: true })
        .whereIn(db.raw('lower(generic_name)'), generics)
        .andWhere((w) => w.whereNull('facility_id').orWhere('facility_id', patient.facility_id))
    : [];

  const subgroup = (atc) => (atc && atc.length >= 4 ? atc.slice(0, 4).toUpperCase() : null);
  for (const [i, l] of lines.entries()) {
    const drug = l.item.drug;
    if (!drug) continue;

    for (const a of allergies) {
      const why = allergyMatch(a, drug);
      if (!why) continue;
      const severe = ['severe', 'life_threatening'].includes(a.severity);
      out.push({
        itemId: l.itemId,
        code: 'ALLERGY',
        severity: severe ? 'block' : 'warn',
        message: `${a.severity.replace('_', '-')} allergy to ${a.allergen}${a.reaction ? ` (${a.reaction})` : ''}: ${why} as ${drug.genericName}`,
      });
    }

    const sg = subgroup(drug.atcCode);
    const dupes = [
      ...active.filter(
        (x) => x.generic_name.toLowerCase() === drug.genericName.toLowerCase() || (sg && subgroup(x.atc_code) === sg),
      ),
      ...lines
        .slice(0, i)
        .filter(
          (o) =>
            o.item.drug &&
            (o.item.drug.genericName.toLowerCase() === drug.genericName.toLowerCase() ||
              (sg && subgroup(o.item.drug.atcCode) === sg)),
        )
        .map((o) => ({ generic_name: o.item.drug.genericName, rx_number: 'this prescription' })),
    ];
    if (dupes.length)
      out.push({
        itemId: l.itemId,
        code: 'DUPLICATE',
        severity: 'warn',
        message: `Duplicate therapy: already on ${dupes.map((d) => `${d.generic_name} (${d.rx_number})`).join(', ')}`,
      });

    const applicable = rules.filter(
      (r) =>
        r.generic_name.toLowerCase() === drug.genericName.toLowerCase() &&
        (!r.route || r.route === l.route) &&
        (r.min_age_months === null || months >= r.min_age_months) &&
        (r.max_age_months === null || months <= r.max_age_months),
    );
    for (const r of applicable) {
      const single = doseIn(r.dose_unit, l, l.item);
      if (single === null) continue;
      const perDay = FREQUENCIES[l.frequency]?.perDay ?? (l.frequency === 'STAT' ? 1 : null);
      const daily = perDay ? single * perDay : single;
      const unit = r.dose_unit;
      if (r.max_single_dose && single > Number(r.max_single_dose))
        out.push({
          itemId: l.itemId,
          code: 'DOSE_HIGH',
          severity: 'warn',
          message: `${single} ${unit} per dose is above the ${Number(r.max_single_dose)} ${unit} limit`,
        });
      else if (r.max_daily_dose && perDay && daily > Number(r.max_daily_dose))
        out.push({
          itemId: l.itemId,
          code: 'DOSE_HIGH',
          severity: 'warn',
          message: `${daily} ${unit} a day is above the ${Number(r.max_daily_dose)} ${unit} daily limit`,
        });
      if (r.max_daily_per_kg && perDay) {
        if (weight) {
          const limit = Number(r.max_daily_per_kg) * weight;
          if (daily > limit)
            out.push({
              itemId: l.itemId,
              code: 'DOSE_HIGH',
              severity: 'warn',
              message: `${daily} ${unit} a day is above ${Number(r.max_daily_per_kg)} ${unit}/kg for ${weight} kg (${Math.round(limit)} ${unit})`,
            });
        } else
          out.push({
            itemId: l.itemId,
            code: 'DOSE_HIGH',
            severity: 'warn',
            message: `No weight recorded: cannot check the ${Number(r.max_daily_per_kg)} ${unit}/kg limit`,
          });
      }
      if (r.min_single_dose && single < Number(r.min_single_dose))
        out.push({
          itemId: l.itemId,
          code: 'DOSE_LOW',
          severity: 'warn',
          message: `${single} ${unit} per dose is below the usual ${Number(r.min_single_dose)} ${unit}`,
        });
    }
  }
  // One warning per item and code is enough to acknowledge; keep the most specific message.
  const seen = new Set();
  return out.filter((w) => {
    const k = `${w.itemId}|${w.code}|${w.severity}|${w.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
