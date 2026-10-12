import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Sheet } from '../../components/ui/Overlay.js';
import { Button } from '../../components/ui/Button.js';
import { BillSummary, type BillSummaryLine } from '../../components/BillSummary.js';
import { PinOverrideDialog, type PinOverrideData } from '../../components/PinOverrideDialog.js';
import { PaymentSheet } from './PaymentSheet.js';
import { apiFetch } from '../../stores/useAuthStore.js';
import { useToastStore } from '../../stores/useToastStore.js';
import { ArrowRight, Scissors } from 'lucide-react';
import { clearBillCreationAttemptKey, getBillCreationAttemptKey } from './billAttempt.js';

interface BillPreviewSheetProps {
  isOpen: boolean;
  orderId: string | null;
  tableLabel?: string | null;
  onClose: () => void;
  onOrderSettled?: () => void;
}

export const BILL_PREVIEW_TIMEOUT_MS = 15_000;

export interface BillRecord {
  id: string;
  billNumber: string;
  status: string;
  subtotalPaise: number;
  discountPaise: number;
  discountType?: 'flat' | 'percent' | null;
  discountValue?: number | null;
  discountReason?: string | null;
  serviceChargePaise?: number;
  taxPaise: number;
  cgstPaise?: number;
  sgstPaise?: number;
  roundOffPaise?: number;
  totalPaise: number;
  paidPaise?: number;
  [key: string]: unknown;
}

export interface BillPreviewResponse {
  bill: BillRecord;
  taxMode?: 'inclusive' | 'exclusive' | null;
  lines: BillSummaryLine[];
  payments: Array<Record<string, unknown>>;
}

export async function fetchBillPreview(orderId: string, querySignal: AbortSignal) {
  const requestController = new AbortController();
  const abortWithQuery = () => requestController.abort(querySignal.reason);
  if (querySignal.aborted) {
    abortWithQuery();
  } else {
    querySignal.addEventListener('abort', abortWithQuery, { once: true });
  }

  const timeoutId = setTimeout(
    () =>
      requestController.abort(
        new DOMException('Bill preview request timed out. Please try again.', 'TimeoutError'),
      ),
    BILL_PREVIEW_TIMEOUT_MS,
  );

  try {
    const response = await apiFetch<BillPreviewResponse>(`/orders/${orderId}/bill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: getBillCreationAttemptKey(orderId) }),
      signal: requestController.signal,
    });
    clearBillCreationAttemptKey(orderId);
    return response;
  } finally {
    clearTimeout(timeoutId);
    querySignal.removeEventListener('abort', abortWithQuery);
  }
}

export const BillPreviewSheet: React.FC<BillPreviewSheetProps> = ({
  isOpen,
  orderId,
  tableLabel,
  onClose,
  onOrderSettled,
}) => {
  const { addToast } = useToastStore();
  const [isPaymentSheetOpen, setIsPaymentSheetOpen] = useState(false);
  const [isDiscountFormOpen, setIsDiscountFormOpen] = useState(false);
  const [isPinModalOpen, setIsPinModalOpen] = useState(false);

  // Discount form inputs
  const [discountType, setDiscountType] = useState<'percent' | 'flat'>('percent');
  const [discountValue, setDiscountValue] = useState<string>('10');
  const [discountReason, setDiscountReason] = useState<string>('');

  // Fetch or generate bill for order
  const { data, isLoading, isError, error, isFetching, refetch } = useQuery<BillPreviewResponse>({
    queryKey: ['order-bill-preview', orderId],
    queryFn: ({ signal }) => fetchBillPreview(orderId!, signal),
    enabled: Boolean(isOpen && orderId),
    retry: false,
  });

  const bill = data?.bill;
  const lines = data?.lines || [];

  const handleApplyDiscountSubmit = async (override?: PinOverrideData | string) => {
    if (!bill) return;
    const numVal = parseFloat(discountValue);
    if (isNaN(numVal) || numVal <= 0) {
      addToast({ type: 'warning', message: 'Please enter a valid discount value' });
      return;
    }
    if (!discountReason.trim()) {
      addToast({ type: 'warning', message: 'Discount reason is required' });
      return;
    }

    const approverUserId = typeof override === 'object' ? override.approverUserId : undefined;
    const pin = typeof override === 'object' ? override.pin : override;

    try {
      await apiFetch(`/bills/${bill.id}/discount`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: discountType,
          value: discountType === 'flat' ? Math.round(numVal * 100) : numVal,
          reason: discountReason.trim(),
          approverUserId,
          overridePin: pin,
          pin,
        }),
      });
      addToast({ type: 'success', message: 'Discount applied successfully' });
      setIsDiscountFormOpen(false);
      setIsPinModalOpen(false);
      void refetch();
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : '';
      if (errMsg && errMsg.toLowerCase().includes('pin override')) {
        setIsPinModalOpen(true);
      } else {
        addToast({ type: 'danger', message: errMsg || 'Failed to apply discount' });
      }
    }
  };

  return (
    <>
      <Sheet
        isOpen={isOpen && !isPaymentSheetOpen}
        onClose={onClose}
        title={`Bill Preview ${tableLabel ? `• Table ${tableLabel}` : ''}`}
        description="Verify order items, apply approved discounts, and proceed to payment settlement."
      >
        <div className="space-y-5 pt-2 max-h-[calc(100vh-160px)] overflow-y-auto pr-1">
          {isLoading ? (
            <div className="py-20 text-center text-content-muted">Computing order bill...</div>
          ) : isError || !bill ? (
            <div className="py-12 text-center space-y-4" role="alert">
              <p className="text-content-primary font-semibold">
                {error instanceof Error
                  ? error.message
                  : 'Could not load the bill preview. Please try again.'}
              </p>
              <Button variant="secondary" onClick={() => void refetch()} isLoading={isFetching}>
                Retry preview
              </Button>
            </div>
          ) : (
            <>
              {/* Financial Bill Summary */}
              <p className="text-sm text-content-secondary" aria-label="Bill tax mode">
                GST mode:{' '}
                {data.taxMode === 'inclusive'
                  ? 'included in item prices'
                  : data.taxMode === 'exclusive'
                    ? 'added to item prices'
                    : 'not recorded for this bill'}
              </p>
              <BillSummary
                data={{
                  id: bill.id,
                  billNumber: bill.billNumber,
                  tableLabel,
                  status: bill.status,
                  subtotalPaise: bill.subtotalPaise,
                  discountPaise: bill.discountPaise,
                  discountType: bill.discountType,
                  discountValue: bill.discountValue,
                  discountReason: bill.discountReason,
                  serviceChargePaise: bill.serviceChargePaise,
                  taxPaise: bill.taxPaise,
                  roundOffPaise: bill.roundOffPaise ?? 0,
                  totalPaise: bill.totalPaise,
                  lines,
                }}
              />

              {/* Discount Accordion / Form */}
              <div className="rounded-xl border border-surface-border bg-surface-elevated/40 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-title font-bold text-content-primary">
                    <Scissors className="w-5 h-5 text-accent" />
                    <span>Promotional / Courtesy Discount</span>
                  </div>

                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setIsDiscountFormOpen(!isDiscountFormOpen)}
                  >
                    {isDiscountFormOpen
                      ? 'Cancel'
                      : bill.discountPaise > 0
                        ? 'Edit'
                        : 'Add Discount'}
                  </Button>
                </div>

                {isDiscountFormOpen && (
                  <div className="pt-2 border-t border-surface-border space-y-3">
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setDiscountType('percent')}
                        className={`flex-1 py-2 rounded-lg text-xs font-bold transition-colors ${
                          discountType === 'percent'
                            ? 'bg-accent text-accent-content'
                            : 'bg-surface-elevated text-content-secondary'
                        }`}
                      >
                        Percentage (%)
                      </button>
                      <button
                        type="button"
                        onClick={() => setDiscountType('flat')}
                        className={`flex-1 py-2 rounded-lg text-xs font-bold transition-colors ${
                          discountType === 'flat'
                            ? 'bg-accent text-accent-content'
                            : 'bg-surface-elevated text-content-secondary'
                        }`}
                      >
                        Flat Amount (₹)
                      </button>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs font-bold text-content-muted block mb-1">
                          {discountType === 'percent' ? 'Percent (0–100%)' : 'Rupees (₹)'}
                        </label>
                        <input
                          type="number"
                          value={discountValue}
                          onChange={(e) => setDiscountValue(e.target.value)}
                          placeholder="e.g. 10"
                          className="w-full px-3 py-2 rounded-xl bg-surface-card border border-surface-border text-content-primary font-mono font-bold"
                        />
                      </div>
                      <div>
                        <label className="text-xs font-bold text-content-muted block mb-1">
                          Reason *
                        </label>
                        <input
                          type="text"
                          value={discountReason}
                          onChange={(e) => setDiscountReason(e.target.value)}
                          placeholder="e.g. Regular guest / Promo"
                          className="w-full px-3 py-2 rounded-xl bg-surface-card border border-surface-border text-content-primary text-xs"
                        />
                      </div>
                    </div>

                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => handleApplyDiscountSubmit()}
                      className="w-full"
                    >
                      Update Discount
                    </Button>
                  </div>
                )}
              </div>

              {/* Action Buttons */}
              <div className="pt-3 border-t-2 border-surface-border flex items-center justify-between gap-3">
                <Button variant="ghost" size="lg" onClick={onClose}>
                  {tableLabel ? 'Back to Tables' : 'Back to Orders'}
                </Button>

                <Button
                  variant="primary"
                  size="lg"
                  onClick={() => setIsPaymentSheetOpen(true)}
                  rightIcon={<ArrowRight className="w-5 h-5" />}
                  className="font-black uppercase tracking-wider flex-1 bg-emerald-600 hover:bg-emerald-500 text-white"
                >
                  Pay & Settle
                </Button>
              </div>
            </>
          )}
        </div>
      </Sheet>

      {/* Payment Settlement Sheet */}
      {bill && (
        <PaymentSheet
          isOpen={isPaymentSheetOpen}
          bill={bill}
          tableLabel={tableLabel}
          onClose={() => setIsPaymentSheetOpen(false)}
          onPaid={() => {
            setIsPaymentSheetOpen(false);
            onClose();
            onOrderSettled?.();
          }}
        />
      )}

      {/* PIN Override Modal for Discount */}
      <PinOverrideDialog
        isOpen={isPinModalOpen}
        onClose={() => setIsPinModalOpen(false)}
        title="Owner PIN for Discount"
        description="This discount exceeds permitted role caps. Please request Owner PIN."
        onConfirm={(pin) => handleApplyDiscountSubmit(pin)}
      />
    </>
  );
};
