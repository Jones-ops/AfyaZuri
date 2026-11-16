#!/usr/bin/env node
// Regenerate docs/permission-matrix.md from packages/shared/src/permissions.js.
// CI runs this with --check and fails if the committed file is out of date.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PERMISSION_GROUPS, ROLES, TWO_FACTOR_ROLES } from '../packages/shared/src/permissions.js';
import { ROOT } from './lib/env.js';

const codes = Object.keys(ROLES);
const lines = [
  '# Permission matrix',
  '',
  '> Generated from `packages/shared/src/permissions.js` by `npm run docs:permissions`. Do not edit by hand.',
  '',
  'Permissions are granted to roles; roles are assigned to users **per facility**, optionally narrowed to one',
  'department. The API checks the permission on every request (the UI only hides what you cannot use).',
  'Clinical permissions (`emr.*`, `orders.*`) are held only by clinical roles.',
  '',
  '## Roles',
  '',
  '| Code | Role | Clinical | 2FA expected | Permissions | Purpose |',
  '| --- | --- | :---: | :---: | ---: | --- |',
  ...codes.map((c) => {
    const r = ROLES[c];
    return `| \`${c}\` | ${r.name} | ${r.clinical ? '✔' : ''} | ${TWO_FACTOR_ROLES.includes(c) ? '✔' : ''} | ${r.permissions.length} | ${r.description} |`;
  }),
  '',
  '## Matrix',
  '',
  'Column keys: ' + codes.map((c, i) => `**${i + 1}** ${ROLES[c].name}`).join(' · '),
  '',
];
for (const [group, perms] of Object.entries(PERMISSION_GROUPS)) {
  lines.push(
    `### ${group}`,
    '',
    `| Permission | ${codes.map((_, i) => i + 1).join(' | ')} |`,
    `| --- | ${codes.map(() => ':-:').join(' | ')} |`,
  );
  for (const [code, desc] of Object.entries(perms))
    lines.push(
      `| \`${code}\` — ${desc} | ${codes.map((c) => (ROLES[c].permissions.includes(code) ? '●' : '')).join(' | ')} |`,
    );
  lines.push('');
}

const out = `${lines.join('\n')}`;
const file = join(ROOT, 'docs/permission-matrix.md');
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    /* missing */
  }
  if (current.replace(/\r\n/g, '\n') !== out) {
    console.error('✗ docs/permission-matrix.md is out of date. Run `npm run docs:permissions` and commit it.');
    process.exit(1);
  }
  console.log('✓ docs/permission-matrix.md is up to date');
} else {
  writeFileSync(file, out);
  console.log(`✓ Wrote ${file}`);
}
