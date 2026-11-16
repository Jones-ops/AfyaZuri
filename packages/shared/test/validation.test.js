import { describe, expect, it } from 'vitest';
import { checkPassword } from '../src/password-policy.js';
import { kenyanPhone } from '../src/schemas/common.js';
import { createUserBody } from '../src/schemas/users.js';
import { facilityBody } from '../src/schemas/facilities.js';

describe('password policy', () => {
  it('accepts a strong password', () => expect(checkPassword('Str0ng!Passw0rd')).toEqual([]));
  it('lists every unmet rule', () => {
    expect(checkPassword('short')).toEqual(
      expect.arrayContaining(['At least 10 characters', 'An uppercase letter', 'A number', 'A symbol']),
    );
  });
  it('rejects passwords containing the username', () =>
    expect(checkPassword('Mwangi!2026xx', { username: 'mwangi' })).toContain('Must not contain your username'));
});

describe('kenyanPhone', () => {
  it.each([
    ['0712 345 678', '+254712345678'],
    ['254712345678', '+254712345678'],
    ['+254 110-123-456', '+254110123456'],
  ])('normalises %s', (input, out) => expect(kenyanPhone.parse(input)).toBe(out));

  it.each(['0812345678', '+255712345678', '07123'])('rejects %s', (input) =>
    expect(kenyanPhone.safeParse(input).success).toBe(false),
  );
});

describe('schemas', () => {
  it('requires at least one role for a new user', () => {
    const r = createUserBody.safeParse({ username: 'abc', fullName: 'A B', password: 'x'.repeat(10), roles: [] });
    expect(r.success).toBe(false);
  });

  it('requires {seq} in the MRN format', () => {
    const base = { name: 'X Hospital', kmhflCode: '12345', level: 'level_4', ownership: 'county' };
    expect(facilityBody.safeParse({ ...base, mrnFormat: '{facility_code}-{year}' }).success).toBe(false);
    expect(facilityBody.parse(base).mrnFormat).toBe('{facility_code}-{year}-{seq}');
  });
});
