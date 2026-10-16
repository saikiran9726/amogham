import { describe, it, expect } from 'vitest';
import {
  getSocketFallbackPollInterval,
  DISCONNECTED_FALLBACK_POLL_INTERVAL_MS,
} from '../polling.js';

describe('Socket Fallback Polling Utility', () => {
  it('exports default fallback interval of 60,000ms', () => {
    expect(DISCONNECTED_FALLBACK_POLL_INTERVAL_MS).toBe(60_000);
  });

  it('returns false when socket is connected', () => {
    expect(getSocketFallbackPollInterval(true)).toBe(false);
  });

  it('returns fallback interval when socket is disconnected', () => {
    expect(getSocketFallbackPollInterval(false)).toBe(60_000);
    expect(getSocketFallbackPollInterval(false, 30_000)).toBe(30_000);
  });
});
