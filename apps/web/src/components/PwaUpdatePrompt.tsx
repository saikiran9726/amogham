import React, { useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { useCartStore } from '../stores/useCartStore.js';
import { useOutboxStore } from '../stores/useOutboxStore.js';
import { RefreshCw, X } from 'lucide-react';

export function PwaUpdatePrompt(): React.JSX.Element | null {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegistered(r) {
      if (import.meta.env.DEV) {
        console.log('[PWA] Service worker registered:', r);
      }
    },
    onRegisterError(error) {
      console.error('[PWA] Service worker registration error:', error);
    },
  });

  const cartLength = useCartStore((state) => state.items.length);
  const pendingOutbox = useOutboxStore((state) => state.pendingCount);

  const [dismissed, setDismissed] = useState(false);

  // Defer showing the update prompt when cart or outbox is non-empty
  const hasActiveWork = cartLength > 0 || pendingOutbox > 0;
  const shouldShow = needRefresh && !hasActiveWork && !dismissed;

  if (!shouldShow) {
    return null;
  }

  return (
    <div
      role="alert"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 flex items-center gap-3 p-4 bg-surface-elevated border border-border-default rounded-xl shadow-2xl max-w-sm text-content-primary"
    >
      <RefreshCw className="w-5 h-5 text-interactive-primary shrink-0 animate-spin" />
      <div className="flex-1 text-sm">
        <p className="font-semibold text-content-primary">Update Available</p>
        <p className="text-content-secondary text-xs">A new version is ready. Update now?</p>
      </div>
      <button
        type="button"
        onClick={() => void updateServiceWorker(true)}
        className="px-3 py-1.5 bg-interactive-primary text-white rounded-lg text-xs font-medium hover:bg-interactive-primary-hover active:scale-95 transition-all"
      >
        Update
      </button>
      <button
        type="button"
        aria-label="Dismiss update notification"
        onClick={() => setDismissed(true)}
        className="p-1 text-content-secondary hover:text-content-primary rounded-md"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
