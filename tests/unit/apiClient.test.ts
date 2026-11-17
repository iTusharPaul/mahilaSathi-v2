import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiRequestError, apiRequest, isConnectionError } from '../../client/src/services/apiClient.js';

afterEach(() => vi.unstubAllGlobals());

/** A 200 response whose body download fails, like a connection reset after the headers arrived. */
function droppedBody(): Response {
  const body = new ReadableStream({ start: (c) => c.error(new TypeError('network error')) });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('apiRequest', () => {
  it('reports a body cut off mid-download as a connection error, not a bad response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => droppedBody()));
    const err = await apiRequest('/routes/plan', { method: 'POST', body: {}, schema: z.object({ ok: z.boolean() }) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({ status: 0, code: 'NETWORK' });
    expect(isConnectionError(err)).toBe(true);
  });

  it('still reports a complete response of the wrong shape as INVALID_RESPONSE', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ other: 1 }), { status: 200 })));
    const err = await apiRequest('/x', { schema: z.object({ ok: z.boolean() }) }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(isConnectionError(err)).toBe(false);
  });

  it('parses a normal response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
    await expect(apiRequest('/x', { schema: z.object({ ok: z.boolean() }) })).resolves.toEqual({ ok: true });
  });
});
