import { useSocketStore } from '../stores/useSocketStore.js';

export const DISCONNECTED_FALLBACK_POLL_INTERVAL_MS = 60_000;

/**
 * Returns false when the realtime socket is connected (disabling polling in favor of socket events),
 * or the fallback interval (default 60,000ms = 60s) when the socket is disconnected.
 */
export function getSocketFallbackPollInterval(
  isConnected?: boolean,
  fallbackMs: number = DISCONNECTED_FALLBACK_POLL_INTERVAL_MS,
): number | false {
  try {
    const connected =
      isConnected !== undefined
        ? isConnected
        : typeof useSocketStore?.getState === 'function'
          ? (useSocketStore.getState()?.isConnected ?? false)
          : false;
    return connected ? false : fallbackMs;
  } catch {
    return fallbackMs;
  }
}

/**
 * React hook returning false when connected, or 60,000ms when disconnected.
 */
export function useSocketFallbackPollInterval(
  fallbackMs: number = DISCONNECTED_FALLBACK_POLL_INTERVAL_MS,
): number | false {
  try {
    if (typeof useSocketStore === 'function') {
      const isConnected = useSocketStore((state) => state?.isConnected ?? false);
      return isConnected ? false : fallbackMs;
    }
  } catch {
    // Return fallback if store is uninitialized or partially mocked in unit tests
  }
  return fallbackMs;
}
