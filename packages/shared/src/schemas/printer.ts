import { z } from 'zod';

export const printerTransportSchema = z.enum(['bluetooth', 'usb', 'lan', 'browser']);
export type PrinterTransport = z.infer<typeof printerTransportSchema>;

export const printerWidthSchema = z.union([z.literal(58), z.literal(80)]);
export type PrinterWidth = z.infer<typeof printerWidthSchema>;

export const printerConfigSchema = z.object({
  id: z.string().uuid().optional(),
  restaurantId: z.string().uuid(),
  name: z.string().trim().min(1, 'Printer name is required').max(50),
  transport: printerTransportSchema.default('browser'),
  address: z.string().trim().default(''), // IP:port, MAC address, USB path, or empty for browser
  widthMm: printerWidthSchema.default(80),
  codepage: z.string().trim().default('CP437'),
  charsPerLine: z.number().int().min(20).max(80).default(48),
  autoCut: z.boolean().default(true),
  drawerPulse: z.boolean().default(false),
  isDefault: z.boolean().default(false),
  active: z.boolean().default(true),
  createdAt: z.coerce.date().optional(),
  updatedAt: z.coerce.date().optional(),
});

export type PrinterConfig = z.infer<typeof printerConfigSchema>;

/**
 * Validates a LAN printer address (host or host:port).
 * Rejects loopback addresses (127.0.0.1, localhost) and cloud metadata addresses (169.254.169.254).
 */
export function isValidLanPrinterAddress(addr: string): { valid: boolean; reason?: string } {
  if (!addr || typeof addr !== 'string') return { valid: false, reason: 'Address is required for LAN printers' };
  const trimmed = addr.trim();
  const parts = trimmed.split(':');
  const host = parts[0]?.trim() || '';
  const portStr = parts[1]?.trim();

  if (!host) return { valid: false, reason: 'Host is required' };

  // Disallow loopback and metadata addresses
  const lowerHost = host.toLowerCase();
  if (
    lowerHost === 'localhost' ||
    lowerHost === '127.0.0.1' ||
    lowerHost === '::1' ||
    lowerHost.startsWith('127.') ||
    lowerHost === '169.254.169.254' ||
    lowerHost === 'metadata.google.internal'
  ) {
    return { valid: false, reason: 'Loopback and link-local metadata addresses are forbidden for printers' };
  }

  // Validate port if specified
  if (portStr !== undefined) {
    const port = parseInt(portStr, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      return { valid: false, reason: 'Port must be between 1 and 65535' };
    }
  }

  return { valid: true };
}

export const createPrinterSchema = z
  .object({
    name: z.string().trim().min(1, 'Printer name is required').max(50),
    transport: printerTransportSchema,
    address: z.string().trim().default(''),
    widthMm: printerWidthSchema.default(80),
    codepage: z.string().trim().default('CP437'),
    charsPerLine: z.number().int().min(20).max(80).optional(),
    autoCut: z.boolean().default(true),
    drawerPulse: z.boolean().default(false),
    isDefault: z.boolean().default(false),
    active: z.boolean().default(true),
  })
  .superRefine((data, ctx) => {
    if (data.transport === 'lan') {
      const check = isValidLanPrinterAddress(data.address);
      if (!check.valid) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: check.reason || 'Invalid LAN printer address',
          path: ['address'],
        });
      }
    }
  });

export type CreatePrinterInput = z.infer<typeof createPrinterSchema>;

export const updatePrinterSchema = z
  .object({
    name: z.string().trim().min(1, 'Printer name is required').max(50).optional(),
    transport: printerTransportSchema.optional(),
    address: z.string().trim().optional(),
    widthMm: printerWidthSchema.optional(),
    codepage: z.string().trim().optional(),
    charsPerLine: z.number().int().min(20).max(80).optional(),
    autoCut: z.boolean().optional(),
    drawerPulse: z.boolean().optional(),
    isDefault: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.transport === 'lan' && data.address !== undefined) {
      const check = isValidLanPrinterAddress(data.address);
      if (!check.valid) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: check.reason || 'Invalid LAN printer address',
          path: ['address'],
        });
      }
    }
  });
export type UpdatePrinterInput = z.infer<typeof updatePrinterSchema>;

export const printEventSchema = z.object({
  // Client print-job UUID makes ambiguous event retries idempotent without a migration.
  eventId: z.string().uuid().optional(),
  type: z.enum(['print', 'reprint', 'duplicate', 'test']),
  printerId: z.string().uuid().optional().nullable(),
  result: z.enum(['success', 'failed']),
  error: z.string().optional().nullable(),
  approverUserId: z.string().uuid().optional(),
  ownerPin: z.string().optional(),
  pin: z.string().optional(),
});

export type PrintEventInput = z.infer<typeof printEventSchema>;

export const createPaymentRequestSchema = z.object({
  amountPaise: z.number().int().positive('Payment request amount must be greater than 0'),
  upiRef: z.string().trim().optional(),
});

export type CreatePaymentRequestInput = z.infer<typeof createPaymentRequestSchema>;
