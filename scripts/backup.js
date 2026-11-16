#!/usr/bin/env node
// Afyazuri backup tool.
//
//   npm run backup                     create an encrypted backup, prune old ones, copy off-site
//   npm run backup -- verify <file>    decrypt and check a backup without touching the database
//   npm run backup -- restore <file> --database-url <url> --yes
//                                      DESTRUCTIVE: replace that database's contents
//   npm run backup -- prune            apply the retention policy only
//
// Settings (environment or .env): DATABASE_URL, BACKUP_KEY, BACKUP_DIR (default ./backups),
// BACKUP_OFFSITE_DIR (optional, e.g. a mounted network share or USB disk),
// BACKUP_KEEP_DAILY=7, BACKUP_KEEP_WEEKLY=4, BACKUP_KEEP_MONTHLY=12.
import { existsSync, promises as fs } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import knex from 'knex';
import { createBackup, pruneBackups, restoreBackup, verifyBackup } from '../apps/api/src/ops/backup.js';

const root = resolve(fileURLToPath(import.meta.url), '../..');
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));

const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith('--') ? args[0] : 'create';
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
};

const key = process.env.BACKUP_KEY;
const dir = resolve(root, process.env.BACKUP_DIR ?? 'backups');
const policy = {
  daily: Number(process.env.BACKUP_KEEP_DAILY ?? 7),
  weekly: Number(process.env.BACKUP_KEEP_WEEKLY ?? 4),
  monthly: Number(process.env.BACKUP_KEEP_MONTHLY ?? 12),
};
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};
if (!key && cmd !== 'prune') fail('BACKUP_KEY is not set (run `npm run secrets` or add it to .env).');

const connect = (url) => knex({ client: 'pg', connection: url, pool: { min: 0, max: 2 } });

try {
  if (cmd === 'create') {
    const db = connect(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54329/afyazuri');
    const r = await createBackup({ db, key, dir });
    await db.destroy();
    console.log(`✓ Backup written: ${r.file} (${(r.bytes / 1024).toFixed(1)} KB, ${r.tables} tables, ${r.rows} rows)`);
    await verifyBackup(r.file, key);
    console.log('✓ Verified: decrypts and parses cleanly');
    const removed = await pruneBackups(dir, policy);
    if (removed.length) console.log(`✓ Pruned ${removed.length} old backup(s)`);
    const offsite = process.env.BACKUP_OFFSITE_DIR;
    if (offsite) {
      await fs.mkdir(offsite, { recursive: true });
      await fs.copyFile(r.file, join(offsite, basename(r.file)));
      await pruneBackups(offsite, policy);
      console.log(`✓ Copied off-site to ${offsite}`);
    }
  } else if (cmd === 'verify') {
    const file = args[1] ?? fail('Usage: backup verify <file>');
    const { manifest, counts } = await verifyBackup(resolve(file), key);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    console.log(`✓ ${basename(file)} is intact`);
    console.log(`  created ${manifest.createdAt} from database "${manifest.database}"`);
    console.log(`  ${manifest.tables.length} tables, ${total} rows, ${manifest.migrations.length} migrations`);
  } else if (cmd === 'restore') {
    const file = args[1] ?? fail('Usage: backup restore <file> --database-url <url> --yes');
    const url = flag('database-url');
    if (typeof url !== 'string') fail('Pass --database-url explicitly so the target is never guessed.');
    if (flag('yes') !== true)
      fail(`This replaces everything in ${url.replace(/:[^:@/]+@/, ':***@')}. Re-run with --yes to confirm.`);
    const db = connect(url);
    const r = await restoreBackup({ db, file: resolve(file), key, migrationsDir: join(root, 'db/migrations') });
    await db.destroy();
    const total = Object.values(r.counts).reduce((a, b) => a + b, 0);
    console.log(`✓ Restored ${total} rows across ${Object.keys(r.counts).length} tables from ${basename(file)}`);
  } else if (cmd === 'prune') {
    const removed = await pruneBackups(dir, policy);
    console.log(`✓ Pruned ${removed.length} backup(s) from ${dir}`);
  } else {
    fail(`Unknown command "${cmd}". Use create, verify, restore or prune.`);
  }
} catch (err) {
  fail(err.message);
}
