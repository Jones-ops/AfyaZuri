import { describe, expect, it } from 'vitest';
import { CODE128_PATTERNS, code128 } from '../src/barcode.js';

describe('Code 128', () => {
  it('has a well-formed symbol table', () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    for (const p of CODE128_PATTERNS.slice(0, 106)) {
      expect(p).toHaveLength(6);
      expect([...p].reduce((s, d) => s + Number(d), 0)).toBe(11); // every symbol is 11 modules wide
    }
    expect([...CODE128_PATTERNS[106]].reduce((s, d) => s + Number(d), 0)).toBe(13);
    expect(new Set(CODE128_PATTERNS).size).toBe(107);
  });

  it('adds the start code, check digit and stop code', () => {
    // "AB": A=33, B=34; check = (104 + 33×1 + 34×2) mod 103 = 205 mod 103 = 102
    expect(code128('AB').values).toEqual([104, 33, 34, 102, 106]);
    const { modules } = code128('L-2026-000001');
    expect(modules.reduce((s, m) => s + m, 0)).toBe(11 * (13 + 3) + 2); // 13 chars + start + check + stop(13)
  });

  it('refuses characters it cannot encode', () => {
    expect(() => code128('Wambũi')).toThrow();
  });
});
