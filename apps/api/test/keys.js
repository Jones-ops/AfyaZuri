// Fixed, test-only keys. Shared by the database seed (global setup) and the app under
// test, so demo patients encrypted at seed time decrypt in the tests. Never use in production.
export const TEST_KEYS = {
  JWT_SECRET: 'test-only-jwt-secret-0123456789abcdef0123456789abcdef',
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  BLIND_INDEX_KEY: Buffer.alloc(32, 9).toString('base64'),
};
