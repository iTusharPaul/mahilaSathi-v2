import { API_PREFIX, apiErrorSchema, type ErrorCode } from '@mahilasathi/shared';
import type { z } from 'zod';

const DEFAULT_TIMEOUT_MS = 15_000;

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'NETWORK' | 'TIMEOUT' | 'INVALID_RESPONSE',
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

interface RequestOptions<S extends z.ZodTypeAny> {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Validates the response so the UI never renders a shape it did not expect. */
  schema?: S;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Treat these non-2xx statuses as valid responses (e.g. 503 from /ready carries a body). */
  acceptStatuses?: number[];
  /** Extra request headers (e.g. X-Admin-Token for moderator tools). */
  headers?: Record<string, string>;
}

/** True for failures where nothing reached the app: safe to repeat a request that has no side effects twice over. */
export function isConnectionError(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === 'NETWORK';
}

export async function apiRequest<S extends z.ZodTypeAny = z.ZodUnknown>(
  path: string,
  options: RequestOptions<S> = {},
): Promise<z.infer<S>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  options.signal?.addEventListener('abort', () => controller.abort(options.signal?.reason));

  let res: Response;
  try {
    res = await fetch(`${API_PREFIX}${path}`, {
      method: options.method ?? 'GET',
      credentials: 'include',
      headers: { ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
  } catch {
    if (controller.signal.reason === 'timeout') {
      throw new ApiRequestError(0, 'TIMEOUT', 'The server took too long to respond.');
    }
    throw new ApiRequestError(0, 'NETWORK', 'Could not reach mahilaSathi. Check your connection.');
  } finally {
    clearTimeout(timeout);
  }

  let payload: unknown = null;
  if (res.status !== 204) {
    let text: string;
    try {
      text = await res.text();
    } catch {
      // The connection dropped while the body was downloading (mobile data, proxies). Report it as a network
      // error, not a malformed response, so callers that retry network errors can recover.
      throw new ApiRequestError(0, 'NETWORK', 'The connection dropped before the response arrived. Please try again.');
    }
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
  }

  if (!res.ok && !options.acceptStatuses?.includes(res.status)) {
    const parsed = apiErrorSchema.safeParse(payload);
    if (parsed.success) {
      const { code, message, requestId } = parsed.data.error;
      throw new ApiRequestError(res.status, code, message, requestId);
    }
    throw new ApiRequestError(res.status, 'INVALID_RESPONSE', `Unexpected response (${res.status}).`);
  }

  if (!options.schema) return payload as z.infer<S>;
  const result = options.schema.safeParse(payload);
  if (!result.success) {
    throw new ApiRequestError(res.status, 'INVALID_RESPONSE', 'The server sent a response this app did not expect.');
  }
  return result.data;
}
