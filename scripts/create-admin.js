#!/usr/bin/env node
// Create the first deployment administrator on a fresh (non-demo) installation.
//
//   npm run admin:create -- --username jdoe --name "Jane Doe"
//
// The password comes from ADMIN_PASSWORD, or a strong one is generated and printed once.
// The admin must change it at first sign-in.
import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import knex from 'knex';
import { checkPassword } from '../packages/shared/src/password-policy.js';
import { loadEnv } from './lib/env.js';

loadEnv();
const args = process.argv.slice(2);
const opt = (n) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? undefined : args[i + 1];
};
const username = opt('username')?.toLowerCase();
const fullName = opt('name');
if (!username || !/^[a-z0-9._-]{3,64}$/.test(username) || !fullName) {
  console.error('Usage: npm run admin:create -- --username <username> --name "<full name>"');
  process.exit(1);
}

const generated = !process.env.ADMIN_PASSWORD;
const password = process.env.ADMIN_PASSWORD ?? `${randomBytes(9).toString('base64url')}#A1z`;
const problems = checkPassword(password, { username });
if (problems.length) {
  console.error(`✗ ADMIN_PASSWORD does not meet the policy: ${problems.join(', ')}`);
  process.exit(1);
}

const url =
  process.env.EXTERNAL_DATABASE_URL ??
  process.env.DATABASE_URL ??
  `postgres://postgres:${encodeURIComponent(process.env.PG_PASSWORD ?? 'postgres')}@localhost:${process.env.PGPORT ?? 54329}/${process.env.PGDATABASE ?? 'afyazuri'}`;
const db = knex({ client: 'pg', connection: url });
try {
  const role = await db('roles').where({ code: 'super_admin' }).first('id');
  if (!role) throw new Error('Roles are not seeded. Start Afyazuri once (npm start) before creating an admin.');
  if (await db('users').where({ username }).first('id')) throw new Error(`User "${username}" already exists`);
  const hash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  await db.transaction(async (trx) => {
    const [u] = await trx('users')
      .insert({ username, full_name: fullName, password_hash: hash, must_change_password: true })
      .returning('id');
    await trx('user_roles').insert({ user_id: u.id, role_id: role.id, facility_id: null });
    await trx('audit_log').insert({
      action: 'create',
      entity_type: 'user',
      entity_id: u.id,
      actor_username: 'system:create-admin',
      metadata: JSON.stringify({ role: 'super_admin', via: 'scripts/create-admin.js' }),
    });
  });
  console.log(`✓ Created Super Admin "${username}".`);
  if (generated) console.log(`  Temporary password (shown once): ${password}`);
  console.log('  They must change it at first sign-in, then add the first facility under Facility setup.');
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
