#!/usr/bin/env node
// Create .env from .env.example, filling every empty secret with a fresh random value.
// Existing values are never overwritten, so this is safe to re-run.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/env.js';

const GENERATORS = {
  JWT_SECRET: () => randomBytes(48).toString('base64url'),
  ENCRYPTION_KEY: () => randomBytes(32).toString('base64'),
  BLIND_INDEX_KEY: () => randomBytes(32).toString('base64'),
  BACKUP_KEY: () => randomBytes(32).toString('base64'),
  PG_PASSWORD: () => randomBytes(18).toString('base64url'),
  MPESA_CALLBACK_TOKEN: () => randomBytes(24).toString('base64url'),
};

const envPath = join(ROOT, '.env');
const base = readFileSync(existsSync(envPath) ? envPath : join(ROOT, '.env.example'), 'utf8');
const filled = [];
const out = base
  .split(/\r?\n/)
  .map((line) => {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m || m[2].trim() !== '' || !GENERATORS[m[1]]) return line;
    filled.push(m[1]);
    return `${m[1]}=${GENERATORS[m[1]]()}`;
  })
  .join('\n');

writeFileSync(envPath, out.endsWith('\n') ? out : `${out}\n`, { mode: 0o600 });
console.log(
  filled.length ? `✓ Generated ${filled.join(', ')} in .env` : '✓ .env already has all secrets; nothing changed',
);
console.log('  Keep a copy of ENCRYPTION_KEY, BLIND_INDEX_KEY and BACKUP_KEY somewhere safe and separate:');
console.log('  without them, encrypted fields and backups cannot be read.');
