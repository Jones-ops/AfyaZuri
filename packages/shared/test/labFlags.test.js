import { describe, expect, it } from 'vitest';
import { flagFor, pickRange, rangeText } from '../src/labFlags.js';

const Y = 365;
const ranges = [
  { sex: 'male', ageMinDays: 12 * Y, ageMaxDays: null, low: 13, high: 17, criticalLow: 7, criticalHigh: 20 },
  { sex: 'female', ageMinDays: 12 * Y, ageMaxDays: null, low: 12, high: 15, criticalLow: 7, criticalHigh: 20 },
  { sex: null, ageMinDays: Y, ageMaxDays: 12 * Y - 1, low: 11, high: 14.5, criticalLow: 7, criticalHigh: 20 },
];
const numeric = { resultType: 'numeric' };

describe('lab flags', () => {
  it('picks the range for sex and age', () => {
    expect(pickRange(ranges, { sex: 'female', ageDays: 30 * Y }).low).toBe(12);
    expect(pickRange(ranges, { sex: 'male', ageDays: 30 * Y }).low).toBe(13);
    expect(pickRange(ranges, { sex: 'male', ageDays: 5 * Y }).low).toBe(11);
    expect(pickRange(ranges, { sex: 'male', ageDays: 100 })).toBeNull(); // no infant range
  });

  it('flags low, high and critical values', () => {
    const r = pickRange(ranges, { sex: 'female', ageDays: 30 * Y });
    expect(flagFor(numeric, r, 13)).toEqual({ flag: 'N', critical: false });
    expect(flagFor(numeric, r, 11.9)).toEqual({ flag: 'L', critical: false });
    expect(flagFor(numeric, r, 15.1)).toEqual({ flag: 'H', critical: false });
    expect(flagFor(numeric, r, 6.5)).toEqual({ flag: 'LL', critical: true });
    expect(flagFor(numeric, r, 21)).toEqual({ flag: 'HH', critical: true });
    expect(flagFor(numeric, null, 21)).toEqual({ flag: null, critical: false });
  });

  it('flags abnormal answers', () => {
    const c = { resultType: 'options', abnormalOptions: ['Positive'] };
    expect(flagFor(c, null, 'Positive').flag).toBe('A');
    expect(flagFor(c, null, 'Negative').flag).toBe('N');
  });

  it('describes ranges', () => {
    expect(rangeText({ low: 4, high: 11 })).toBe('4.0–11.0');
    expect(rangeText({ low: null, high: 5 }, 0)).toBe('< 5');
    expect(rangeText(null)).toBeNull();
  });
});
