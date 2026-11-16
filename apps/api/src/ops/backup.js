/**
 * Encrypted logical backups without pg_dump.
 *
 * The embedded PostgreSQL build has no pg_dump, so backups stream every table
 * in the public schema with COPY inside one REPEATABLE READ snapshot, then
 * gzip and encrypt with AES-256-GCM.
 *
 * File layout:  "AZB1" | 12-byte IV | ciphertext | 16-byte GCM tag
 * Plaintext:    manifest JSON line, then per table:
 *                 "@@TABLE <json {name, columns}>\n" + COPY text rows + "\.\n"
 * A COPY text row can never be exactly "\." (backslashes are escaped), so the
 * terminator is unambiguous.
 *
 * Restore recreates the schema with the app's migrations, then loads the rows
 * with triggers disabled (session_replication_role = replica, superuser only)
 * and resets sequences. The GCM tag is checked before anything is committed.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import pgCopy from 'pg-copy-streams';

const MAGIC = Buffer.from('AZB1');
const IV_LEN = 12;
const TAG_LEN = 16;
const END = '\\.';
const NAME_RE = /^[a-z_][a-z0-9_]*$/;
const FILE_RE = /^afyazuri-(\d{8})-(\d{6})\.azb$/;

/** @param {string} key base64 of 32 bytes */
function keyBuf(key) {
  const k = Buffer.from(key ?? '', 'base64');
  if (k.length !== 32) throw new Error('BACKUP_KEY must be base64 of exactly 32 bytes');
  return k;
}

const q = (/** @type {string} */ n) => {
  if (!NAME_RE.test(n)) throw new Error(`Unsafe identifier: ${n}`);
  return `"${n}"`;
};

/**
 * Tables and their copyable (non-generated) columns, in a stable order.
 * @param {import('pg').PoolClient} client
 */
async function listTables(client) {
  const { rows } = await client.query(`
    SELECT c.table_name, array_agg(c.column_name::text ORDER BY c.ordinal_position) AS columns
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.is_generated = 'NEVER'
    GROUP BY c.table_name ORDER BY c.table_name`);
  return rows.map((r) => ({ name: r.table_name, columns: r.columns }));
}

/** UTC timestamp used in file names: 20261116-013000 */
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/**
 * Write an encrypted backup of the database to `dir`.
 * @param {{db: import('knex').Knex, key: string, dir: string, now?: Date}} opts
 * @returns {Promise<{file: string, bytes: number, tables: number, rows: number}>}
 */
export async function createBackup({ db, key, dir, now = new Date() }) {
  const k = keyBuf(key);
  await fs.mkdir(dir, { recursive: true });
  const file = join(dir, `afyazuri-${stamp(now)}.azb`);
  const tmp = `${file}.partial`;
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  let rows = 0;
  let tableCount = 0;

  const client = await db.client.acquireConnection();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables = await listTables(client);
    tableCount = tables.length;
    const migrations = (await client.query('SELECT name FROM knex_migrations ORDER BY id')).rows.map((r) => r.name);
    const {
      rows: [info],
    } = await client.query('SELECT current_database() AS db, version() AS version');

    async function* plaintext() {
      const manifest = {
        format: 'afyazuri-backup',
        version: 1,
        createdAt: now.toISOString(),
        database: info.db,
        server: info.version,
        migrations,
        tables: tables.map((t) => t.name),
      };
      yield `${JSON.stringify(manifest)}\n`;
      for (const t of tables) {
        yield `@@TABLE ${JSON.stringify(t)}\n`;
        const sql = `COPY ${q(t.name)} (${t.columns.map(q).join(', ')}) TO STDOUT`;
        for await (const chunk of client.query(pgCopy.to(sql))) {
          for (const b of chunk) if (b === 10) rows += 1;
          yield chunk;
        }
        yield `${END}\n`;
      }
    }

    await fs.writeFile(tmp, Buffer.concat([MAGIC, iv]));
    await pipeline(
      Readable.from(plaintext()),
      createGzip({ level: 6 }),
      cipher,
      createWriteStream(tmp, { flags: 'a' }),
    );
    await fs.appendFile(tmp, cipher.getAuthTag());
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    await fs.rm(tmp, { force: true });
    throw err;
  } finally {
    db.client.releaseConnection(client);
  }
  await fs.rename(tmp, file);
  const { size } = await fs.stat(file);
  return { file, bytes: size, tables: tableCount, rows };
}

/**
 * Open a backup and yield its decrypted plaintext lines. The returned `done`
 * promise rejects if the file was tampered with or the key is wrong; callers
 * must await it before trusting what they read.
 * @param {string} file @param {string} key
 */
async function openBackup(file, key) {
  const k = keyBuf(key);
  const { size } = await fs.stat(file);
  if (size < MAGIC.length + IV_LEN + TAG_LEN) throw new Error('Backup file is truncated');
  const fh = await fs.open(file, 'r');
  const head = Buffer.alloc(MAGIC.length + IV_LEN);
  const tag = Buffer.alloc(TAG_LEN);
  await fh.read(head, 0, head.length, 0);
  await fh.read(tag, 0, TAG_LEN, size - TAG_LEN);
  await fh.close();
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not an Afyazuri backup file');

  const decipher = createDecipheriv('aes-256-gcm', k, head.subarray(MAGIC.length));
  decipher.setAuthTag(tag);
  const gunzip = createGunzip();
  const done = pipeline(createReadStream(file, { start: head.length, end: size - TAG_LEN - 1 }), decipher, gunzip);
  done.catch(() => {}); // surfaced via `done` to the caller
  const rl = createInterface({ input: gunzip, crlfDelay: Infinity });
  // Create the iterator now: readline emits lines as soon as data flows, and
  // lines emitted before anyone iterates would otherwise be lost.
  const iter = rl[Symbol.asyncIterator]();
  return { lines: { [Symbol.asyncIterator]: () => iter }, done };
}

/**
 * Parse a backup's plaintext stream, calling `onTable` for each table with an
 * async iterator of its COPY rows.
 * @param {AsyncIterable<string>} lines
 * @param {(t: {name: string, columns: string[]}, rows: AsyncGenerator<string>) => Promise<void>} onTable
 */
async function walk(lines, onTable) {
  const it = lines[Symbol.asyncIterator]();
  const first = await it.next();
  if (first.done) throw new Error('Backup is empty');
  const manifest = JSON.parse(first.value);
  if (manifest.format !== 'afyazuri-backup') throw new Error('Unknown backup format');
  for (;;) {
    const h = await it.next();
    if (h.done) break;
    if (!h.value.startsWith('@@TABLE ')) throw new Error('Corrupt backup: expected a table header');
    const table = JSON.parse(h.value.slice(8));
    let finished = false;
    async function* rows() {
      for (;;) {
        const r = await it.next();
        if (r.done) throw new Error(`Corrupt backup: table ${table.name} not terminated`);
        if (r.value === END) {
          finished = true;
          return;
        }
        yield r.value;
      }
    }
    await onTable(table, rows());
    if (!finished) for await (const _ of rows()); // drain if the consumer stopped early
  }
  return manifest;
}

/** @param {Error} err */
function decryptError(err) {
  throw new Error(`Backup failed integrity check (wrong BACKUP_KEY or the file was altered): ${err.message}`);
}

/**
 * Fully decrypt and parse a backup without touching any database.
 * @param {string} file @param {string} key
 * @returns {Promise<{manifest: any, counts: Record<string, number>}>}
 */
export async function verifyBackup(file, key) {
  const { lines, done } = await openBackup(file, key);
  const counts = {};
  let manifest;
  try {
    manifest = await walk(lines, async (t, rows) => {
      let n = 0;
      for await (const _ of rows) n += 1;
      counts[t.name] = n;
    });
  } catch (err) {
    await done.catch(decryptError); // a decryption failure explains the parse error
    throw err;
  }
  await done.catch(decryptError); // bad tag = tampered file or wrong key
  return { manifest, counts };
}

/**
 * Restore a backup into the database `db` points at. DESTRUCTIVE: the public
 * schema is dropped and rebuilt. The file is verified first, so a corrupt or
 * tampered backup never reaches the destructive step.
 * @param {{db: import('knex').Knex, file: string, key: string, migrationsDir: string}} opts
 */
export async function restoreBackup({ db, file, key, migrationsDir, onProgress = () => {} }) {
  const { manifest } = await verifyBackup(file, key);

  await db.raw('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await db.migrate.latest({ directory: migrationsDir, loadExtensions: ['.js'] });
  const applied = await db('knex_migrations').orderBy('id').pluck('name');
  if (JSON.stringify(applied) !== JSON.stringify(manifest.migrations))
    throw new Error(
      'Migration mismatch: restore with the same Afyazuri version that made the backup, then upgrade. ' +
        `Backup has ${manifest.migrations.length} migrations, this version has ${applied.length}.`,
    );

  const { lines, done } = await openBackup(file, key);
  const client = await db.client.acquireConnection();
  const counts = {};
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    const tables = await listTables(client);
    await client.query(`TRUNCATE ${tables.map((t) => q(t.name)).join(', ')} RESTART IDENTITY CASCADE`);

    await walk(lines, async (t, rows) => {
      onProgress(t.name);
      const sql = `COPY ${q(t.name)} (${t.columns.map(q).join(', ')}) FROM STDIN`;
      const sink = client.query(pgCopy.from(sql));
      let failure = null;
      sink.on('error', (e) => {
        failure = e;
      });
      const finished = new Promise((ok, fail) => {
        sink.once('finish', ok);
        sink.once('error', fail);
      });
      finished.catch(() => {});
      // Wait for buffer space, but give up as soon as the server rejects the COPY.
      const drained = () =>
        new Promise((ok, fail) => {
          if (failure) return fail(failure);
          const onDrain = () => {
            sink.off('error', onErr);
            ok();
          };
          const onErr = (e) => {
            sink.off('drain', onDrain);
            fail(e);
          };
          sink.once('drain', onDrain);
          sink.once('error', onErr);
        });
      let n = 0;
      let buf = '';
      for await (const row of rows) {
        n += 1;
        buf += `${row}\n`;
        if (buf.length > 1 << 16) {
          if (!sink.write(buf)) await drained();
          buf = '';
        }
      }
      if (failure) throw failure;
      sink.end(buf);
      await finished.catch((e) => {
        throw new Error(`Restoring table ${t.name} failed: ${e.message}`);
      });
      counts[t.name] = n;
    }).catch(async (err) => {
      await done.catch(decryptError);
      throw err;
    });
    await done.catch(decryptError);

    // Move every owned sequence past the restored rows.
    const { rows: seqs } = await client.query(`
      SELECT s.relname AS seq, t.relname AS tbl, a.attname AS col
      FROM pg_class s
      JOIN pg_depend d ON d.objid = s.oid AND d.deptype IN ('a', 'i')
      JOIN pg_class t ON t.oid = d.refobjid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
      WHERE s.relkind = 'S' AND t.relnamespace = 'public'::regnamespace`);
    for (const s of seqs)
      await client.query(
        `SELECT setval('public.${s.seq}', COALESCE((SELECT max(${q(s.col)}) FROM ${q(s.tbl)}), 1), (SELECT max(${q(s.col)}) FROM ${q(s.tbl)}) IS NOT NULL)`,
      );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.client.releaseConnection(client);
  }
  return { manifest, counts };
}

/**
 * Grandfather-father-son retention: keep the newest backup of each of the
 * last `daily` days, `weekly` ISO weeks and `monthly` months.
 * @param {string[]} files file names (or paths)
 * @param {{daily?: number, weekly?: number, monthly?: number}} [policy]
 * @returns {{keep: string[], remove: string[]}}
 */
export function selectRetention(files, policy = {}) {
  const { daily = 7, weekly = 4, monthly = 12 } = policy;
  const parsed = files
    .map((f) => {
      const m = FILE_RE.exec(basename(f));
      if (!m) return null;
      const [, d, t] = m;
      const date = new Date(
        `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`,
      );
      return { f, date };
    })
    .filter(Boolean)
    .sort((a, b) => b.date - a.date);

  const isoWeek = (d) => {
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = x.getUTCDay() || 7;
    x.setUTCDate(x.getUTCDate() + 4 - day);
    const y0 = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
    return `${x.getUTCFullYear()}-W${Math.ceil(((x - y0) / 86400000 + 1) / 7)}`;
  };
  const keep = new Set();
  const bucket = (keyOf, limit) => {
    const seen = new Set();
    for (const p of parsed) {
      const k = keyOf(p.date);
      if (seen.has(k)) continue;
      if (seen.size >= limit) break;
      seen.add(k);
      keep.add(p.f);
    }
  };
  bucket((d) => d.toISOString().slice(0, 10), daily);
  bucket(isoWeek, weekly);
  bucket((d) => d.toISOString().slice(0, 7), monthly);
  return {
    keep: parsed.filter((p) => keep.has(p.f)).map((p) => p.f),
    remove: parsed.filter((p) => !keep.has(p.f)).map((p) => p.f),
  };
}

/**
 * Delete backups in `dir` that fall outside the retention policy.
 * @param {string} dir @param {{daily?: number, weekly?: number, monthly?: number}} [policy]
 */
export async function pruneBackups(dir, policy) {
  const names = (await fs.readdir(dir)).filter((n) => FILE_RE.test(n));
  const { remove } = selectRetention(names, policy);
  for (const n of remove) await fs.rm(join(dir, n));
  return remove;
}
