/**
 * Triage vital-sign rules: BMI and abnormal-value flags.
 *
 * Adult thresholds follow common triage practice (e.g. the Kenya Clinical
 * Guidelines / early-warning scores). Children use WHO IMCI fast-breathing
 * cut-offs by age, and MUAC cut-offs for acute malnutrition in 6–59 months
 * (< 11.5 cm severe, 11.5–12.4 cm moderate). Facilities should review these
 * against their own protocols; flags support, never replace, clinical judgement.
 */

/** @typedef {'low'|'high'|'critical'} FlagLevel */
/** @typedef {{field: string, level: FlagLevel, message: string}} VitalFlag */

/**
 * Body-mass index, 1 decimal place.
 * @param {number|null|undefined} weightKg @param {number|null|undefined} heightCm
 * @returns {number|null}
 */
export function bmi(weightKg, heightCm) {
  if (!weightKg || !heightCm) return null;
  const m = heightCm / 100;
  return Math.round((weightKg / (m * m)) * 10) / 10;
}

/** WHO IMCI fast breathing (breaths/min) for a child's age in months. */
function fastBreathing(ageMonths) {
  if (ageMonths < 2) return 60;
  if (ageMonths < 12) return 50;
  if (ageMonths < 60) return 40;
  return null;
}

/** Upper normal pulse by age (approximate paediatric ranges). */
function pulseHigh(ageMonths) {
  if (ageMonths < 12) return 160;
  if (ageMonths < 60) return 140;
  if (ageMonths < 144) return 120;
  return 100;
}

/**
 * Flag abnormal vital signs.
 * @param {{systolic?: number|null, diastolic?: number|null, pulse?: number|null, temperatureC?: number|null,
 *          respRate?: number|null, spo2?: number|null, weightKg?: number|null, heightCm?: number|null, muacCm?: number|null}} v
 * @param {{ageMonths: number}} patient
 * @returns {VitalFlag[]}
 */
export function evaluateVitals(v, { ageMonths }) {
  /** @type {VitalFlag[]} */
  const flags = [];
  const add = (field, level, message) => flags.push({ field, level, message });
  const adult = ageMonths >= 144; // 12 years and over
  const num = (x) => (x === null || x === undefined || x === '' ? null : Number(x));
  const sbp = num(v.systolic);
  const dbp = num(v.diastolic);
  const pulse = num(v.pulse);
  const temp = num(v.temperatureC);
  const rr = num(v.respRate);
  const spo2 = num(v.spo2);
  const muac = num(v.muacCm);

  if (adult && sbp !== null) {
    if (sbp >= 180) add('systolic', 'critical', 'Systolic BP ≥ 180: hypertensive urgency');
    else if (sbp >= 140) add('systolic', 'high', 'Systolic BP raised (≥ 140)');
    else if (sbp < 90) add('systolic', sbp < 80 ? 'critical' : 'low', 'Systolic BP low (< 90)');
  }
  if (adult && dbp !== null) {
    if (dbp >= 120) add('diastolic', 'critical', 'Diastolic BP ≥ 120');
    else if (dbp >= 90) add('diastolic', 'high', 'Diastolic BP raised (≥ 90)');
  }
  if (pulse !== null) {
    const hi = pulseHigh(ageMonths);
    if (pulse >= hi + 30 || pulse < 40) add('pulse', 'critical', `Pulse ${pulse}/min`);
    else if (pulse > hi) add('pulse', 'high', `Pulse fast (> ${hi}/min)`);
    else if (adult && pulse < 50) add('pulse', 'low', 'Pulse slow (< 50/min)');
  }
  if (temp !== null) {
    if (temp >= 40) add('temperatureC', 'critical', 'Hyperpyrexia (≥ 40 °C)');
    else if (temp >= 37.5) add('temperatureC', 'high', 'Fever (≥ 37.5 °C)');
    else if (temp < 35) add('temperatureC', 'critical', 'Hypothermia (< 35 °C)');
  }
  if (rr !== null) {
    const fast = fastBreathing(ageMonths);
    if (fast !== null) {
      if (rr >= fast) add('respRate', rr >= fast + 10 ? 'critical' : 'high', `Fast breathing for age (≥ ${fast}/min)`);
    } else if (rr > 30 || rr < 8) add('respRate', 'critical', `Respiratory rate ${rr}/min`);
    else if (rr > 20) add('respRate', 'high', 'Respiratory rate raised (> 20/min)');
    else if (rr < 12) add('respRate', 'low', 'Respiratory rate low (< 12/min)');
  }
  if (spo2 !== null) {
    if (spo2 < 90) add('spo2', 'critical', 'SpO₂ < 90%: give oxygen');
    else if (spo2 < 94) add('spo2', 'low', 'SpO₂ low (< 94%)');
  }
  if (muac !== null && ageMonths >= 6 && ageMonths < 60) {
    if (muac < 11.5) add('muacCm', 'critical', 'MUAC < 11.5 cm: severe acute malnutrition');
    else if (muac < 12.5) add('muacCm', 'high', 'MUAC 11.5–12.4 cm: moderate acute malnutrition');
  }
  const b = adult ? bmi(num(v.weightKg), num(v.heightCm)) : null;
  if (b !== null) {
    if (b < 16) add('bmi', 'critical', `BMI ${b}: severe thinness`);
    else if (b < 18.5) add('bmi', 'low', `BMI ${b}: underweight`);
    else if (b >= 30) add('bmi', 'high', `BMI ${b}: obese`);
    else if (b >= 25) add('bmi', 'high', `BMI ${b}: overweight`);
  }
  return flags;
}

/**
 * Note templates offered per department type. Prompts become placeholders in
 * the SOAP fields.
 */
export const NOTE_TEMPLATES = [
  {
    code: 'opd_general',
    name: 'General outpatient consultation',
    noteType: 'soap',
    departments: ['opd', 'emergency', 'other'],
    prompts: {
      subjective:
        'Presenting complaint and duration; history of presenting illness; past medical, drug, social history',
      objective: 'General examination; systems examination; relevant findings',
      assessment: 'Impression / working diagnosis',
      plan: 'Investigations, treatment, advice, follow-up',
    },
  },
  {
    code: 'triage',
    name: 'Triage note',
    noteType: 'triage',
    departments: ['opd', 'emergency'],
    prompts: {
      subjective: 'Chief complaint in the patient’s words; danger signs asked',
      objective: 'Appearance, danger signs observed',
      assessment: 'Triage category (emergency / priority / queue)',
      plan: 'Where sent and why',
    },
  },
  {
    code: 'paediatric',
    name: 'Paediatric consultation (IMCI)',
    noteType: 'soap',
    departments: ['opd', 'emergency', 'ipd'],
    prompts: {
      subjective:
        'Main problem; general danger signs (unable to drink/breastfeed, vomits everything, convulsions); cough, diarrhoea, fever, ear problem; immunisation and feeding history',
      objective: 'Lethargic/unconscious; chest indrawing; dehydration signs; weight-for-age, MUAC, oedema',
      assessment: 'IMCI classification(s)',
      plan: 'Treatment, counselling of caregiver, when to return immediately, follow-up',
    },
  },
  {
    code: 'antenatal',
    name: 'Antenatal visit',
    noteType: 'soap',
    departments: ['maternity', 'opd'],
    prompts: {
      subjective:
        'Gestation (LMP), complaints, fetal movements, danger signs (bleeding, headache, blurred vision, fever)',
      objective: 'BP, weight, fundal height, fetal heart rate, presentation, oedema, pallor',
      assessment: 'Gravida/para, gestation, risk factors',
      plan: 'Tests (Hb, HIV, syphilis, urinalysis), supplements, IPTp, TT, birth plan, next visit',
    },
  },
  {
    code: 'nursing',
    name: 'Nursing note',
    noteType: 'nursing',
    departments: ['ipd', 'maternity', 'emergency', 'opd'],
    prompts: {
      subjective: 'Patient report',
      objective: 'Observations and care given',
      assessment: 'Nursing assessment',
      plan: 'Nursing plan',
    },
  },
  {
    code: 'procedure',
    name: 'Procedure note',
    noteType: 'procedure',
    departments: ['opd', 'emergency', 'theatre'],
    prompts: {
      subjective: 'Indication and consent',
      objective: 'Procedure performed, anaesthesia, findings, complications',
      assessment: 'Outcome',
      plan: 'Post-procedure care and review',
    },
  },
];
