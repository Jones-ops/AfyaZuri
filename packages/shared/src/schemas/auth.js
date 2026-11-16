import { z } from 'zod';

export const loginBody = z.object({
  username: z.string().trim().toLowerCase().min(3).max(64),
  password: z.string().min(1).max(256),
  totp: z.string().regex(/^\d{6}$/).optional(),
  facilityId: z.string().uuid().optional(),
});

export const switchFacilityBody = z.object({ facilityId: z.string().uuid() });

export const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(10).max(256),
});

export const totpVerifyBody = z.object({ code: z.string().regex(/^\d{6}$/) });
