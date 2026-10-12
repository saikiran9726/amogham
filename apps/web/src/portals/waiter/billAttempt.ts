const storageKeyForOrder = (orderId: string) => `restaurant-os:bill-attempt:v1:${orderId}`;

/** Keep the bill-create retry key until a successful server response is received. */
export function getBillCreationAttemptKey(orderId: string): string {
  if (typeof window === 'undefined') {
    throw new Error('Bill retry storage is unavailable');
  }

  const storageKey = storageKeyForOrder(orderId);
  const existing = window.localStorage.getItem(storageKey);
  if (existing) return existing;

  const idempotencyKey = `bill_${orderId}_${window.crypto.randomUUID()}`;
  window.localStorage.setItem(storageKey, idempotencyKey);
  return idempotencyKey;
}

export function clearBillCreationAttemptKey(orderId: string): void {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(storageKeyForOrder(orderId));
  }
}
