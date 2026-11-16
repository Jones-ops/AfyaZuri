import { describe, expect, it } from 'vitest';
import { parseSimpleTabulation } from '../../../../scripts/lib/icd.js';

const BOM = String.fromCharCode(0xfeff);
const header = [
  'Foundation URI',
  'Linearization URI',
  'Code',
  'BlockId',
  'Title',
  'ClassKind',
  'DepthInKind',
  'IsResidual',
  'ChapterNo',
].join('\t');
const row = (code, title, kind, chapter) =>
  ['http://f', 'http://l', code, '', title, kind, '1', 'False', chapter].join('\t');

describe('ICD-11 SimpleTabulation parser', () => {
  it('keeps coded categories, strips depth dashes and a BOM', () => {
    const file = [
      BOM + header,
      row('', 'Certain infectious or parasitic diseases', 'chapter', '01'),
      row('', '- Malaria', 'block', '01'),
      row('1F40', '- - Malaria due to Plasmodium falciparum', 'category', '01'),
      row('"BA00"', '"- Essential hypertension"', 'category', '11'),
      '',
    ].join('\r\n');
    expect(parseSimpleTabulation(file)).toEqual([
      { system: 'icd11', code: '1F40', title: 'Malaria due to Plasmodium falciparum', chapter: '01' },
      { system: 'icd11', code: 'BA00', title: 'Essential hypertension', chapter: '11' },
    ]);
  });

  it('rejects files without the expected columns', () => {
    expect(() => parseSimpleTabulation('a\tb\n1\t2')).toThrow(/Code" and "Title/);
  });
});
