import { z } from 'zod';

export const uuid = z.string().uuid();

/** Kenyan phone, normalised to +2547XXXXXXXX / +2541XXXXXXXX. */
export const kenyanPhone = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .transform((v) => (v.startsWith('0') ? `+254${v.slice(1)}` : v.startsWith('254') ? `+${v}` : v))
  .refine((v) => /^\+254[17]\d{8}$/.test(v), 'Enter a Kenyan phone number, e.g. 0712 345 678');

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});

export const idParams = z.object({ id: uuid });
