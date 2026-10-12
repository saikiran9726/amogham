import { apiFetch } from '../stores/useAuthStore.js';

/** Validate and unwrap the API's standard { success: true, data } response once, before caching. */
export async function apiFetchData<T>(
  endpoint: string,
  isData: (value: unknown) => value is T,
): Promise<T> {
  const response = await apiFetch<unknown>(endpoint);
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error(`Invalid API response from ${endpoint.split('?')[0]}.`);
  }

  if (
    !('success' in response) ||
    response.success !== true ||
    !('data' in response) ||
    !isData(response.data)
  ) {
    throw new Error(`Invalid API response from ${endpoint.split('?')[0]}.`);
  }

  return response.data;
}

export function isArrayOf<T>(isItem: (value: unknown) => value is T) {
  return (value: unknown): value is T[] => Array.isArray(value) && value.every(isItem);
}
