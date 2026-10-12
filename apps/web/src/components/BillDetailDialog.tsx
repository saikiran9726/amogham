import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatPaiseToRupeeString, Permissions } from '@restaurant-os/shared';
import { Dialog } from './ui/Overlay.js';
import { Button } from './ui/Button.js';
import { BillSummary, type BillSummaryLine } from './BillSummary.js';
import { PaymentRow, type PaymentItem } from './PaymentRow.js';
import { RefundDialog } from './RefundDialog.js';
import { PinOverrideDialog, type PinOverrideData } from './PinOverrideDialog.js';
import { apiFetch, useAuthStore } from '../stores/useAuthStore.js';
import { useToastStore } from '../stores/useToastStore.js';
import { Printer, Ban, RotateCcw, CheckCircle2, AlertCircle, Clock, History } from 'lucide-react';
import { printerService } from '../services/printer/printer-service.js';

interface BillDetailData {
  id: string;
  billNumber: string;
  status: string;
  subtotalPaise: number;
  discountPaise: number;
  discountType?: 'percent' | 'flat' | null;
  discountValue?: number | null;
  discountReason?: string | null;
  serviceChargePaise?: number;
  taxPaise: number;
  roundOffPaise: number;
  totalPaise: number;
  printedCount: number;
  createdAt: string;
  [key: string]: unknown;
}

interface RefundItem {
  id: string;
  method: 'cash' | 'upi' | 'card';
  amountPaise: number;
  reason: string;
  createdAt?: string;
  [key: string]: unknown;
}

interface BillDetailDialogProps {
  isOpen: boolean;
  billId: string | null;
  onClose: () => void;
  onBillUpdated?: () => void;
}

export const BillDetailDialog: React.FC<BillDetailDialogProps> = ({
  isOpen,
  billId,
  onClose,
  onBillUpdated,
}) => {
  const { addToast } = useToastStore();
  const user = useAuthStore((state) => state.user);
  const [isRefundOpen, setIsRefundOpen] = useState(false);
  const [isCancelPinOpen, setIsCancelPinOpen] = useState(false);
  const [isReprintPinOpen, setIsReprintPinOpen] = useState(false);
  const [isPrinting, setIsPrinting] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  const { data, isLoading, refetch } = useQuery<{
    bill: BillDetailData;
    lines: BillSummaryLine[];
    payments: PaymentItem[];
    refunds: RefundItem[];
  }>({
    queryKey: ['bill-detail', billId],
    queryFn: () => apiFetch(`/bills/${billId}`),
    enabled: Boolean(isOpen && billId),
  });

  const bill = data?.bill;
  const lines = data?.lines || [];
  const payments = data?.payments || [];
  const refunds = data?.refunds || [];

  const confirmedPaymentsPaise = payments
    .filter((p) => p.status === 'confirmed' || p.status === 'recorded')
    .reduce((sum, p) => sum + p.amountPaise, 0);

  const totalRefundedPaise = refunds.reduce((sum, r) => sum + r.amountPaise, 0);
  const maxRefundablePaise = Math.max(0, confirmedPaymentsPaise - totalRefundedPaise);

  const handleConfirmUpi = async (paymentId: string) => {
    try {
      await apiFetch(`/payments/${paymentId}/confirm`, { method: 'POST' });
      addToast({ type: 'success', message: 'UPI payment confirmed by staff' });
      void refetch();
      onBillUpdated?.();
    } catch (err: unknown) {
      addToast({
        type: 'danger',
        message: err instanceof Error ? err.message : 'Failed to confirm payment',
      });
    }
  };

  const printReceipt = async (override?: PinOverrideData | string) => {
    if (!billId || !bill) return false;
    setIsPrinting(true);
    try {
      const isReprint = bill.printedCount > 0;
      const approverUserId = typeof override === 'object' ? override.approverUserId : undefined;
      const pin = typeof override === 'object' ? override.pin : override;
      const result = await printerService.printBill(billId, {
        isReprint,
        ownerPin: pin,
        pin,
        approverUserId,
      });
      if (!result.success) {
        throw new Error(result.error || 'Receipt could not be printed');
      }
      addToast({
        type: result.warning ? 'warning' : 'success',
        message:
          result.warning ||
          (result.fallbackUsed
            ? 'No active printer was configured. The receipt was sent to the browser print dialog.'
            : isReprint
              ? 'Receipt reprinted successfully'
              : 'Receipt sent to printer'),
      });
      await refetch();
      onBillUpdated?.();
      return true;
    } catch (err: unknown) {
      addToast({
        type: 'danger',
        message: err instanceof Error ? err.message : 'Receipt could not be printed',
      });
      return false;
    } finally {
      setIsPrinting(false);
    }
  };

  const handlePrintReceipt = async () => {
    if (!bill) return;
    const isPaidBillReprint = bill.status === 'paid' && bill.printedCount > 0;
    const mayReprint = user?.permissions.includes(Permissions.BILL_REPRINT) ?? false;
    if (isPaidBillReprint && !mayReprint) {
      setIsReprintPinOpen(true);
      return;
    }
    await printReceipt();
  };

  const handleAuthorizedReprint = async (override: PinOverrideData) => {
    const succeeded = await printReceipt(override);
    if (succeeded) setIsReprintPinOpen(false);
    else throw new Error('Reprint was not completed. Review the error and try again.');
  };

  const handleCancelBill = async (override?: PinOverrideData | string) => {
    if (!billId) return;
    const reason = cancelReason.trim() || 'Voided by manager';
    const approverUserId = typeof override === 'object' ? override.approverUserId : undefined;
    const pin = typeof override === 'object' ? override.pin : override;
    try {
      await apiFetch(`/bills/${billId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, approverUserId, overridePin: pin, pin }),
      });
      addToast({ type: 'warning', message: 'Bill has been cancelled' });
      setIsCancelPinOpen(false);
      void refetch();
      onBillUpdated?.();
    } catch (err: unknown) {
      addToast({
        type: 'danger',
        message: err instanceof Error ? err.message : 'Failed to cancel bill',
      });
    }
  };

  const handleProcessRefund = async (payload: {
    amountPaise: number;
    method: 'cash' | 'upi' | 'card';
    reason: string;
    approverUserId?: string;
    pin?: string;
  }) => {
    if (!billId) return;
    try {
      await apiFetch(`/bills/${billId}/refunds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      addToast({ type: 'success', message: 'Refund recorded successfully' });
      setIsRefundOpen(false);
      void refetch();
      onBillUpdated?.();
    } catch (err: unknown) {
      addToast({
        type: 'danger',
        message: err instanceof Error ? err.message : 'Refund failed',
      });
    }
  };

  if (!isOpen || !billId) return null;

  return (
    <>
      <Dialog
        isOpen={isOpen}
        onClose={onClose}
        title={bill ? `Bill ${bill.billNumber}` : 'Bill Details'}
        description={bill ? `Created ${new Date(bill.createdAt).toLocaleString()}` : ''}
        size="lg"
      >
        {isLoading || !bill ? (
          <div className="py-16 text-center text-content-muted">Loading bill details...</div>
        ) : (
          <div className="space-y-6 pt-2 max-h-[calc(100vh-180px)] overflow-y-auto pr-1">
            {/* Bill Financial Summary */}
            <BillSummary
              data={{
                id: bill.id,
                billNumber: bill.billNumber,
                status: bill.status,
                subtotalPaise: bill.subtotalPaise,
                discountPaise: bill.discountPaise,
                discountType: bill.discountType,
                discountValue: bill.discountValue,
                discountReason: bill.discountReason,
                serviceChargePaise: bill.serviceChargePaise,
                taxPaise: bill.taxPaise,
                roundOffPaise: bill.roundOffPaise,
                totalPaise: bill.totalPaise,
                lines,
                createdAt: bill.createdAt,
              }}
            />

            {/* Payments List */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-body font-black uppercase tracking-wider text-content-primary">
                  Payments ({payments.length})
                </h4>
                <span className="text-xs font-mono font-bold text-content-secondary">
                  Confirmed: {formatPaiseToRupeeString(confirmedPaymentsPaise)} /{' '}
                  {formatPaiseToRupeeString(bill.totalPaise)}
                </span>
              </div>

              {payments.length === 0 ? (
                <div className="p-4 rounded-xl border border-dashed border-surface-border text-center text-content-muted text-xs">
                  No payments recorded yet.
                </div>
              ) : (
                <div className="space-y-2">
                  {payments.map((p) => (
                    <PaymentRow key={p.id} payment={p} onConfirm={() => handleConfirmUpi(p.id)} />
                  ))}
                </div>
              )}
            </div>

            {/* Refunds Section if any */}
            {refunds.length > 0 && (
              <div className="space-y-3">
                <h4 className="text-body font-black uppercase tracking-wider text-red-400">
                  Refunds ({refunds.length})
                </h4>
                <div className="space-y-2">
                  {refunds.map((r) => (
                    <div
                      key={r.id}
                      className="p-3 rounded-xl bg-red-950/20 border border-red-500/30 flex items-center justify-between text-body"
                    >
                      <div>
                        <span className="font-bold text-content-primary">
                          {r.method.toUpperCase()} Refund
                        </span>
                        <span className="text-xs text-content-muted block">Reason: {r.reason}</span>
                      </div>
                      <span className="font-mono font-black text-red-400 tabular-nums">
                        -{formatPaiseToRupeeString(r.amountPaise)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Bottom Actions Toolbar */}
            <div className="pt-4 border-t-2 border-surface-border flex flex-wrap items-center justify-between gap-3">
              {/* Left: Printing State */}
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handlePrintReceipt}
                  isLoading={isPrinting}
                  disabled={isPrinting}
                  leftIcon={
                    bill.printedCount > 0 ? (
                      <History className="w-4 h-4" />
                    ) : (
                      <Printer className="w-4 h-4" />
                    )
                  }
                  className="text-xs"
                >
                  {bill.printedCount > 0
                    ? `Reprint Receipt (#${bill.printedCount})`
                    : 'Print Receipt'}
                </Button>
              </div>

              {/* Right: Operational Actions (Refund, Cancel, Close) */}
              <div className="flex items-center gap-2">
                {bill.status === 'paid' && maxRefundablePaise > 0 && (
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => setIsRefundOpen(true)}
                    leftIcon={<RotateCcw className="w-4 h-4" />}
                  >
                    Refund
                  </Button>
                )}

                {bill.status !== 'cancelled' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (bill.status === 'paid') {
                        setIsCancelPinOpen(true);
                      } else {
                        void handleCancelBill();
                      }
                    }}
                    className="text-red-400 hover:bg-red-500/10"
                    leftIcon={<Ban className="w-4 h-4" />}
                  >
                    Cancel Bill
                  </Button>
                )}

                <Button variant="secondary" size="sm" onClick={onClose}>
                  Close
                </Button>
              </div>
            </div>
          </div>
        )}
      </Dialog>

      {/* Refund Modal */}
      {bill && (
        <RefundDialog
          isOpen={isRefundOpen}
          billId={bill.id}
          billNumber={bill.billNumber}
          maxRefundablePaise={maxRefundablePaise}
          onClose={() => setIsRefundOpen(false)}
          onSubmitRefund={handleProcessRefund}
        />
      )}

      {/* PIN Override for Cancelling Paid Bill */}
      <PinOverrideDialog
        isOpen={isCancelPinOpen}
        onClose={() => setIsCancelPinOpen(false)}
        title="Owner PIN to Cancel Paid Bill"
        description="Cancelling a settled bill requires Owner authorization."
        onConfirm={handleCancelBill}
      />

      <PinOverrideDialog
        isOpen={isReprintPinOpen}
        onClose={() => setIsReprintPinOpen(false)}
        title="Owner PIN to Reprint Paid Bill"
        description="Reprinting a paid bill requires BILL_REPRINT permission or Owner authorization."
        isSubmitting={isPrinting}
        onConfirm={handleAuthorizedReprint}
      />
    </>
  );
};
