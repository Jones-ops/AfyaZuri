import { describe, expect, it } from 'vitest';
import { bmi, evaluateVitals } from '../src/vitals.js';
import { noteBody, vitalsBody } from '../src/schemas/emr.js';

const adult = { ageMonths: 40 * 12 };
const fields = (v, who = adult) => evaluateVitals(v, who).map((f) => `${f.field}:${f.level}`);

describe('BMI', () => {
  it('calculates to one decimal place', () => {
    expect(bmi(70, 175)).toBe(22.9);
    expect(bmi(null, 175)).toBeNull();
  });
});

describe('adult vital-sign flags', () => {
  it('passes normal values', () => {
    expect(
      fields({
        systolic: 118,
        diastolic: 76,
        pulse: 72,
        temperatureC: 36.8,
        respRate: 16,
        spo2: 98,
        weightKg: 70,
        heightCm: 175,
      }),
    ).toEqual([]);
  });
  it('grades blood pressure', () => {
    expect(fields({ systolic: 150, diastolic: 95 })).toEqual(['systolic:high', 'diastolic:high']);
    expect(fields({ systolic: 190, diastolic: 125 })).toEqual(['systolic:critical', 'diastolic:critical']);
    expect(fields({ systolic: 75, diastolic: 40 })).toEqual(['systolic:critical']);
  });
  it('flags fever, hypothermia and hypoxia', () => {
    expect(fields({ temperatureC: 38.2 })).toEqual(['temperatureC:high']);
    expect(fields({ temperatureC: 34.5 })).toEqual(['temperatureC:critical']);
    expect(fields({ spo2: 92 })).toEqual(['spo2:low']);
    expect(fields({ spo2: 85 })).toEqual(['spo2:critical']);
  });
  it('flags BMI bands', () => {
    expect(fields({ weightKg: 95, heightCm: 170 })).toEqual(['bmi:high']); // 32.9 obese
    expect(fields({ weightKg: 52, heightCm: 170 })).toEqual(['bmi:low']); // 18.0 underweight
    expect(fields({ weightKg: 45, heightCm: 170 })).toEqual(['bmi:critical']); // 15.6 severe thinness
  });
});

describe('child vital-sign flags', () => {
  it('uses WHO fast-breathing cut-offs by age', () => {
    expect(fields({ respRate: 55 }, { ageMonths: 1 })).toEqual([]);
    expect(fields({ respRate: 62 }, { ageMonths: 1 })).toEqual(['respRate:high']);
    expect(fields({ respRate: 45 }, { ageMonths: 6 })).toEqual([]);
    expect(fields({ respRate: 52 }, { ageMonths: 6 })).toEqual(['respRate:high']);
    expect(fields({ respRate: 42 }, { ageMonths: 30 })).toEqual(['respRate:high']);
  });
  it('flags acute malnutrition by MUAC from 6 to 59 months only', () => {
    expect(fields({ muacCm: 11.0 }, { ageMonths: 18 })).toEqual(['muacCm:critical']);
    expect(fields({ muacCm: 12.0 }, { ageMonths: 18 })).toEqual(['muacCm:high']);
    expect(fields({ muacCm: 13.0 }, { ageMonths: 18 })).toEqual([]);
    expect(fields({ muacCm: 11.0 }, { ageMonths: 4 })).toEqual([]);
  });
  it('does not apply adult BP or BMI rules to children', () => {
    expect(fields({ systolic: 95, diastolic: 60, weightKg: 12, heightCm: 85 }, { ageMonths: 24 })).toEqual([]);
  });
});

describe('EMR schemas', () => {
  it('requires a measurement and both blood-pressure values', () => {
    expect(vitalsBody.safeParse({ notes: 'calm' }).success).toBe(false);
    expect(vitalsBody.safeParse({ systolic: 120 }).success).toBe(false);
    expect(vitalsBody.safeParse({ systolic: 80, diastolic: 120 }).success).toBe(false);
    expect(vitalsBody.safeParse({ systolic: '120', diastolic: '80', pulse: '' }).data).toMatchObject({
      systolic: 120,
      diastolic: 80,
    });
  });
  it('rejects empty notes and signs by default', () => {
    expect(noteBody.safeParse({ subjective: '' }).success).toBe(false);
    expect(noteBody.parse({ subjective: 'Headache' }).sign).toBe(true);
  });
});
