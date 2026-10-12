import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiFetch, ApiError } from '../client.js';

describe('Unified apiFetch Client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('successfully fetches and parses JSON response', async () => {
    const mockData = { id: 'order-123', totalPaise: 5000 };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => mockData,
    } as unknown as Response);

    const result = await apiFetch<typeof mockData>('/orders/order-123');
    expect(result).toEqual(mockData);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('attaches Idempotency-Key if provided in options', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ status: 'created' }),
    } as unknown as Response);

    await apiFetch('/orders', {
      method: 'POST',
      idempotencyKey: 'idemp-xyz-123',
    });

    const callArgs = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const headers = (callArgs[1] as { headers: Headers }).headers;
    expect(headers.get('Idempotency-Key')).toBe('idemp-xyz-123');
  });

  it('retries idempotent GET requests on 500 status with backoff', async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount < 3) {
        return Promise.resolve({
          ok: false,
          status: 503,
          headers: new Headers(),
          json: async () => ({ error: { message: 'Service Unavailable' } }),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ success: true }),
      } as unknown as Response);
    });

    const result = await apiFetch<{ success: boolean }>('/menu', { method: 'GET' });
    expect(result).toEqual({ success: true });
    expect(callCount).toBe(3);
  });

  it('throws typed ApiError without retrying on client 4xx', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers({ 'x-request-id': 'req-999' }),
      json: async () => ({ error: { message: 'Item not found', code: 'ITEM_NOT_FOUND' } }),
    } as unknown as Response);

    await expect(apiFetch('/menu/unknown')).rejects.toThrow(ApiError);

    try {
      await apiFetch('/menu/unknown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(404);
      expect(apiErr.code).toBe('ITEM_NOT_FOUND');
      expect(apiErr.requestId).toBe('req-999');
    }
  });

  it('aborts on timeout when request exceeds timeoutMs', async () => {
    global.fetch = vi.fn().mockImplementation((_url, options) => {
      return new Promise((_resolve, reject) => {
        const signal = options?.signal as AbortSignal;
        signal?.addEventListener('abort', () => {
          reject(new Error('Request timed out'));
        });
      });
    });

    await expect(
      apiFetch('/slow-endpoint', {
        timeoutMs: 50,
        retryIdempotent: false,
      }),
    ).rejects.toThrow(/timed out|aborted/i);
  });
});
