import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { FieldCrypto } from '../../src/lib/crypto.js';
import { diff, redact } from '../../src/lib/diff.js';
import { decodeCursor, encodeCursor, page } from '../../src/lib/http.js';

const crypto = new FieldCrypto({
  encryptionKey: randomBytes(32).toString('base64'),
  blindIndexKey: randomBytes(32).toString('base64'),
});

describe('FieldCrypto', () => {
  it('round-trips values with a random IV', () => {
    const a = crypto.encrypt('+254712345678');
    const b = crypto.encrypt('+254712345678');
    expect(a).not.toBe(b);
    expect(a.startsWith('v1:')).toBe(true);
    expect(crypto.decrypt(a)).toBe('+254712345678');
  });

  it('detects tampering', () => {
    const c = crypto.encrypt('12345678');
    const buf = Buffer.from(c.slice(3), 'base64');
    buf[buf.length - 1] ^= 1;
    expect(() => crypto.decrypt(`v1:${buf.toString('base64')}`)).toThrow();
  });

  it('builds normalised, type-namespaced blind indexes', () => {
    expect(crypto.blindIndex('national_id', ' 1234-5678 ')).toBe(crypto.blindIndex('national_id', '12345678'));
    expect(crypto.blindIndex('national_id', '12345678')).not.toBe(crypto.blindIndex('passport', '12345678'));
    expect(crypto.blindIndex('phone', null)).toBeNull();
  });

  it('passes null through', () => {
    expect(crypto.encrypt(null)).toBeNull();
    expect(crypto.decrypt(null)).toBeNull();
  });
});

describe('audit diff', () => {
  it('reports changed fields and ignores updated_at', () => {
    const before = { name: 'A', code: 'X', updated_at: new Date(1) };
    const after = { name: 'B', code: 'X', updated_at: new Date(2) };
    expect(diff(before, after)).toEqual({ name: { from: 'A', to: 'B' } });
  });

  it('never exposes secrets', () => {
    expect(redact({ password_hash: 'abc', totp_secret_enc: null, name: 'x' })).toEqual({
      password_hash: '[redacted]',
      totp_secret_enc: null,
      name: 'x',
    });
    // Both sides redact to the same placeholder, so a password change leaks nothing.
    expect(diff({ password_hash: 'a' }, { password_hash: 'b' })).toBeNull();
  });
});

describe('cursor pagination', () => {
  it('round-trips and pages', () => {
    const c = encodeCursor({ id: 5 });
    expect(decodeCursor(c)).toEqual({ id: 5 });
    const p = page([1, 2, 3], 2, (x) => ({ id: x }));
    expect(p.data).toEqual([1, 2]);
    expect(decodeCursor(p.nextCursor)).toEqual({ id: 2 });
    expect(page([1], 2, (x) => ({ id: x })).nextCursor).toBeNull();
  });

  it('rejects garbage cursors', () => expect(() => decodeCursor('%%%')).toThrow('Invalid cursor'));
});

describe('config', () => {
  const env = {
    JWT_SECRET: 'x'.repeat(40),
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    BLIND_INDEX_KEY: randomBytes(32).toString('base64'),
  };
  it('applies defaults', () => {
    const c = loadConfig(env);
    expect(c.SESSION_IDLE_MINUTES).toBe(15);
    expect(c.cookieSecure).toBe(false);
    expect(loadConfig({ ...env, NODE_ENV: 'production' }).cookieSecure).toBe(true);
  });
  it('explains missing secrets', () => {
    expect(() => loadConfig({})).toThrow(/JWT_SECRET[\s\S]*ENCRYPTION_KEY/);
  });
  it('rejects short keys', () => {
    expect(() => loadConfig({ ...env, ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrow(/32 bytes/);
  });
});
