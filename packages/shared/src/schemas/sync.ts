import { z } from 'zod';

export const syncOrderModifierSchema = z.object({
  name: z.string().trim().max(50),
  priceDeltaPaise: z.number().int().nonnegative().max(1_000_000_000).optional(),
});

export const syncOrderItemSchema = z.object({
  itemId: z.string().uuid('Valid item UUID required'),
  name: z.string().trim().max(100).optional(),
  nameSnapshot: z.string().trim().max(100).optional(),
  pricePaise: z.number().int().nonnegative().max(1_000_000_000).optional(),
  pricePaiseSnapshot: z.number().int().nonnegative().max(1_000_000_000).optional(),
  taxRateBp: z.number().int().nonnegative().max(10000).optional(),
  taxRateBpSnapshot: z.number().int().nonnegative().max(10000).optional(),
  qty: z.number().int().positive('Item quantity must be positive').max(100),
  modifiers: z.array(syncOrderModifierSchema).max(20).optional().default([]),
  note: z.string().trim().max(200).nullable().optional(),
});

export const orderCreateCommandPayloadSchema = z.object({
  id: z.string().uuid('Valid order UUID required'),
  tableId: z.string().uuid().nullable().optional(),
  customerId: z.string().uuid().nullable().optional(),
  type: z.enum(['dine_in', 'takeaway', 'delivery']).default('dine_in'),
  guests: z.number().int().min(1).max(100).default(2),
  specialInstructions: z.string().trim().max(500).nullable().optional(),
  items: z.array(syncOrderItemSchema).max(100, 'Items per order must be at most 100').default([]),
  subtotalPaise: z.number().int().nonnegative().max(1_000_000_000).optional(),
  taxPaise: z.number().int().nonnegative().max(1_000_000_000).optional(),
  totalPaise: z.number().int().nonnegative().max(1_000_000_000).optional(),
  version: z.number().int().nonnegative().optional(),
});

export const kotStatusCommandPayloadSchema = z.object({
  kotId: z.string().uuid('Valid KOT UUID required'),
  status: z.enum(['new', 'preparing', 'ready', 'served']),
});

export const paymentRecordCommandPayloadSchema = z.object({
  billId: z.string().uuid('Valid bill UUID required'),
  amountPaise: z
    .number()
    .int('Amount must be an integer paise')
    .positive('Payment amount must be positive')
    .max(1_000_000_000, 'Payment amount exceeds maximum allowed cap'),
  tenderedPaise: z
    .number()
    .int('Tendered amount must be an integer paise')
    .positive('Tendered amount must be positive')
    .max(1_000_000_000)
    .optional(),
  method: z.enum(['cash', 'upi', 'card']),
  reference: z.string().trim().max(100).optional(),
});

export const syncOrderCreateCommandSchema = z.object({
  id: z.string().trim().min(1, 'Command ID required').max(128),
  idempotencyKey: z.string().trim().min(1, 'Idempotency key required').max(128),
  deviceId: z.string().trim().min(1, 'Device ID required').max(128),
  claimedAt: z.string().nullable().optional(),
  baseVersion: z.number().int().nonnegative().nullable().optional(),
  type: z.literal('order.create'),
  payload: orderCreateCommandPayloadSchema,
});

export const syncKotStatusCommandSchema = z.object({
  id: z.string().trim().min(1, 'Command ID required').max(128),
  idempotencyKey: z.string().trim().min(1, 'Idempotency key required').max(128),
  deviceId: z.string().trim().min(1, 'Device ID required').max(128),
  claimedAt: z.string().nullable().optional(),
  baseVersion: z.number().int().nonnegative().nullable().optional(),
  type: z.literal('kot.status'),
  payload: kotStatusCommandPayloadSchema,
});

export const syncPaymentRecordCommandSchema = z.object({
  id: z.string().trim().min(1, 'Command ID required').max(128),
  idempotencyKey: z.string().trim().min(1, 'Idempotency key required').max(128),
  deviceId: z.string().trim().min(1, 'Device ID required').max(128),
  claimedAt: z.string().nullable().optional(),
  baseVersion: z.number().int().nonnegative().nullable().optional(),
  type: z.literal('payment.record'),
  payload: paymentRecordCommandPayloadSchema,
});

export const syncUnknownCommandSchema = z.object({
  id: z.string().trim().min(1, 'Command ID required').max(128),
  idempotencyKey: z.string().trim().min(1, 'Idempotency key required').max(128),
  deviceId: z.string().trim().min(1, 'Device ID required').max(128),
  claimedAt: z.string().nullable().optional(),
  baseVersion: z.number().int().nonnegative().nullable().optional(),
  type: z.string().trim().min(1, 'Command type required').max(128),
  payload: z.record(z.string(), z.unknown()),
});

export const syncCommandBatchItemSchema = z.union([
  syncOrderCreateCommandSchema,
  syncKotStatusCommandSchema,
  syncPaymentRecordCommandSchema,
  syncUnknownCommandSchema,
]);

export type SyncCommandBatchItemInput = z.infer<typeof syncCommandBatchItemSchema>;

export const syncPushBatchSchema = z.object({
  restaurantId: z.string().uuid('Valid restaurant ID required').optional(),
  deviceId: z.string().trim().min(1, 'Device ID required').max(128),
  batchId: z.string().trim().min(1, 'Batch ID required').max(128),
  commands: z
    .array(syncCommandBatchItemSchema)
    .min(1, 'At least one command required')
    .max(100, 'Commands per batch must be at most 100'),
});
export type SyncPushBatchInput = z.infer<typeof syncPushBatchSchema>;

export const syncPullQuerySchema = z.object({
  since: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type SyncPullQueryInput = z.infer<typeof syncPullQuerySchema>;

export const registerHubSchema = z.object({
  deviceId: z.string().trim().min(1, 'Device ID required').max(128),
  name: z.string().trim().min(1, 'Hub name required').max(128).default('Restaurant Local Hub'),
  hostAddress: z.string().trim().min(1, 'Host address required').max(128),
  apiKey: z.string().trim().min(8, 'API key must be at least 8 chars').max(128).optional(),
});
export type RegisterHubInput = z.infer<typeof registerHubSchema>;

export const discardDeadLetterSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, 'Explanatory reason for discarding poison command is required (min 3 chars)'),
});
export type DiscardDeadLetterInput = z.infer<typeof discardDeadLetterSchema>;

export const resolveConflictSchema = z.object({
  resolutionNote: z.string().trim().min(3, 'Resolution note is required (min 3 chars)'),
});
export type ResolveConflictInput = z.infer<typeof resolveConflictSchema>;
