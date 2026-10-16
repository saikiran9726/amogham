import { z } from 'zod';
import { Roles } from '../permissions/index.js';

export const roleNameSchema = z.enum([
  Roles.OWNER,
  Roles.WAITER,
  Roles.KITCHEN,
  Roles.MANAGER,
  Roles.CASHIER,
]);

export const loginPasswordSchema = z.object({
  username: z.string().trim().min(1, 'Username is required').max(50),
  password: z.string().min(1, 'Password is required'),
  deviceLabel: z.string().trim().max(100).optional(),
});

export const loginPinSchema = z.object({
  username: z.string().trim().min(1, 'Username is required').max(50),
  pin: z.string().regex(/^\d{4,6}$/, 'PIN must be 4 to 6 digits'),
  deviceLabel: z.string().trim().max(100).optional(),
});

export const loginRequestSchema = z
  .object({
    username: z.string().trim().min(1, 'Username is required').max(50),
    credentialType: z.enum(['password', 'pin']).default('password'),
    password: z.string().optional(),
    pin: z.string().optional(),
    deviceLabel: z.string().trim().max(100).optional(),
  })
  .refine(
    (data) => {
      if (data.credentialType === 'password') {
        return !!data.password && data.password.length > 0;
      }
      return !!data.pin && /^\d{4,6}$/.test(data.pin);
    },
    {
      message: 'Valid password or 4-6 digit PIN is required based on credential type',
      path: ['password'],
    },
  );

export const userProfileSchema = z.object({
  id: z.string().uuid(),
  restaurantId: z.string().uuid(),
  name: z.string(),
  username: z.string(),
  role: z.string(),
  active: z.boolean(),
  permissions: z.array(z.string()),
  lastLoginAt: z.coerce.date().nullable().optional(),
});

export const authResponseSchema = z.object({
  user: userProfileSchema,
  accessToken: z.string(),
});

export function isDenylistedPin(pin: string): boolean {
  if (!/^\d{4,6}$/.test(pin)) {
    return false;
  }

  // All identical digits: e.g. 0000, 1111, 8888, 999999
  if (pin.split('').every((c) => c === pin[0])) {
    return true;
  }

  // Sequential ascending: e.g. 1234, 2345, 0123, 12345, 123456
  const isAscending = pin
    .split('')
    .every((c, i, arr) => i === 0 || Number(c) === Number(arr[i - 1]) + 1);
  if (isAscending) {
    return true;
  }

  // Sequential descending: e.g. 4321, 5432, 9876, 654321
  const isDescending = pin
    .split('')
    .every((c, i, arr) => i === 0 || Number(c) === Number(arr[i - 1]) - 1);
  if (isDescending) {
    return true;
  }

  // Repeated 2-digit patterns: e.g. 1212, 3434, 121212
  if (pin.length % 2 === 0) {
    const pair = pin.slice(0, 2);
    if (pair.repeat(pin.length / 2) === pin) {
      return true;
    }
  }

  const commonWeakPins = new Set([
    '1234',
    '4321',
    '0000',
    '1111',
    '2222',
    '3333',
    '4444',
    '5555',
    '6666',
    '7777',
    '8888',
    '9999',
    '1212',
    '12345',
    '54321',
    '123456',
    '654321',
    '000000',
    '111111',
    '123123',
    '112233',
  ]);

  return commonWeakPins.has(pin);
}

export const pinSchema = z
  .string()
  .regex(/^\d{4,6}$/, 'PIN must be 4 to 6 digits')
  .refine((pin) => !isDenylistedPin(pin), {
    message: 'PIN is too weak (sequential or repeated digits are not allowed)',
  });

export const staffCreateSchema = z
  .object({
    name: z.string().trim().min(1, 'Staff name is required').max(100),
    username: z
      .string()
      .trim()
      .min(3, 'Username must be at least 3 characters')
      .max(30)
      .regex(/^[a-zA-Z0-9_.-]+$/, 'Username can only contain letters, numbers, dots, and hyphens'),
    role: roleNameSchema,
    credentialType: z.enum(['password', 'pin']),
    password: z.string().min(10, 'Password must be at least 10 characters').optional(),
    pin: pinSchema.optional(),
  })
  .refine(
    (data) => {
      if (data.credentialType === 'password') {
        return !!data.password && data.password.length >= 10;
      }
      return !!data.pin && !isDenylistedPin(data.pin);
    },
    {
      message:
        'Password (min 10 chars) or valid PIN (4-6 digits, not sequential/repeated) must be provided',
      path: ['password'],
    },
  );

export const staffUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  role: roleNameSchema.optional(),
  active: z.boolean().optional(),
});

export const staffResetCredentialSchema = z
  .object({
    credentialType: z.enum(['password', 'pin']),
    password: z.string().min(10, 'Password must be at least 10 characters').optional(),
    pin: pinSchema.optional(),
  })
  .refine(
    (data) => {
      if (data.credentialType === 'password') {
        return !data.password || data.password.length >= 10;
      }
      return !data.pin || (!isDenylistedPin(data.pin) && /^\d{4,6}$/.test(data.pin));
    },
    {
      message: 'Password must be at least 10 characters or valid PIN must be 4-6 digits',
      path: ['password'],
    },
  );

export const auditLogQuerySchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  userId: z.string().uuid().optional(),
  action: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
  offset: z.coerce.number().min(0).default(0),
});

export type LoginPasswordInput = z.infer<typeof loginPasswordSchema>;
export type LoginPinInput = z.infer<typeof loginPinSchema>;
export type LoginRequestInput = z.infer<typeof loginRequestSchema>;
export type UserProfile = z.infer<typeof userProfileSchema>;
export type AuthResponse = z.infer<typeof authResponseSchema>;
export type StaffCreateInput = z.infer<typeof staffCreateSchema>;
export type StaffUpdateInput = z.infer<typeof staffUpdateSchema>;
export type StaffResetCredentialInput = z.infer<typeof staffResetCredentialSchema>;
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;
