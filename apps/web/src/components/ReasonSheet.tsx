import React, { useState, useEffect } from 'react';
import { Sheet } from './ui/Overlay.js';
import { Button } from './ui/Button.js';
import { AlertTriangle, Key, UserCheck } from 'lucide-react';
import { apiFetch } from '../stores/useAuthStore.js';
import type { ApproverUser } from '@restaurant-os/shared';

interface ReasonSheetProps {
  isOpen: boolean;
  itemName: string;
  isPrepared?: boolean;
  onClose: () => void;
  onConfirm: (reason: string, managerPin?: string, approverUserId?: string) => void;
}

const QUICK_REASONS = [
  'Customer changed mind',
  'Ordered by mistake',
  'Wait time too long',
  'Table cancelled / left',
  'Food preparation issue',
];

export const ReasonSheet: React.FC<ReasonSheetProps> = ({
  isOpen,
  itemName,
  isPrepared = false,
  onClose,
  onConfirm,
}) => {
  const [selectedReason, setSelectedReason] = useState(QUICK_REASONS[0]);
  const [customReason, setCustomReason] = useState('');
  const [approvers, setApprovers] = useState<ApproverUser[]>([]);
  const [selectedApproverId, setSelectedApproverId] = useState<string>('');
  const [managerPin, setManagerPin] = useState('');

  useEffect(() => {
    if (!isOpen) {
      setManagerPin('');
      return;
    }

    let isMounted = true;
    if (isPrepared) {
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
          // Fallback gracefully
        }
      };
      void loadApprovers();
    }

    return () => {
      isMounted = false;
    };
  }, [isOpen, isPrepared, selectedApproverId]);

  const finalReason = customReason.trim() || selectedReason;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!finalReason) return;
    onConfirm(
      finalReason,
      isPrepared ? managerPin : undefined,
      isPrepared ? selectedApproverId : undefined,
    );
    onClose();
  };

  return (
    <Sheet
      isOpen={isOpen}
      onClose={onClose}
      title={`Cancel "${itemName}"`}
      description="Select reason for cancellation after sending to kitchen."
    >
      <form onSubmit={handleSubmit} className="space-y-5 pt-2">
        {isPrepared && (
          <div className="p-3.5 rounded-xl bg-amber-500/15 border border-amber-500/40 text-amber-700 dark:text-amber-300 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 shrink-0 text-amber-500 mt-0.5" />
            <div className="text-caption">
              <span className="font-bold block">Item Already Prepared</span>
              Kitchen has completed this item. An Owner or Manager PIN is required to proceed with
              cancellation.
            </div>
          </div>
        )}

        <div>
          <label className="text-caption font-semibold text-content-secondary block mb-2">
            Quick Reason
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {QUICK_REASONS.map((reason) => (
              <button
                key={reason}
                type="button"
                onClick={() => {
                  setSelectedReason(reason);
                  setCustomReason('');
                }}
                className={`p-2.5 rounded-xl border text-left text-caption font-medium transition-all ${
                  selectedReason === reason && !customReason
                    ? 'bg-accent/15 border-accent text-accent font-bold'
                    : 'bg-surface-elevated border-surface-border text-content-secondary hover:bg-surface-canvas'
                }`}
              >
                {reason}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-caption font-semibold text-content-secondary block mb-1">
            Or Custom Reason
          </label>
          <input
            type="text"
            placeholder="Type cancellation note..."
            value={customReason}
            onChange={(e) => setCustomReason(e.target.value)}
            className="w-full text-body px-3.5 py-2.5 rounded-xl bg-surface-card border border-surface-border text-content-primary focus:outline-none focus:border-accent"
          />
        </div>

        {isPrepared && (
          <div className="space-y-3 p-3.5 rounded-xl bg-surface-card border border-surface-border">
            <div className="text-xs font-bold text-content-secondary uppercase tracking-wider flex items-center gap-1.5">
              <UserCheck className="w-3.5 h-3.5 text-accent" />
              <span>Approver Authorization</span>
            </div>
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
              <label className="text-caption font-semibold text-content-secondary flex items-center gap-1.5 mb-1">
                <Key className="w-4 h-4 text-accent" />
                <span>Approver PIN (4-6 digits)</span>
              </label>
              <input
                type="password"
                inputMode="numeric"
                maxLength={6}
                placeholder="••••"
                value={managerPin}
                onChange={(e) => setManagerPin(e.target.value)}
                className="w-full text-title font-mono tracking-widest text-center px-4 py-2.5 rounded-xl bg-surface-elevated border border-surface-border text-content-primary focus:outline-none focus:border-accent"
                required
              />
            </div>
          </div>
        )}

        <div className="pt-3 border-t border-surface-border flex gap-3">
          <Button variant="ghost" className="flex-1" type="button" onClick={onClose}>
            Back
          </Button>
          <Button
            variant="danger"
            className="flex-1"
            size="lg"
            type="submit"
            disabled={!finalReason || (isPrepared && (!managerPin || !selectedApproverId))}
          >
            Confirm Cancel
          </Button>
        </div>
      </form>
    </Sheet>
  );
};
