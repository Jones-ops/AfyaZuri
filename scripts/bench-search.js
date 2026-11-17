#!/usr/bin/env node
// Patient-search benchmark: loads N synthetic patients (default 500 000) into a throwaway
// embedded PostgreSQL and times the real search service for each kind of query.
//
//   npm run bench:search            # 500 000 patients
//   npm run bench:search -- 100000  # smaller run
//
// Target (build prompt §6.1): under 300 ms per search at 500 000 patients.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import knex from 'knex';
import { FieldCrypto } from '../apps/api/src/lib/crypto.js';
import { loadGrants } from '../apps/api/src/modules/auth/repository.js';
import { searchPatients } from '../apps/api/src/modules/patients/service.js';
import { ensureDatabase, migrateAndSeed, startCluster } from './lib/pg.js';

const N = Number(process.argv[2] ?? 500_000);
const RUNS = 25;
const TARGET_MS = 300;

const keys = {
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  BLIND_INDEX_KEY: randomBytes(32).toString('base64'),
};
Object.assign(process.env, keys, { NODE_ENV: 'development' });
const crypto = new FieldCrypto({ encryptionKey: keys.ENCRYPTION_KEY, blindIndexKey: keys.BLIND_INDEX_KEY });

const dir = mkdtempSync(join(tmpdir(), 'afyazuri-bench-'));
const port = 56000 + Math.floor(Math.random() * 1000);
const pg = await startCluster({ dataDir: dir, port, password: 'postgres', persistent: false });
await ensureDatabase(pg, 'bench');
const url = `postgres://postgres:postgres@localhost:${port}/bench`;
await migrateAndSeed(url, { demo: true, log: () => {} });
const db = knex({ client: 'pg', connection: url, pool: { min: 1, max: 4 } });

const t0 = Date.now();
const facility = await db('facilities').where({ kmhfl_code: '99001' }).first('id', 'kmhfl_code');
const first = [
  'Akinyi',
  'Atieno',
  'Achieng',
  'Wanjiru',
  'Wambui',
  'Njeri',
  'Chebet',
  'Mwende',
  'Kerubo',
  'Halima',
  'Faith',
  'Grace',
  'Otieno',
  'Ochieng',
  'Omondi',
  'Kamau',
  'Mwangi',
  'Njoroge',
  'Kiprop',
  'Mutua',
  'Wekesa',
  'Juma',
  'Brian',
  'Kevin',
  'Peter',
  'James',
];
const last = [
  'Odhiambo',
  'Otieno',
  'Onyango',
  'Owino',
  'Okoth',
  'Ouma',
  'Kamau',
  'Mwangi',
  'Njoroge',
  'Kariuki',
  'Kimani',
  'Kiprotich',
  'Rotich',
  'Koech',
  'Mutua',
  'Musyoka',
  'Wafula',
  'Barasa',
  'Simiyu',
  'Mohamed',
  'Abdi',
  'Wanyama',
  'Gitau',
];
const arr = (a) => `ARRAY[${a.map((x) => `'${x}'`).join(',')}]`;
await db.transaction(async (trx) => {
  // Bulk load without the per-row change-capture triggers (benchmark data only).
  await trx.raw('SET LOCAL session_replication_role = replica');
  await trx.raw(
    `INSERT INTO patients (facility_id, mrn, first_name, middle_name, last_name, sex, date_of_birth, phone_hash)
   SELECT ?, ? || '-2025-' || lpad(g::text, 7, '0'),
     (${arr(first)})[1 + (g * 7) % ${first.length}],
     CASE WHEN g % 3 = 0 THEN (${arr(first)})[1 + (g * 13) % ${first.length}] END,
     (${arr(last)})[1 + (g * 11) % ${last.length}],
     CASE WHEN g % 2 = 0 THEN 'female' ELSE 'male' END,
     date '1940-01-01' + (g % 30000),
     encode(hmac(convert_to('phone:+2547' || lpad((g * 37 % 100000000)::text, 8, '0'), 'UTF8'), decode(?, 'base64'), 'sha256'), 'hex')
   FROM generate_series(1, ?) g`,
    [facility.id, facility.kmhfl_code, keys.BLIND_INDEX_KEY, N],
  );
  await trx.raw(
    `INSERT INTO patient_identifiers (facility_id, patient_id, type, value_enc, value_hash, value_last4)
   SELECT p.facility_id, p.id, 'national_id', 'v1:bench', encode(hmac(convert_to('id:' || (30000000 + s.n)::text, 'UTF8'), decode(?, 'base64'), 'sha256'), 'hex'), right((30000000 + s.n)::text, 4)
   FROM (SELECT id, facility_id, row_number() OVER (ORDER BY mrn) AS n FROM patients WHERE mrn LIKE '%-2025-%') s JOIN patients p ON p.id = s.id`,
    [keys.BLIND_INDEX_KEY],
  );
});
await db.raw('ANALYZE');
console.log(`Loaded ${N.toLocaleString()} patients in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const clerk = await db('users').where({ username: 'records' }).first('id', 'username');
const auth = {
  userId: clerk.id,
  username: 'records',
  roles: ['records_clerk'],
  facilityId: facility.id,
  grants: await loadGrants(db, clerk.id),
  fullName: 'bench',
};
const deps = { db, crypto };
const mid = Math.floor(N / 2);
const queries = {
  'MRN (exact)': `${facility.kmhfl_code}-2025-${String(mid).padStart(7, '0')}`,
  'Phone (blind index)': `07${String((mid * 37) % 100000000).padStart(8, '0')}`,
  'National ID (blind index)': String(30000000 + mid),
  'Name, two words': 'akinyi odhiambo',
  'Name, partial': 'wanj kari',
  'Name, one word': 'kiprotich',
  'Name, typo': 'otieno onyngo',
};

let failed = false;
console.log(`\n${'Query'.padEnd(28)} ${'hits'.padStart(5)}  ${'p50 ms'.padStart(7)}  ${'p95 ms'.padStart(7)}`);
for (const [label, q] of Object.entries(queries)) {
  const times = [];
  let hits = 0;
  for (let i = 0; i < RUNS; i++) {
    const s = process.hrtime.bigint();
    const r = await searchPatients(deps, auth, { q, limit: 20 });
    times.push(Number(process.hrtime.bigint() - s) / 1e6);
    hits = r.data.length;
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(RUNS * 0.5)];
  const p95 = times[Math.floor(RUNS * 0.95)];
  if (p95 > TARGET_MS) failed = true;
  console.log(
    `${label.padEnd(28)} ${String(hits).padStart(5)}  ${p50.toFixed(1).padStart(7)}  ${p95.toFixed(1).padStart(7)}${p95 > TARGET_MS ? '  ✗ over target' : ''}`,
  );
}
console.log(
  failed
    ? `\n✗ Some searches exceeded ${TARGET_MS} ms at p95`
    : `\n✓ All searches under ${TARGET_MS} ms at p95 with ${N.toLocaleString()} patients`,
);

await db.destroy();
await pg.stop();
rmSync(dir, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
