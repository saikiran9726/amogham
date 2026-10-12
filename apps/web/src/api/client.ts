import type { HealthResponse, VersionResponse } from '@restaurant-os/shared';
import { useAuthStore, requestExclusiveRefresh } from '../stores/useAuthStore.js';
import { useConnectionStore } from '../stores/useConnectionStore.js';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000';
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_IDEMPOTENT_RETRIES = 2;
const BASE_RETRY_DELAY_MS = 300;

export interface ApiErrorDetails {
  code?: string;
  fieldErrors?: Record<string, string[]>;
  [key: string]: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly endpoint?: string;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(
    message: string,
    options: {
      status: number;
      code?: string;
      endpoint?: string;
      details?: unknown;
      requestId?: string;
    },
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status;
    this.code = options.code;
    this.endpoint = options.endpoint;
    this.details = options.details;
    this.requestId = options.requestId;
  }
}

export interface ApiFetchOptions extends RequestInit {
  timeoutMs?: number;
  idempotencyKey?: string;
  retryIdempotent?: boolean;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Unified HTTP client with:
 * - 15 s AbortController timeout
 * - Retry with exponential backoff for idempotent GETs
 * - Typed ApiError
 * - Automatic Idempotency-Key support
 * - Session refresh integration
 */
export async function apiFetch<T = unknown>(
  url: string,
  options: ApiFetchOptions = {},
): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();
  const isIdempotentGet = method === 'GET';
  const shouldRetry = options.retryIdempotent ?? isIdempotentGet;
  const maxAttempts = shouldRetry ? MAX_IDEMPOTENT_RETRIES + 1 : 1;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let attempt = 0;
  let lastError: unknown = null;

  while (attempt < maxAttempts) {
    attempt++;
    const abortController = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    // Handle user signal if provided
    const combinedSignal = abortController.signal;
    if (options.signal) {
      if (options.signal.aborted) {
        throw options.signal.reason ?? new Error('Request aborted');
      }
      options.signal.addEventListener('abort', () => abortController.abort(options.signal?.reason), {
        once: true,
      });
    }

    // Set 15s timeout
    timeoutId = setTimeout(() => {
      abortController.abort(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      let token = useAuthStore.getState().accessToken;
      const baseUrl = useConnectionStore.getState().getBaseUrl();
      const fullUrl = url.startsWith('http') ? url : `${baseUrl}${url}`;

      const headers = new Headers(options.headers || {});
      headers.set('Accept', 'application/json');

      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
      }

      // Automatic Idempotency-Key if provided
      if (options.idempotencyKey && !headers.has('Idempotency-Key')) {
        headers.set('Idempotency-Key', options.idempotencyKey);
      }

      let res = await fetch(fullUrl, {
        ...options,
        headers,
        credentials: 'include',
        signal: combinedSignal,
      });

      // Handle 401 Unauthorized token refresh
      if (res.status === 401 && useAuthStore.getState().isAuthenticated) {
        const refreshed = await requestExclusiveRefresh();
        if (refreshed) {
          token = useAuthStore.getState().accessToken;
          if (token) {
            headers.set('Authorization', `Bearer ${token}`);
          }
          res = await fetch(fullUrl, {
            ...options,
            headers,
            credentials: 'include',
            signal: combinedSignal,
          });
        } else {
          useAuthStore.getState().setSessionExpiredModalOpen(true);
          throw new ApiError('Session expired', {
            status: 401,
            code: 'SESSION_EXPIRED',
            endpoint: url.split('?')[0],
          });
        }
      }

      // If server error 5xx and idempotent GET, retry with exponential backoff
      if (res.status >= 500 && shouldRetry && attempt < maxAttempts) {
        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        await wait(delay);
        continue;
      }

      const json = await res.json().catch(() => null);

      if (!res.ok) {
        const errorMessage = json?.error?.message || `Request failed with status ${res.status}`;
        const errorCode = json?.error?.code;
        const errorDetails = json?.error?.details;
        const requestId = res.headers.get('x-request-id') || undefined;

        throw new ApiError(errorMessage, {
          status: res.status,
          code: errorCode,
          endpoint: url.split('?')[0],
          details: errorDetails,
          requestId,
        });
      }

      return json as T;
    } catch (err: unknown) {
      lastError = err;

      // Do not retry client 4xx or intentional aborts by caller
      if (err instanceof ApiError && err.status < 500) {
        throw err;
      }
      if (options.signal?.aborted) {
        throw err;
      }

      // Retry network failure or 5xx on idempotent GET
      if (shouldRetry && attempt < maxAttempts) {
        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        await wait(delay);
        continue;
      }

      throw err;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  throw lastError;
}

export async function fetchHealth(): Promise<{ data: HealthResponse; latencyMs: number }> {
  const start = performance.now();
  const data = await apiFetch<HealthResponse>(`${API_BASE}/health`, { retryIdempotent: false });
  const latencyMs = Math.round(performance.now() - start);
  return { data, latencyMs };
}

export async function fetchVersion(): Promise<VersionResponse> {
  return await apiFetch<VersionResponse>(`${API_BASE}/version`, { retryIdempotent: false });
}
