const storageKeyForBill = (billId: string) => `restaurant-os:payment-attempt:v1:${billId}`;

/**
 * Return the outstanding key for this bill, creating one only when no previous
 * attempt is pending. Only the idempotency key is persisted; payment details
 * and credentials remain in memory.
 */
export function getPaymentAttemptKey(billId: string): string {
  if (typeof window === 'undefined') {
    throw new Error('Payment retry storage is unavailable');
  }

  const storageKey = storageKeyForBill(billId);
  const existing = window.localStorage.getItem(storageKey);
  if (existing) return existing;

  const idempotencyKey = `pay_${billId}_${window.crypto.randomUUID()}`;
  window.localStorage.setItem(storageKey, idempotencyKey);
  return idempotencyKey;
}

/** Clear the pending key only after the server has returned a successful result. */
export function clearPaymentAttemptKey(billId: string): void {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(storageKeyForBill(billId));
  }
}
