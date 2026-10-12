import React, { useState } from 'react';
import { useCartStore } from '../stores/useCartStore.js';
import { CustomerSheet } from './CustomerSheet.js';
import { User, UserCheck, Tag, Plus } from 'lucide-react';

interface CustomerChipProps {
  className?: string;
  tone?: 'default' | 'inverse';
}

export const CustomerChip: React.FC<CustomerChipProps> = ({ className = '', tone = 'default' }) => {
  const { customerId, customerName, customerPhone, customerPreferences } = useCartStore();
  const [isSheetOpen, setIsSheetOpen] = useState(false);

  const displayPhone = customerPhone ? customerPhone.replace(/^\+91/, '') : '';
  const firstTag = customerPreferences?.tags?.[0];
  const inverse = tone === 'inverse';

  return (
    <>
      {customerId ? (
        <button
          type="button"
          onClick={() => setIsSheetOpen(true)}
          className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-bold shadow-sm transition-colors duration-press ${inverse ? 'border-white/20 bg-white/10 text-white hover:bg-white/15' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20'} ${className}`}
          aria-label="Edit customer"
        >
          <UserCheck
            className={`h-3.5 w-3.5 ${inverse ? 'text-brand-gold' : 'text-emerald-700'}`}
          />
          <span className="truncate max-w-[120px]">{customerName || displayPhone}</span>
          {firstTag && (
            <span
              className={`hidden items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] sm:inline-flex ${inverse ? 'bg-white/10 text-white/80' : 'bg-emerald-500/20 text-emerald-800'}`}
            >
              <Tag className="w-2.5 h-2.5" />
              {firstTag}
            </span>
          )}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setIsSheetOpen(true)}
          className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-xs font-bold transition-colors duration-press ${inverse ? 'border-white/20 bg-white/10 text-white hover:bg-white/15' : 'border-surface-border bg-surface-subtle text-content-secondary hover:bg-surface-elevated hover:text-content-primary'} ${className}`}
          aria-label="Add customer"
        >
          <Plus className={`h-3.5 w-3.5 ${inverse ? 'text-brand-gold' : 'text-primary'}`} />
          <span>Add Customer</span>
        </button>
      )}

      <CustomerSheet isOpen={isSheetOpen} onClose={() => setIsSheetOpen(false)} />
    </>
  );
};
