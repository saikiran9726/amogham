import React, { useState, useEffect } from 'react';
import { Dialog } from './ui/Overlay.js';
import { Button } from './ui/Button.js';
import { KeyRound, ShieldAlert, UserCheck } from 'lucide-react';
import { apiFetch } from '../stores/useAuthStore.js';
import type { ApproverUser } from '@restaurant-os/shared';

export interface PinOverrideData {
  approverUserId: string;
  pin: string;
}

interface PinOverrideDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (data: PinOverrideData) => Promise<void> | void;
  title?: string;
  description?: string;
  isSubmitting?: boolean;
}

export const PinOverrideDialog: React.FC<PinOverrideDialogProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title = 'Approver PIN Required',
  description = 'This action exceeds permitted staff limits and requires Owner or Manager authorization.',
  isSubmitting = false,
}) => {
  const [approvers, setApprovers] = useState<ApproverUser[]>([]);
  const [selectedApproverId, setSelectedApproverId] = useState<string>('');
  const [isLoadingApprovers, setIsLoadingApprovers] = useState(false);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setPin('');
      setError(null);
      return;
    }

    let isMounted = true;
    const loadApprovers = async () => {
      setIsLoadingApprovers(true);
      try {
        const list = await apiFetch<ApproverUser[]>('/staff/approvers');
        if (isMounted) {
          const approversList = Array.isArray(list) ? list : [];
          setApprovers(approversList);
          if (approversList.length > 0 && !selectedApproverId) {
            const first = approversList[0];
            if (first) {
              setSelectedApproverId(first.id);
            }
          }
        }
      } catch (err: unknown) {
        if (isMounted) {
          setError(err instanceof Error ? err.message : 'Failed to load authorized approvers');
        }
      } finally {
        if (isMounted) {
          setIsLoadingApprovers(false);
        }
      }
    };

    void loadApprovers();
    return () => {
      isMounted = false;
    };
  }, [isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedApproverId) {
      setError('Please select an authorized approver');
      return;
    }
    if (pin.length < 4 || pin.length > 6) {
      setError('PIN must be 4 to 6 digits');
      return;
    }
    setError(null);
    try {
      await onConfirm({ approverUserId: selectedApproverId, pin });
      setPin('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Invalid PIN or unauthorized');
    }
  };

  const handleDigit = (digit: string) => {
    if (pin.length < 6) {
      setPin((prev) => prev + digit);
      setError(null);
    }
  };

  const handleBackspace = () => {
    setPin((prev) => prev.slice(0, -1));
    setError(null);
  };

  return (
    <Dialog isOpen={isOpen} onClose={onClose} title={title} description={description} size="sm">
      <form onSubmit={handleSubmit} className="space-y-4 pt-1">
        <div className="flex items-center justify-center p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400 gap-2.5 text-xs font-semibold">
          <ShieldAlert className="w-5 h-5 shrink-0" />
          <span>Action will be recorded in the security audit trail.</span>
        </div>

        {/* Approver Selection Dropdown */}
        <div className="space-y-1.5">
          <label className="text-xs font-bold text-content-secondary uppercase tracking-wider flex items-center gap-1.5">
            <UserCheck className="w-3.5 h-3.5 text-accent" />
            <span>Select Approver</span>
          </label>
          <select
            value={selectedApproverId}
            onChange={(e) => {
              setSelectedApproverId(e.target.value);
              setError(null);
            }}
            disabled={isLoadingApprovers || isSubmitting}
            className="w-full px-3.5 py-2.5 rounded-xl bg-surface-card border border-surface-border text-body text-content-primary focus:outline-none focus:border-accent disabled:opacity-50"
          >
            {approvers.length === 0 ? (
              <option value="">
                {isLoadingApprovers ? 'Loading approvers...' : 'No approvers found'}
              </option>
            ) : (
              approvers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.role})
                </option>
              ))
            )}
          </select>
        </div>

        {/* Masked PIN Display */}
        <div className="flex justify-center gap-3 py-1">
          {[0, 1, 2, 3, 4, 5].map((idx) => {
            const hasDigit = idx < pin.length;
            return (
              <div
                key={idx}
                className={`w-10 h-12 rounded-xl border-2 flex items-center justify-center font-mono text-xl font-black transition-all ${
                  hasDigit
                    ? 'border-accent bg-accent/20 text-content-primary'
                    : 'border-surface-border bg-surface-card text-transparent'
                }`}
              >
                {hasDigit ? '•' : ''}
              </div>
            );
          })}
        </div>

        {error && <p className="text-xs text-red-400 text-center font-bold">{error}</p>}

        {/* Numeric Keypad for fast tablet/touch interaction */}
        <div className="grid grid-cols-3 gap-2.5 max-w-[260px] mx-auto select-none">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
            <button
              key={digit}
              type="button"
              onClick={() => handleDigit(digit)}
              className="h-12 rounded-xl bg-surface-elevated hover:bg-surface-border text-title font-mono font-bold text-content-primary active:scale-95 transition-all"
            >
              {digit}
            </button>
          ))}
          <button
            type="button"
            onClick={handleBackspace}
            className="h-12 rounded-xl bg-surface-elevated hover:bg-surface-border text-xs font-bold text-content-secondary active:scale-95 transition-all"
          >
            Del
          </button>
          <button
            type="button"
            onClick={() => handleDigit('0')}
            className="h-12 rounded-xl bg-surface-elevated hover:bg-surface-border text-title font-mono font-bold text-content-primary active:scale-95 transition-all"
          >
            0
          </button>
          <button
            type="button"
            onClick={() => setPin('')}
            className="h-12 rounded-xl bg-surface-elevated hover:bg-surface-border text-xs font-bold text-content-secondary active:scale-95 transition-all"
          >
            Clear
          </button>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center justify-end gap-3 pt-3 border-t border-surface-border">
          <Button variant="ghost" size="md" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="md"
            isLoading={isSubmitting}
            disabled={pin.length < 4 || !selectedApproverId}
            leftIcon={<KeyRound className="w-4 h-4" />}
          >
            Authorize
          </Button>
        </div>
      </form>
    </Dialog>
  );
};
