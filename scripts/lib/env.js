// Repository root and .env loading, without pulling in the database tooling.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(import.meta.url), '../../..');

/** Load ROOT/.env into process.env (existing variables win). */
export function loadEnv() {
  const f = join(ROOT, '.env');
  if (existsSync(f)) process.loadEnvFile(f);
}
