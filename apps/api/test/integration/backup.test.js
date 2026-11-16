import { randomBytes } from 'node:crypto';
import { mkdtempSync, promises as fs, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import knex from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackup, restoreBackup, verifyBackup } from '../../src/ops/backup.js';
import { makeApp, signIn } from '../helpers.js';

const key = randomBytes(32).toString('base64');
const migrationsDir = resolve(import.meta.dirname, '../../../../db/migrations');
let ctx;
let dir;
let target;
let backup;
let usersAtBackup;

beforeAll(async () => {
  ctx = makeApp();
  dir = mkdtempSync(join(tmpdir(), 'afyazuri-bak-'));
  const name = `afyazuri_restore_${Date.now()}`;
  await ctx.db.raw(`CREATE DATABASE ${name}`);
  const url = new URL(ctx.config.DATABASE_URL);
  url.pathname = `/${name}`;
  target = knex({ client: 'pg', connection: url.toString(), pool: { min: 0, max: 2 } });
  await signIn(ctx.app, 'facadmin'); // guarantees audit rows exist to back up
  usersAtBackup = Number((await ctx.db('users').count({ n: '*' }).first()).n);
  backup = await createBackup({ db: ctx.db, key, dir });
});
afterAll(async () => {
  await target?.destroy();
  await ctx.db.destroy();
  rmSync(dir, { recursive: true, force: true });
});

describe('encrypted backups', () => {
  it('writes an encrypted file that verifies cleanly', async () => {
    expect(backup.file).toMatch(/afyazuri-\d{8}-\d{6}\.azb$/);
    const raw = await fs.readFile(backup.file);
    expect(raw.subarray(0, 4).toString()).toBe('AZB1');
    expect(raw.includes(Buffer.from('facadmin'))).toBe(false); // nothing readable in the file

    const { manifest, counts } = await verifyBackup(backup.file, key);
    expect(manifest.tables).toContain('audit_log');
    expect(counts.users).toBe(usersAtBackup);
  });

  it('rejects a tampered file and a wrong key', async () => {
    const bad = join(dir, 'afyazuri-20260101-000000.azb');
    const raw = await fs.readFile(backup.file);
    raw[Math.floor(raw.length / 2)] ^= 0xff;
    await fs.writeFile(bad, raw);
    await expect(verifyBackup(bad, key)).rejects.toThrow(/integrity|Corrupt|empty/);
    await expect(verifyBackup(backup.file, randomBytes(32).toString('base64'))).rejects.toThrow(
      /integrity|Corrupt|empty/,
    );
  });

  it('restores into a fresh database with identical contents and working guarantees', async () => {
    const { counts } = await restoreBackup({ db: target, file: backup.file, key, migrationsDir });
    for (const t of ['users', 'roles', 'role_permissions', 'facilities', 'beds', 'audit_log', 'user_roles']) {
      const n = Number((await target(t).count({ n: '*' }).first()).n);
      expect(n, t).toBe(counts[t]);
      expect(n, t).toBeGreaterThan(0);
    }

    const src = await ctx.db('users').where({ username: 'doctor' }).first('id', 'password_hash', 'licence_number');
    expect(await target('users').where({ username: 'doctor' }).first('id', 'password_hash', 'licence_number')).toEqual(
      src,
    );

    // Sequences moved past the restored rows, and triggers are back on.
    const restoredMax = Number((await target('audit_log').max({ m: 'id' }).first()).m);
    const [row] = await target('audit_log').insert({ action: 'create', entity_type: 'restore_check' }).returning('id');
    expect(Number(row.id)).toBe(restoredMax + 1);
    await expect(target('audit_log').where({ id: row.id }).delete()).rejects.toThrow(/append-only/);
  });
});
