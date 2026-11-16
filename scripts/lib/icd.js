/**
 * Parse WHO's ICD-11 MMS "SimpleTabulation" export (tab-separated, header row).
 * Returns coded categories only, with depth dashes removed from titles.
 * @param {string} raw file contents
 * @returns {{system: 'icd11', code: string, title: string, chapter: string|null}[]}
 */
export function parseSimpleTabulation(raw) {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw; // strip a UTF-8 byte-order mark
  const [header = '', ...lines] = text.split(/\r?\n/);
  const unquote = (s) => (s ?? '').trim().replace(/^"|"$/g, '').replace(/""/g, '"');
  const cols = header.split('\t').map(unquote);
  const idx = (name) => cols.findIndex((c) => c.toLowerCase() === name.toLowerCase());
  const iCode = idx('Code');
  const iTitle = idx('Title');
  const iChapter = idx('ChapterNo');
  const iKind = idx('ClassKind');
  if (iCode < 0 || iTitle < 0)
    throw new Error(`Not a SimpleTabulation file: expected "Code" and "Title" columns, found: ${cols.join(', ')}`);

  const rows = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const f = line.split('\t');
    const code = unquote(f[iCode]);
    if (!code || (iKind >= 0 && unquote(f[iKind]) !== 'category')) continue;
    const title = unquote(f[iTitle])
      .replace(/^(-\s*)+/, '')
      .trim();
    if (title)
      rows.push({ system: 'icd11', code, title, chapter: iChapter >= 0 ? unquote(f[iChapter]) || null : null });
  }
  return rows;
}
