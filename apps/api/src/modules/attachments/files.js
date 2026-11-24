// Attachment files: stored encrypted (AES-256-GCM) under ATTACHMENTS_DIR with random names, so
// a copied disk or backup reveals nothing, and a file name from a user can never pick the path.
// The file type is decided from the bytes, not from what the client claims.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from '../../lib/errors.js';

/** Allowed types and their magic numbers. */
const TYPES = [
  { mime: 'application/pdf', ext: 'pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  {
    mime: 'image/png',
    ext: 'png',
    test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
];

/** What the bytes really are, or null. @param {Buffer} buf */
export const sniff = (buf) => TYPES.find((t) => t.test(buf)) ?? null;

/** A display name safe to store and to send back in Content-Disposition. */
export const safeName = (name, ext) => {
  const base = String(name ?? '')
    .split(/[\\/]/)
    .pop()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} ._()-]/gu, '_')
    .replace(/^[.\s]+/, '')
    .slice(0, 100);
  return base ? (base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`) : `attachment.${ext}`;
};

/**
 * Validate, encrypt and write a file; insert its attachments row (in the caller's transaction).
 * @param {import('knex').Knex.Transaction} trx
 * @param {{config: any, crypto: import('../../lib/crypto.js').FieldCrypto}} deps
 * @param {{facilityId: string, patientId: string, encounterId?: string|null, category: string, fileName?: string,
 *          buffer: Buffer, userId: string, sourceType: string, sourceId: string}} a
 */
export async function saveAttachment(trx, deps, a) {
  const max = deps.config.ATTACHMENT_MAX_MB * 1024 * 1024;
  if (!a.buffer?.length) throw new AppError(400, 'EMPTY_FILE', 'The file is empty');
  if (a.buffer.length > max)
    throw new AppError(413, 'FILE_TOO_LARGE', `Files can be at most ${deps.config.ATTACHMENT_MAX_MB} MB`);
  const type = sniff(a.buffer);
  if (!type) throw new AppError(415, 'UNSUPPORTED_FILE', 'Only PDF, PNG and JPEG files can be attached');
  const key = `${randomUUID()}.azf`;
  await mkdir(deps.config.ATTACHMENTS_DIR, { recursive: true });
  await writeFile(join(deps.config.ATTACHMENTS_DIR, key), deps.crypto.encryptBuffer(a.buffer), { flag: 'wx' });
  const [row] = await trx('attachments')
    .insert({
      facility_id: a.facilityId,
      patient_id: a.patientId,
      encounter_id: a.encounterId ?? null,
      category: a.category,
      file_name: safeName(a.fileName, type.ext),
      mime_type: type.mime,
      size_bytes: a.buffer.length,
      storage_key: key,
      sha256: createHash('sha256').update(a.buffer).digest('hex'),
      uploaded_by: a.userId,
      source_type: a.sourceType,
      source_id: a.sourceId,
    })
    .returning('*');
  return row;
}

/** Read and decrypt a stored file, checking it is the file that was uploaded. */
export async function readAttachment(deps, row) {
  if (!/^[0-9a-f-]{36}\.azf$/.test(row.storage_key)) throw new Error('Bad storage key');
  const plain = deps.crypto.decryptBuffer(await readFile(join(deps.config.ATTACHMENTS_DIR, row.storage_key)));
  if (createHash('sha256').update(plain).digest('hex') !== row.sha256)
    throw new Error('Attachment integrity check failed');
  return plain;
}

export const toAttachment = (a) => ({
  id: a.id,
  fileName: a.file_name,
  mimeType: a.mime_type,
  sizeBytes: Number(a.size_bytes),
  category: a.category,
  uploadedBy: a.uploaded_by_name ?? null,
  uploadedAt: a.created_at,
});
