import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * Field-level encryption (AES-256-GCM) and blind indexing (HMAC-SHA256) for
 * sensitive values such as phone numbers and national IDs. Keys come from the
 * environment only. Ciphertext format: `v1:<base64(iv | tag | ciphertext)>` —
 * the version prefix allows key rotation later.
 */
export class FieldCrypto {
  /** @param {{encryptionKey: string, blindIndexKey: string}} keys base64-encoded 32-byte keys */
  constructor({ encryptionKey, blindIndexKey }) {
    this.key = Buffer.from(encryptionKey, 'base64');
    this.indexKey = Buffer.from(blindIndexKey, 'base64');
    if (this.key.length !== 32 || this.indexKey.length !== 32) throw new Error('Keys must be 32 bytes');
  }

  /** @param {string|null|undefined} plaintext */
  encrypt(plaintext) {
    if (plaintext === null || plaintext === undefined) return null;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    return `v1:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')}`;
  }

  /** @param {string|null|undefined} payload */
  decrypt(payload) {
    if (payload === null || payload === undefined) return null;
    if (!payload.startsWith('v1:')) throw new Error('Unknown ciphertext version');
    const buf = Buffer.from(payload.slice(3), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  }

  /**
   * Encrypt a whole file (attachments at rest). Layout: "AZF1" | iv(12) | tag(16) | ciphertext.
   * @param {Buffer} data
   */
  encryptBuffer(data) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([Buffer.from('AZF1'), iv, cipher.getAuthTag(), ct]);
  }

  /** @param {Buffer} blob from encryptBuffer; throws if it was tampered with */
  decryptBuffer(blob) {
    if (blob.subarray(0, 4).toString() !== 'AZF1') throw new Error('Unknown file format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, blob.subarray(4, 16));
    decipher.setAuthTag(blob.subarray(16, 32));
    return Buffer.concat([decipher.update(blob.subarray(32)), decipher.final()]);
  }

  /**
   * Deterministic keyed hash for exact-match lookup of an encrypted value.
   * Values are normalised (trimmed, upper-cased, internal spaces/dashes removed)
   * and namespaced by type so equal strings of different kinds don't collide.
   * @param {string} type e.g. 'phone', 'national_id'
   * @param {string|null|undefined} value
   */
  blindIndex(type, value) {
    if (value === null || value === undefined || value === '') return null;
    const norm = String(value).trim().toUpperCase().replace(/[\s-]/g, '');
    return createHmac('sha256', this.indexKey).update(`${type}:${norm}`).digest('hex');
  }
}

/** SHA-256 hex digest, used to store refresh tokens and idempotency request fingerprints. */
export const sha256 = (/** @type {string} */ v) => createHash('sha256').update(v).digest('hex');

/** URL-safe random token. */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
