import crypto from 'node:crypto';
import { z } from 'zod';

/**
 * Nexconn Chat Server API client. Endpoints and signing follow https://docs.nexconn.ai/platform-chat-api:
 *   Signature = sha1(AppSecret + Nonce + Timestamp) as lowercase hex; Timestamp in milliseconds.
 * The app secret never leaves this module, and errors never include it or the request headers.
 */

const TIMEOUT_MS = 5000;

/**
 * Hosts the Web SDK (@nexconn/engine 26.2.1) connects to from the browser, for the CSP.
 * sg: edge families from the SDK bundle (sg-light-edge, sg-b-light-edge), plus the per-app-key
 * navigation hosts (`<prefix>.sg.rongnav.com`, `<prefix>.sg.rongcfg.com`) observed in a live connection
 * on 2026-11-12. na: edge family from the SDK bundle only; not yet verified against a live app.
 */
export const NEXCONN_BROWSER_HOSTS: Record<'sg' | 'na', string[]> = {
  sg: [
    'https://*.sg-light-edge.com',
    'wss://*.sg-light-edge.com',
    'https://*.sg-b-light-edge.com',
    'wss://*.sg-b-light-edge.com',
    'https://*.sg.rongnav.com',
    'https://*.sg.rongcfg.com',
  ],
  na: ['https://*.us-light-edge.com', 'wss://*.us-light-edge.com'],
}; // Nexconn recommends switching to the backup host after a 5 s timeout.

export class NexconnApiError extends Error {
  constructor(
    message: string,
    readonly code: number | null = null,
  ) {
    super(message);
    this.name = 'NexconnApiError';
  }
}

export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function nexconnSignature(appSecret: string, nonce: string, timestamp: string): string {
  return crypto.createHash('sha1').update(appSecret + nonce + timestamp).digest('hex');
}

/** Verifies webhook headers from Nexconn (same scheme) and rejects stale timestamps to limit replay. */
export function verifyNexconnWebhook(
  appSecret: string,
  headers: { nonce?: string; timestamp?: string; signature?: string },
  nowMs: number,
  maxSkewMs = 5 * 60_000,
): boolean {
  const { nonce, timestamp, signature } = headers;
  if (!nonce || !timestamp || !signature || nonce.length > 64) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > maxSkewMs) return false;
  const expected = Buffer.from(nexconnSignature(appSecret, nonce, timestamp), 'hex');
  const given = Buffer.from(signature.toLowerCase(), 'hex');
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

const baseResponse = z.object({ code: z.number() }).passthrough();
const tokenResponse = z.object({ code: z.number(), result: z.object({ accessToken: z.string(), userId: z.string() }) });

export interface NexconnServerApi {
  issueAccessToken(userId: string, name: string): Promise<string>;
  createGroup(channelId: string, name: string, ownerUserId: string): Promise<void>;
  joinGroup(channelId: string, userIds: string[]): Promise<void>;
  leaveGroup(channelId: string, userIds: string[]): Promise<void>;
  dismissGroup(channelId: string): Promise<void>;
  sendGroupMessage(input: { fromUserId: string; channelId: string; messageType: string; content: string; pushContent?: string }): Promise<string | null>;
}

export function createNexconnServerApi(opts: {
  appKey: string;
  appSecret: string;
  hosts: string[];
  fetchImpl?: FetchFn;
}): NexconnServerApi {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchFn);

  async function post(path: string, body: unknown): Promise<z.infer<typeof baseResponse>> {
    let lastError: NexconnApiError = new NexconnApiError('Nexconn request failed');
    for (const host of opts.hosts) {
      const nonce = crypto.randomBytes(9).toString('hex').slice(0, 18);
      const timestamp = String(Date.now());
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetchImpl(`https://${host}${path}`, {
          method: 'POST',
          headers: {
            'App-Key': opts.appKey,
            Nonce: nonce,
            Timestamp: timestamp,
            Signature: nexconnSignature(opts.appSecret, nonce, timestamp),
            'X-Request-ID': crypto.randomUUID(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (res.status >= 500) {
          lastError = new NexconnApiError(`Nexconn ${path} returned HTTP ${res.status}`);
          continue; // try the backup host
        }
        const parsed = baseResponse.safeParse(await res.json().catch(() => null));
        if (!parsed.success) throw new NexconnApiError(`Nexconn ${path} returned an unexpected response`);
        if (parsed.data.code !== 0) throw new NexconnApiError(`Nexconn ${path} failed with code ${parsed.data.code}`, parsed.data.code);
        return parsed.data;
      } catch (err) {
        if (err instanceof NexconnApiError) throw err;
        lastError = new NexconnApiError(controller.signal.aborted ? `Nexconn ${path} timed out` : `Nexconn ${path} request failed`);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }

  return {
    async issueAccessToken(userId, name) {
      const res = tokenResponse.safeParse(await post('/v4/auth/access-token/issue', { userId, name }));
      if (!res.success) throw new NexconnApiError('Nexconn token response was missing the access token');
      return res.data.result.accessToken;
    },
    async createGroup(channelId, name, ownerUserId) {
      await post('/v4/group-channel/create', { channelId, name: name.slice(0, 64), owner: ownerUserId });
    },
    async joinGroup(channelId, userIds) {
      for (let i = 0; i < userIds.length; i += 100) await post('/v4/group-channel/join', { channelId, userIds: userIds.slice(i, i + 100) });
    },
    async leaveGroup(channelId, userIds) {
      for (let i = 0; i < userIds.length; i += 100) await post('/v4/group-channel/leave', { channelId, userIds: userIds.slice(i, i + 100) });
    },
    async dismissGroup(channelId) {
      await post('/v4/group-channel/dismiss', { channelId });
    },
    async sendGroupMessage({ fromUserId, channelId, messageType, content, pushContent }) {
      const res = await post('/v4/group-channel/message/send', {
        fromUserId,
        toChannelIds: [channelId],
        messageType,
        content,
        ...(pushContent ? { pushContent } : {}),
        isEchoToSender: 1,
        shouldPersist: 1,
      });
      const ids = (res as { result?: { messageIds?: { messageId?: string }[] } }).result?.messageIds;
      return ids?.[0]?.messageId ?? null;
    },
  };
}
