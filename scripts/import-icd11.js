#!/usr/bin/env node
// Import the official WHO ICD-11 MMS linearization into icd_codes.
//
//   npm run icd:import -- path/to/SimpleTabulation-ICD-11-MMS-en.txt
//
// Download the SimpleTabulation file from icd.who.int (Info → Download → Linearization
// files). Only coded categories are imported. Existing codes are updated, so this is
// safe to re-run when WHO publishes a new release.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import knex from 'knex';
import { loadEnv } from './lib/env.js';
import { parseSimpleTabulation } from './lib/icd.js';

loadEnv();
const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run icd:import -- <SimpleTabulation-ICD-11-MMS-en.txt>');
  process.exit(1);
}

let rows;
try {
  rows = parseSimpleTabulation(readFileSync(resolve(file), 'utf8'));
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
}
if (!rows.length) {
  console.error('✗ No coded categories found in the file');
  process.exit(1);
}

const url =
  process.env.EXTERNAL_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:54329/afyazuri';
const db = knex({ client: 'pg', connection: url });
try {
  for (let i = 0; i < rows.length; i += 1000)
    await db('icd_codes')
      .insert(rows.slice(i, i + 1000))
      .onConflict(['system', 'code'])
      .merge(['title', 'chapter']);
  console.log(`✓ Imported ${rows.length} ICD-11 codes`);
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
