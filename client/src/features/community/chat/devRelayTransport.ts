import { ApiRequestError } from '@/services/apiClient';
import { communityApi } from '@/services/communityApi';
import { toChatMessage, type ChannelRef, type ChatMessage, type ChatTransport, type ConnectionState } from './types';

const POLL_MS = 3000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Development relay transport: messages go through the mahilaSathi server and are fetched by polling.
 * Used only when Nexconn is not configured; the UI labels it as such.
 */
export function createDevRelayTransport(): ChatTransport {
  const statusListeners = new Set<(s: ConnectionState) => void>();
  let state: ConnectionState = 'connecting';
  const setState = (s: ConnectionState) => {
    if (s === state) return;
    state = s;
    statusListeners.forEach((l) => l(s));
  };

  const subs = new Map<string, { channel: ChannelRef; cursor: number | null; listeners: Set<(m: ChatMessage[]) => void> }>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let running = false;

  const toMessages = (rows: Awaited<ReturnType<typeof communityApi.relayMessages>>['messages']) =>
    rows.map((r) => toChatMessage({ id: r.id, channelId: r.channelId, senderPublicId: r.senderPublicId, sentAt: Date.parse(r.sentAt), messageType: r.messageType, content: r.content, seq: r.seq }));

  async function pollOnce() {
    for (const sub of subs.values()) {
      if (sub.cursor === null) continue; // history not loaded yet
      const { messages } = await communityApi.relayMessages(sub.channel.id, { after: sub.cursor });
      if (messages.length) {
        sub.cursor = messages[messages.length - 1]!.seq;
        const mapped = toMessages(messages);
        sub.listeners.forEach((l) => l(mapped));
      }
    }
  }

  function schedule(delay: number) {
    if (!running) return;
    timer = setTimeout(async () => {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        setState('offline');
        return schedule(POLL_MS);
      }
      try {
        await pollOnce();
        failures = 0;
        setState('connected');
        schedule(POLL_MS);
      } catch (err) {
        // A 403 means membership ended (left/removed); stop polling that channel rather than retrying forever.
        if (err instanceof ApiRequestError && err.status === 403) {
          failures = 0;
          schedule(POLL_MS);
          return;
        }
        failures++;
        setState('reconnecting');
        schedule(Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** failures));
      }
    }, delay);
  }

  return {
    mode: 'dev-relay',
    async connect() {
      if (running) return;
      running = true;
      setState('connected');
      schedule(POLL_MS);
    },
    async disconnect() {
      running = false;
      if (timer) clearTimeout(timer);
      subs.clear();
      setState('connecting');
    },
    onStatus(listener) {
      statusListeners.add(listener);
      listener(state);
      return () => statusListeners.delete(listener);
    },
    subscribe(channel, listener) {
      const sub = subs.get(channel.id) ?? { channel, cursor: null, listeners: new Set() };
      sub.listeners.add(listener);
      subs.set(channel.id, sub);
      return () => {
        sub.listeners.delete(listener);
        if (sub.listeners.size === 0) subs.delete(channel.id);
      };
    },
    async loadHistory(channel, before) {
      const { messages } = await communityApi.relayMessages(channel.id, before?.seq !== undefined ? { before: before.seq } : {});
      const sub = subs.get(channel.id);
      if (sub && sub.cursor === null) sub.cursor = messages.length ? messages[messages.length - 1]!.seq : 0;
      return toMessages(messages);
    },
    async sendText(channel, text) {
      const res = await communityApi.sendRelayText(channel.id, text);
      const sub = subs.get(channel.id);
      // The poller will also see this message; advance the cursor so it isn't delivered twice.
      if (sub && sub.cursor !== null && res.seq === sub.cursor + 1) sub.cursor = res.seq;
      return { id: res.id, channelId: channel.id, senderPublicId: null, sentAt: Date.parse(res.sentAt), kind: 'text', text, status: 'sent', seq: res.seq };
    },
  };
}
