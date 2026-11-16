import { describe, expect, it } from 'vitest';
import { ageLabel, dobFromEstimatedAge, isUnderFive, registerPatientBody } from '@afyazuri/shared';
import {
  classifyQuery,
  formatMrn,
  maskIdentifier,
  maskPhone,
  scoreCandidate,
} from '../../src/modules/patients/identity.js';

describe('MRN format', () => {
  it('renders facility code, year and padded sequence', () => {
    expect(formatMrn('{facility_code}-{year}-{seq}', { facilityCode: '99001', year: 2026, seq: 42 })).toBe(
      '99001-2026-000042',
    );
    expect(formatMrn('KCH/{yy}/{seq:4}', { facilityCode: '1', year: 2026, seq: 7 })).toBe('KCH/26/0007');
  });
});

describe('search classification', () => {
  it('recognises MRNs, phones, identifiers and names', () => {
    expect(classifyQuery('99001-2026-000042')).toMatchObject({ mrn: '99001-2026-000042', nameWords: [] });
    expect(classifyQuery('0712 345 678').phone).toBe('+254712345678');
    expect(classifyQuery('12345678')).toMatchObject({ identifier: '12345678', phone: null });
    expect(classifyQuery('  Akinyi  ODERA ')).toMatchObject({
      mrn: null,
      phone: null,
      identifier: null,
      nameWords: ['akinyi', 'odera'],
    });
    expect(classifyQuery("Wang'ombe").nameWords).toEqual(["wang'ombe"]);
  });
});

describe('duplicate scoring', () => {
  const base = {
    first_name: 'A',
    middle_name: null,
    last_name: 'B',
    date_of_birth: '1990-05-01',
    dob_estimated: false,
    name_similarity: 0,
    phone_match: false,
    identifier_match: null,
  };
  const input = { dateOfBirth: '1990-05-01', estimated: false };

  it('treats a shared identifier as a certain match', () => {
    expect(
      scoreCandidate({ ...base, identifier_match: 'national_id', date_of_birth: '1970-01-01' }, input),
    ).toMatchObject({ score: 100 });
  });
  it('scores the same name and date of birth highly', () => {
    const r = scoreCandidate({ ...base, name_similarity: 1 }, input);
    expect(r.score).toBe(70);
    expect(r.reasons).toEqual(['Same name', 'Same date of birth']);
  });
  it('allows age drift when either date of birth is estimated', () => {
    expect(
      scoreCandidate({ ...base, name_similarity: 0.95, dob_estimated: true, date_of_birth: '1991-02-01' }, input).score,
    ).toBe(55);
  });
  it('discounts namesakes of clearly different ages', () => {
    expect(scoreCandidate({ ...base, name_similarity: 1, date_of_birth: '1960-01-01' }, input).score).toBe(10);
  });
});

describe('masking', () => {
  it('masks phones and identifiers for lists', () => {
    expect(maskPhone('+254712345678')).toBe('07•• ••• 678');
    expect(maskPhone(null)).toBeNull();
    expect(maskIdentifier('12345678')).toBe('••••5678');
  });
});

describe('ages', () => {
  it('derives an estimated date of birth and labels ages clinically', () => {
    expect(dobFromEstimatedAge(2, 6, '2026-11-17')).toBe('2024-05-17');
    expect(ageLabel('2026-11-03', '2026-11-17')).toBe('14 d');
    expect(ageLabel('2025-11-17', '2026-11-17')).toBe('12 mo');
    expect(ageLabel('2000-11-18', '2026-11-17')).toBe('25 y');
    expect(isUnderFive('2022-01-01', '2026-11-17')).toBe(true);
  });
});

describe('registration schema', () => {
  const ok = { firstName: 'Akinyi', lastName: 'Odera', sex: 'female', dateOfBirth: '1990-05-01' };
  it('requires a date of birth or an estimated age', () => {
    expect(registerPatientBody.safeParse({ ...ok, dateOfBirth: undefined }).success).toBe(false);
    expect(registerPatientBody.safeParse({ ...ok, dateOfBirth: undefined, estimatedAge: { years: 40 } }).success).toBe(
      true,
    );
  });
  it('rejects malformed identifiers and repeated types', () => {
    expect(registerPatientBody.safeParse({ ...ok, identifiers: [{ type: 'national_id', value: 'ABC' }] }).success).toBe(
      false,
    );
    expect(
      registerPatientBody.safeParse({
        ...ok,
        identifiers: [
          { type: 'national_id', value: '12345678' },
          { type: 'national_id', value: '87654321' },
        ],
      }).success,
    ).toBe(false);
  });
  it('rejects future dates of birth', () => {
    expect(registerPatientBody.safeParse({ ...ok, dateOfBirth: '2999-01-01' }).success).toBe(false);
  });
});
