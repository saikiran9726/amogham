import React, { useState, useEffect } from 'react';
import { formatPaiseToRupeeString } from '@restaurant-os/shared';
import { Dialog } from './ui/Overlay.js';
import { Button } from './ui/Button.js';
import { MoneyInput } from './MoneyInput.js';
import { SegmentedControl } from './ui/SegmentedControl.js';
import { RotateCcw, AlertTriangle, UserCheck, KeyRound } from 'lucide-react';
import { apiFetch } from '../stores/useAuthStore.js';
import type { ApproverUser } from '@restaurant-os/shared';

interface RefundDialogProps {
  isOpen: boolean;
  billId: string;
  billNumber: string;
  maxRefundablePaise: number;
  onClose: () => void;
  onSubmitRefund: (payload: {
    amountPaise: number;
    method: 'cash' | 'upi' | 'card';
    reason: string;
    approverUserId?: string;
    pin?: string;
  }) => Promise<void> | void;
  isSubmitting?: boolean;
}

export const RefundDialog: React.FC<RefundDialogProps> = ({
  isOpen,
  billId,
  billNumber,
  maxRefundablePaise,
  onClose,
  onSubmitRefund,
  isSubmitting = false,
}) => {
  const [amountPaise, setAmountPaise] = useState<number>(maxRefundablePaise);
  const [method, setMethod] = useState<'cash' | 'upi' | 'card'>('cash');
  const [reason, setReason] = useState('');
  const [approvers, setApprovers] = useState<ApproverUser[]>([]);
  const [selectedApproverId, setSelectedApproverId] = useState<string>('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAmountPaise(maxRefundablePaise);
  }, [maxRefundablePaise]);

  useEffect(() => {
    if (!isOpen) {
      setPin('');
      setError(null);
      return;
    }

    let isMounted = true;
    const loadApprovers = async () => {
      try {
        const list = await apiFetch<ApproverUser[]>('/staff/approvers');
        if (isMounted) {
          setApprovers(list || []);
          if (list && list.length > 0 && !selectedApproverId) {
            const first = list[0];
            if (first) {
              setSelectedApproverId(first.id);
            }
          }
        }
      } catch {
        // Fallback gracefully if approvers endpoint unavailable
      }
    };

    void loadApprovers();
    return () => {
      isMounted = false;
    };
  }, [isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (amountPaise <= 0) {
      setError('Refund amount must be greater than zero');
      return;
    }
    if (amountPaise > maxRefundablePaise) {
      setError(`Refund amount cannot exceed ${formatPaiseToRupeeString(maxRefundablePaise)}`);
      return;
    }
    if (reason.trim().length < 3) {
      setError('Please provide a specific reason for refund (minimum 3 characters)');
      return;
    }

    try {
      await onSubmitRefund({
        amountPaise,
        method,
        reason: reason.trim(),
        approverUserId: selectedApproverId || undefined,
        pin: pin || undefined,
      });
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Refund processing failed');
    }
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={`Issue Refund • ${billNumber}`}
      description="Record a customer refund. All refunds are logged to the security audit trail."
      size="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4 pt-2">
        <div className="flex items-center gap-2.5 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs">
          <AlertTriangle className="w-5 h-5 shrink-0" />
          <span>
            Maximum refundable on this bill:{' '}
            <strong>{formatPaiseToRupeeString(maxRefundablePaise)}</strong>
          </span>
        </div>

        {/* Refund Amount */}
        <MoneyInput
          label="Refund Amount"
          valuePaise={amountPaise}
          onChangePaise={(val) => {
            setAmountPaise(val);
            setError(null);
          }}
          maxPaise={maxRefundablePaise}
          exactAmountPaise={maxRefundablePaise}
        />

        {/* Refund Method */}
        <div className="space-y-1.5">
          <label className="text-xs font-bold text-content-secondary uppercase tracking-wider block">
            Refund Payout Method
          </label>
          <SegmentedControl
            value={method}
            onChange={(m) => setMethod(m as typeof method)}
            options={[
              { value: 'cash', label: 'Cash' },
              { value: 'upi', label: 'UPI Payout' },
              { value: 'card', label: 'Card Reversal' },
            ]}
          />
        </div>

        {/* Reason Input */}
        <div className="space-y-1.5">
          <label className="text-xs font-bold text-content-secondary uppercase tracking-wider block">
            Reason For Refund *
          </label>
          <textarea
            required
            rows={2}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setError(null);
            }}
            placeholder="e.g. Order cancelled, quality dispute, accidental overcharge..."
            className="w-full px-3.5 py-2.5 rounded-xl bg-surface-card border border-surface-border text-body text-content-primary focus:outline-none focus:border-accent"
          />
        </div>

        {/* Approver Selection & PIN (Optional/Elevation) */}
        {approvers.length > 0 && (
          <div className="p-3.5 rounded-xl bg-surface-card border border-surface-border space-y-3">
            <div className="text-xs font-bold text-content-secondary uppercase tracking-wider flex items-center gap-1.5">
              <UserCheck className="w-3.5 h-3.5 text-accent" />
              <span>Manager / Owner Authorization</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-content-muted block mb-1">Approver</label>
                <select
                  value={selectedApproverId}
                  onChange={(e) => setSelectedApproverId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-surface-elevated border border-surface-border text-xs text-content-primary focus:outline-none focus:border-accent"
                >
                  <option value="">Select Approver</option>
                  {approvers.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} ({u.role})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-content-muted block mb-1">PIN</label>
                <div className="relative">
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={6}
                    placeholder="••••"
                    value={pin}
                    onChange={(e) => setPin(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-surface-elevated border border-surface-border text-xs text-content-primary font-mono focus:outline-none focus:border-accent"
                  />
                  <KeyRound className="w-3.5 h-3.5 text-content-muted absolute right-2.5 top-2.5" />
                </div>
              </div>
            </div>
          </div>
        )}

        {error && (
          <p className="text-xs font-bold text-red-400 bg-red-500/10 p-2.5 rounded-lg border border-red-500/30">
            {error}
          </p>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 pt-3 border-t border-surface-border">
          <Button variant="ghost" size="md" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="danger"
            size="md"
            isLoading={isSubmitting}
            leftIcon={<RotateCcw className="w-4 h-4" />}
          >
            Confirm Refund ({formatPaiseToRupeeString(amountPaise)})
          </Button>
        </div>
      </form>
    </Dialog>
  );
};
