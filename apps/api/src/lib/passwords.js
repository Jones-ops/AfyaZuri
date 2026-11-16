import argon2 from 'argon2';

// OWASP-recommended Argon2id parameters (19 MiB, 2 iterations, 1 lane).
const OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

/** @param {string} password */
export const hashPassword = (password) => argon2.hash(password, OPTIONS);

/** @param {string} hash @param {string} password */
export async function verifyPassword(hash, password) {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

let dummyHash;
/**
 * Spend the same time as a real verification when the username is unknown,
 * so response timing doesn't reveal which usernames exist.
 * @param {string} password
 */
export async function burnVerify(password) {
  dummyHash ??= await hashPassword('not-a-real-password-#1');
  await verifyPassword(dummyHash, password);
  return false;
}
