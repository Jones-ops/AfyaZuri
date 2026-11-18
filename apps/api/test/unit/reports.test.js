import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from '../../src/lib/csv.js';
import { bucketOf } from '../../src/modules/reports/financial.js';

describe('CSV', () => {
  it('neutralises formula injection but keeps numbers', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+254712')).toBe("'+254712");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('-200.00')).toBe('-200.00');
    expect(csvCell('-x')).toBe("'-x");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe('');
  });
  it('writes a BOM and CRLF rows', () => {
    expect(toCsv(['A', 'B'], [[1, 'x']])).toBe('\uFEFFA,B\r\n1,x\r\n');
  });
});

describe('ageing buckets', () => {
  it('puts boundary days in the lower bucket', () => {
    expect([0, 30, 31, 60, 61, 90, 91, 400].map(bucketOf)).toEqual([
      '0-30',
      '0-30',
      '31-60',
      '31-60',
      '61-90',
      '61-90',
      '90+',
      '90+',
    ]);
  });
});
