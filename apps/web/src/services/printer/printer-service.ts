import type { PrinterConfig, ReceiptData, ReceiptTemplateConfig } from '@restaurant-os/shared';
import { localDb } from '../../db/dexie.js';
import type { PrinterDriver, PrintResult } from './types.js';
import { BrowserPrintDriver } from './drivers/browser-driver.js';
import { BluetoothDriver } from './drivers/bluetooth-driver.js';
import { UsbDriver } from './drivers/usb-driver.js';
import { LanDriver } from './drivers/lan-driver.js';
import { useAuthStore } from '../../stores/useAuthStore.js';

const DEVICE_PRINTER_KEY = 'restaurant_os_device_printer';

export interface BillPrintResult {
  success: boolean;
  error?: string;
  warning?: string;
  fallbackUsed?: boolean;
  jobId: string;
}

export class PrinterService {
  private drivers: Map<string, PrinterDriver> = new Map();
  private browserFallbackDriver = new BrowserPrintDriver();

  constructor() {
    this.registerDriver(new BrowserPrintDriver());
    this.registerDriver(new BluetoothDriver());
    this.registerDriver(new UsbDriver());
    this.registerDriver(new LanDriver());
  }

  public registerDriver(driver: PrinterDriver): void {
    this.drivers.set(driver.transport, driver);
  }

  public getDriver(transport: string): PrinterDriver {
    return this.drivers.get(transport) || this.browserFallbackDriver;
  }

  /**
   * Retrieves the assigned printer configuration for this specific tablet/device.
   */
  public getDevicePrinter(): PrinterConfig | null {
    try {
      const stored = localStorage.getItem(DEVICE_PRINTER_KEY);
      if (stored) {
        return JSON.parse(stored) as PrinterConfig;
      }
    } catch {
      // Ignore parse errors
    }
    return null;
  }

  /**
   * Assigns the default printer for this specific device.
   */
  public setDevicePrinter(printer: PrinterConfig | null): void {
    if (printer) {
      localStorage.setItem(DEVICE_PRINTER_KEY, JSON.stringify(printer));
    } else {
      localStorage.removeItem(DEVICE_PRINTER_KEY);
    }
  }

  /**
   * Prints a bill receipt asynchronously without ever blocking the UI or billing state.
   */
  public async printBill(
    billId: string,
    options: {
      isReprint?: boolean;
      isDuplicate?: boolean;
      ownerPin?: string;
      approverUserId?: string;
      pin?: string;
      printerOverride?: PrinterConfig;
      token?: string;
    } = {},
  ): Promise<BillPrintResult> {
    const jobId = crypto.randomUUID();
    const jobType = options.isDuplicate ? 'duplicate' : options.isReprint ? 'reprint' : 'print';

    // 1. Enqueue job locally in Dexie
    await localDb.printJobs.put({
      id: jobId,
      billId,
      billNumber: 'Loading...',
      type: jobType,
      status: 'queued',
      attempts: 0,
      createdAt: Date.now(),
    });

    // 2. Execute printing asynchronously (fire-and-forget or awaited by caller)
    return this.executeJob(jobId, billId, options);
  }

  private async executeJob(
    jobId: string,
    billId: string,
    options: {
      isReprint?: boolean;
      isDuplicate?: boolean;
      ownerPin?: string;
      approverUserId?: string;
      pin?: string;
      printerOverride?: PrinterConfig;
      token?: string;
    },
  ): Promise<BillPrintResult> {
    try {
      // Update status to printing
      await localDb.printJobs.update(jobId, {
        status: 'printing',
        lastAttemptAt: Date.now(),
      });

      const authToken = options.token || useAuthStore.getState().accessToken || '';
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
      }

      // Always preflight. The API only requires the elevated reprint permission
      // for paid bills that already have a successful print; this also prevents
      // a caller from relabeling a reprint as an initial print.
      const authorization = await fetch(`/api/bills/${billId}/reprint`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ownerPin: options.pin ?? options.ownerPin,
          pin: options.pin ?? options.ownerPin,
          approverUserId: options.approverUserId,
        }),
      });
      if (!authorization.ok) {
        const errorJson = await authorization.json().catch(() => ({}));
        const errMsg =
          errorJson?.error?.message || `Print authorization failed (${authorization.status})`;
        await this.markJobFailed(jobId, errMsg);
        return { success: false, error: errMsg, jobId };
      }

      // Fetch active device printer or fallback
      let targetPrinter = options.printerOverride || this.getDevicePrinter();
      let fallbackUsed = false;

      // If no local device printer configured, fetch available printers from server
      if (!targetPrinter) {
        try {
          const listRes = await fetch('/api/printers', { headers });
          if (listRes.ok) {
            const list: PrinterConfig[] = await listRes.json();
            targetPrinter = list.find((p) => p.isDefault) || list[0] || null;
          }
        } catch {
          // Keep null to fallback to browser print
        }
      }

      // Fallback to browser print if no hardware printer configured
      if (!targetPrinter) {
        fallbackUsed = true;
        targetPrinter = {
          restaurantId: '',
          name: 'Browser Print',
          transport: 'browser',
          address: '',
          widthMm: 80,
          codepage: 'CP437',
          charsPerLine: 48,
          autoCut: true,
          drawerPulse: false,
          isDefault: true,
          active: true,
        };
      }

      if (!targetPrinter.active) {
        const errMsg = `Printer "${targetPrinter.name}" is inactive. Choose an active printer or Browser Print.`;
        const auditError = await this.recordPrintOutcome(
          jobId,
          billId,
          options,
          headers,
          targetPrinter.id,
          'failed',
          errMsg,
        );
        await this.markJobFailed(jobId, errMsg, auditError);
        return { success: false, error: errMsg, jobId };
      }

      const driver = this.getDriver(targetPrinter.transport);
      if (!(await driver.isAvailable())) {
        const errMsg =
          targetPrinter.transport === 'browser'
            ? 'This browser does not support receipt printing. Try a supported browser or the Restaurant OS Android app.'
            : `The ${targetPrinter.transport.toUpperCase()} printer is unavailable in this environment. Use Browser Print or the Restaurant OS Android app.`;
        const auditError = await this.recordPrintOutcome(
          jobId,
          billId,
          options,
          headers,
          targetPrinter.id,
          'failed',
          errMsg,
        );
        await this.markJobFailed(jobId, errMsg, auditError);
        return { success: false, error: errMsg, jobId };
      }

      // Fetch structured receipt data
      const url = `/api/bills/${billId}/receipt?widthMm=${targetPrinter.widthMm}${targetPrinter.id ? `&printerId=${targetPrinter.id}` : ''}`;
      const res = await fetch(url, { headers });

      if (!res.ok) {
        const errorJson = await res.json().catch(() => ({}));
        const errMsg = errorJson?.error?.message || `Failed to fetch receipt (${res.status})`;
        const auditError = await this.recordPrintOutcome(
          jobId,
          billId,
          options,
          headers,
          targetPrinter.id,
          'failed',
          errMsg,
        );
        await this.markJobFailed(jobId, errMsg, auditError);
        return { success: false, error: errMsg, jobId, fallbackUsed };
      }

      const {
        receiptData,
        templateConfig,
        plainText,
        escposBase64,
      }: {
        receiptData: ReceiptData;
        templateConfig: ReceiptTemplateConfig;
        plainText: string;
        escposBase64: string;
      } = await res.json();

      // Update job with bill number and printer name
      await localDb.printJobs.update(jobId, {
        billNumber: receiptData.billNumber,
        printerId: targetPrinter.id,
        printerName: targetPrinter.name,
        transport: targetPrinter.transport,
        receiptData,
      });

      // Execute driver print
      const printResult = await driver.print(
        escposBase64,
        plainText,
        targetPrinter,
        receiptData,
        templateConfig,
      );

      const auditWarning = await this.recordPrintOutcome(
        jobId,
        billId,
        options,
        headers,
        targetPrinter.id,
        printResult.success ? 'success' : 'failed',
        printResult.error,
      );

      if (printResult.success) {
        await localDb.printJobs.update(jobId, {
          status: 'printed',
          error: undefined,
          printError: undefined,
          auditPending: Boolean(auditWarning),
          auditError: auditWarning,
        });
        return {
          success: true,
          warning: auditWarning
            ? `Receipt printed, but the audit result was not confirmed: ${auditWarning}`
            : undefined,
          fallbackUsed,
          jobId,
        };
      } else {
        const error = [printResult.error || 'Print failed', auditWarning]
          .filter(Boolean)
          .join(' Audit logging also failed: ');
        await this.markJobFailed(jobId, printResult.error || 'Print failed', auditWarning);
        return { success: false, error, jobId, fallbackUsed };
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Unexpected error during printing';
      await this.markJobFailed(jobId, errMsg);
      return { success: false, error: errMsg, jobId };
    }
  }

  private async recordPrintOutcome(
    eventId: string,
    billId: string,
    options: {
      isReprint?: boolean;
      isDuplicate?: boolean;
      ownerPin?: string;
      pin?: string;
      approverUserId?: string;
    },
    headers: Record<string, string>,
    printerId: string | undefined,
    result: 'success' | 'failed',
    error?: string,
  ): Promise<string | undefined> {
    const type = options.isDuplicate ? 'duplicate' : options.isReprint ? 'reprint' : 'print';
    try {
      const response = await fetch(`/api/bills/${billId}/print-events`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          eventId,
          type,
          printerId,
          result,
          error,
          ownerPin: options.pin ?? options.ownerPin,
          pin: options.pin ?? options.ownerPin,
          approverUserId: options.approverUserId,
        }),
      });
      if (!response.ok) {
        const errorJson = await response.json().catch(() => ({}));
        return errorJson?.error?.message || `Print outcome audit failed (${response.status})`;
      }
      return undefined;
    } catch {
      return 'Could not reach the server to record the print outcome.';
    }
  }

  private async markJobFailed(jobId: string, error: string, auditError?: string): Promise<void> {
    const job = await localDb.printJobs.get(jobId);
    await localDb.printJobs.update(jobId, {
      status: 'failed',
      error,
      printError: error,
      auditPending: Boolean(auditError),
      auditError,
      attempts: (job?.attempts || 0) + 1,
    });
  }

  /** Retries only the idempotent server audit; it never invokes a printer. */
  public async retryAudit(jobId: string, ownerPin?: string): Promise<PrintResult> {
    const job = await localDb.printJobs.get(jobId);
    if (!job) return { success: false, error: 'Print job not found' };
    if (!job.auditPending) return { success: true };

    const authToken = useAuthStore.getState().accessToken || '';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    const type =
      job.type === 'duplicate' ? 'duplicate' : job.type === 'reprint' ? 'reprint' : 'print';
    const error = job.printError;
    const auditError = await this.recordPrintOutcome(
      job.id,
      job.billId,
      { isReprint: type === 'reprint', isDuplicate: type === 'duplicate', ownerPin },
      headers,
      job.printerId,
      job.status === 'printed' ? 'success' : 'failed',
      error,
    );

    await localDb.printJobs.update(jobId, {
      auditPending: Boolean(auditError),
      auditError,
    });
    return auditError ? { success: false, error: auditError } : { success: true };
  }

  /**
   * Retries a failed print job using same or specified printer.
   */
  public async retryJob(jobId: string, printerOverride?: PrinterConfig): Promise<PrintResult> {
    const job = await localDb.printJobs.get(jobId);
    if (!job) return { success: false, error: 'Job not found' };

    const res = await this.executeJob(jobId, job.billId, {
      isReprint: job.type === 'reprint',
      isDuplicate: job.type === 'duplicate',
      printerOverride,
    });

    return { success: res.success, error: res.error };
  }

  /**
   * Fallback: immediately prints the failed receipt via Browser Print.
   */
  public async fallbackToBrowserPrint(jobId: string): Promise<PrintResult> {
    const browserPrinter: PrinterConfig = {
      restaurantId: '',
      name: 'Browser Print',
      transport: 'browser',
      address: '',
      widthMm: 80,
      codepage: 'CP437',
      charsPerLine: 48,
      autoCut: true,
      drawerPulse: false,
      isDefault: true,
      active: true,
    };
    return this.retryJob(jobId, browserPrinter);
  }

  /**
   * Executes a Test Print for a given printer configuration.
   */
  public async testPrint(printer: PrinterConfig, token?: string): Promise<PrintResult> {
    try {
      const authToken = token || useAuthStore.getState().accessToken || '';
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
      }

      const res = await fetch(`/api/printers/${printer.id}/test`, {
        method: 'POST',
        headers,
      });

      if (!res.ok) {
        const errorJson = await res.json().catch(() => ({}));
        throw new Error(errorJson?.error?.message || `Test print failed (${res.status})`);
      }

      const { plainText, escposBase64 } = await res.json();
      const driver = this.getDriver(printer.transport);

      return await driver.print(
        escposBase64,
        plainText,
        printer,
        {} as unknown as ReceiptData,
        {} as unknown as ReceiptTemplateConfig,
      );
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : 'Test print error' };
    }
  }
}

export const printerService = new PrinterService();
