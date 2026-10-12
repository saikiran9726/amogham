import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrinterConfig, ReceiptData, ReceiptTemplateConfig } from '@restaurant-os/shared';
import type { PrinterDriver } from '../types.js';

const { printJobs } = vi.hoisted(() => {
  const jobs = new Map<string, Record<string, unknown>>();
  return {
    printJobs: {
      jobs,
      put: vi.fn(async (job: { id: string; [key: string]: unknown }) => {
        jobs.set(job.id, job);
      }),
      update: vi.fn(async (id: string, changes: Record<string, unknown>) => {
        const current = jobs.get(id) || {};
        jobs.set(id, { ...current, ...changes });
      }),
      get: vi.fn(async (id: string) => jobs.get(id)),
    },
  };
});

vi.mock('../../../db/dexie.js', () => ({ localDb: { printJobs } }));

import { PrinterService } from '../printer-service.js';

describe('PrinterService bill printing', () => {
  let service: PrinterService;
  let fetchMock: ReturnType<typeof vi.fn>;
  let printedReceipt: ReceiptData | undefined;
  let printedText: string | undefined;
  let fixtureOrderType: 'dine_in' | 'takeaway' = 'dine_in';
  let driverResult: { success: boolean; error?: string } = { success: true };
  let denyReprintAuthorization = false;
  let failEventAudit = false;

  const printer: PrinterConfig = {
    restaurantId: 'restaurant-1',
    name: 'Mock printer',
    transport: 'browser',
    address: '',
    widthMm: 80,
    codepage: 'CP437',
    charsPerLine: 48,
    autoCut: false,
    drawerPulse: false,
    isDefault: true,
    active: true,
  };

  beforeEach(() => {
    printJobs.jobs.clear();
    printJobs.put.mockClear();
    printJobs.update.mockClear();
    printJobs.get.mockClear();
    printedReceipt = undefined;
    printedText = undefined;
    fixtureOrderType = 'dine_in';
    driverResult = { success: true };
    denyReprintAuthorization = false;
    failEventAudit = false;
    service = new PrinterService();
    const mockDriver: PrinterDriver = {
      transport: 'browser',
      isAvailable: async () => true,
      print: async (
        _escpos: string,
        text: string,
        _target: PrinterConfig,
        receipt: ReceiptData,
        _template: ReceiptTemplateConfig,
      ) => {
        printedReceipt = receipt;
        printedText = text;
        return driverResult;
      },
    };
    service.registerDriver(mockDriver);

    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/receipt')) {
        return new Response(
          JSON.stringify({
            receiptData: {
              billNumber: 'B-100',
              orderType: fixtureOrderType,
              tableName: fixtureOrderType === 'takeaway' ? undefined : 'T-1',
              lines: [{ name: 'Dosa', qty: 1, pricePaise: 10000, totalPaise: 10000 }],
              subtotalPaise: 10000,
              discountPaise: 0,
              serviceChargePaise: 0,
              cgstPaise: 250,
              sgstPaise: 250,
              roundOffPaise: 0,
              totalPaise: 10500,
              paidPaise: 0,
              balanceDuePaise: 10500,
              payments: [],
              isDuplicate: false,
              printedCount: 0,
            },
            templateConfig: { widthMm: 80, charsPerLine: 48 },
            plainText: 'Receipt',
            escposBase64: 'AQI=',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/reprint')) {
        return new Response(
          JSON.stringify(
            denyReprintAuthorization
              ? { error: { message: 'Reprinting a paid bill requires authorization' } }
              : { billId: 'bill-1', authorized: true },
          ),
          {
            status: denyReprintAuthorization ? 403 : 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      if (url.includes('/print-events')) {
        return new Response(
          failEventAudit ? JSON.stringify({ error: { message: 'Audit unavailable' } }) : '{}',
          {
            status: failEventAudit ? 503 : 201,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      throw new Error(`Unexpected print request: ${init?.method || 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  it.each([
    ['dine-in', 'dine_in', 'T-1'],
    ['takeaway', 'takeaway', undefined],
  ] as const)(
    'prints the %s bill from its existing receipt',
    async (label, orderType, tableName) => {
      fixtureOrderType = orderType;
      const result = await service.printBill('bill-1', {
        printerOverride: printer,
      });

      expect(result.success).toBe(true);
      expect(printedReceipt?.orderType).toBe(orderType);
      expect(printedReceipt?.tableName).toBe(tableName);
      expect(printedText).toBe('Receipt');
      expect(
        fetchMock.mock.calls.map(([url, init]) => [String(url), init?.method || 'GET']),
      ).toEqual([
        ['/api/bills/bill-1/reprint', 'POST'],
        [`/api/bills/bill-1/receipt?widthMm=80`, 'GET'],
        [`/api/bills/bill-1/print-events`, 'POST'],
      ]);
      expect(
        fetchMock.mock.calls.some(([url]) => /payments|orders|\/bill(?:\?|$)/.test(String(url))),
      ).toBe(false);
    },
  );

  it('prints a reprint through the same receipt path and marks only a reprint event', async () => {
    const result = await service.printBill('bill-1', {
      isReprint: true,
      printerOverride: printer,
    });

    expect(result.success).toBe(true);
    const eventRequest = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/print-events'),
    );
    expect(JSON.parse(String(eventRequest?.[1]?.body))).toMatchObject({
      eventId: result.jobId,
      type: 'reprint',
      result: 'success',
    });
    expect(fetchMock.mock.calls.map(([url, init]) => [String(url), init?.method || 'GET'])).toEqual(
      [
        ['/api/bills/bill-1/reprint', 'POST'],
        ['/api/bills/bill-1/receipt?widthMm=80', 'GET'],
        ['/api/bills/bill-1/print-events', 'POST'],
      ],
    );
    expect(fetchMock.mock.calls.some(([url]) => /payments|orders/.test(String(url)))).toBe(false);
  });

  it('does not invoke any printer when backend authorization is denied', async () => {
    denyReprintAuthorization = true;

    const result = await service.printBill('bill-1', { printerOverride: printer });

    expect(result.success).toBe(false);
    expect(result.error).toContain('requires authorization');
    expect(printedReceipt).toBeUndefined();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(['/api/bills/bill-1/reprint']);
  });

  it('records failed printer output as a failed audit event without counting it as a successful print', async () => {
    driverResult = { success: false, error: 'Paper out' };

    const result = await service.printBill('bill-1', { printerOverride: printer });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Paper out');
    const eventRequest = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/print-events'),
    );
    expect(JSON.parse(String(eventRequest?.[1]?.body))).toMatchObject({
      type: 'print',
      result: 'failed',
      error: 'Paper out',
    });
    expect(printJobs.jobs.get(result.jobId)).toMatchObject({
      status: 'failed',
      error: 'Paper out',
    });
  });

  it('fails clearly when a configured hardware printer is unavailable', async () => {
    service.registerDriver({
      transport: 'lan',
      isAvailable: async () => false,
      print: vi.fn(async () => ({ success: true })),
    });

    const result = await service.printBill('bill-1', {
      printerOverride: { ...printer, transport: 'lan', address: '192.0.2.10:9100' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('unavailable in this environment');
    expect(printedReceipt).toBeUndefined();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/print-events'))).toBe(true);
  });

  it('retries an ambiguous audit result with the same event id without printing again', async () => {
    failEventAudit = true;
    const printed = await service.printBill('bill-1', { printerOverride: printer });

    expect(printed.success).toBe(true);
    expect(printed.warning).toContain('audit result was not confirmed');
    expect(printJobs.jobs.get(printed.jobId)).toMatchObject({
      status: 'printed',
      auditPending: true,
      auditError: 'Audit unavailable',
    });

    const receiptFetchCount = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/receipt'),
    ).length;
    failEventAudit = false;
    const auditRetry = await service.retryAudit(printed.jobId);

    expect(auditRetry.success).toBe(true);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/receipt'))).toHaveLength(
      receiptFetchCount,
    );
    expect(printJobs.jobs.get(printed.jobId)).toMatchObject({ auditPending: false });
    const eventBodies = fetchMock.mock.calls
      .filter(([url]) => String(url).includes('/print-events'))
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(eventBodies).toHaveLength(2);
    expect(eventBodies[0].eventId).toBe(printed.jobId);
    expect(eventBodies[1].eventId).toBe(printed.jobId);
  });
});
