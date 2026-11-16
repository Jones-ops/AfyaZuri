import { describe, expect, it } from 'vitest';
import { selectRetention } from '../../src/ops/backup.js';

/** One backup per day at 01:30 UTC for `days` days ending on `end`. */
function nightly(end, days) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(end.getTime() - i * 86400000);
    out.push(`afyazuri-${d.toISOString().slice(0, 10).replace(/-/g, '')}-013000.azb`);
  }
  return out;
}

describe('backup retention (7 daily, 4 weekly, 12 monthly)', () => {
  const files = nightly(new Date('2026-11-16T01:30:00Z'), 400);
  const { keep, remove } = selectRetention(files);

  it('keeps the last 7 days', () => {
    expect(keep.slice(0, 7)).toEqual(files.slice(0, 7));
  });

  it('keeps one per month for 12 months', () => {
    const months = new Set(keep.map((f) => f.slice(9, 15)));
    expect(months.size).toBe(12);
  });

  it('keeps a bounded set and removes the rest', () => {
    expect(keep.length).toBeLessThanOrEqual(7 + 4 + 12);
    expect(keep.length + remove.length).toBe(files.length);
    expect(remove).not.toContain(files[0]);
  });

  it('ignores files that are not backups', () => {
    expect(selectRetention(['notes.txt', 'afyazuri-x.azb']).keep).toEqual([]);
  });

  it('keeps several backups from one day only once in the daily set', () => {
    const r = selectRetention(['afyazuri-20261116-010000.azb', 'afyazuri-20261116-120000.azb'], {
      daily: 1,
      weekly: 0,
      monthly: 0,
    });
    expect(r.keep).toEqual(['afyazuri-20261116-120000.azb']);
  });
});
