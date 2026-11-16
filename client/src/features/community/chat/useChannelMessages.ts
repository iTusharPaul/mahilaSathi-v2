import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { communityApi } from '@/services/communityApi';
import { useChat } from './ChatContext';
import type { ChannelRef, ChatMessage } from './types';

export const blocksKey = ['me', 'blocks'] as const;

export function useBlocks() {
  return useQuery({ queryKey: blocksKey, queryFn: communityApi.blocks, staleTime: 60_000 });
}

function merge(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map(existing.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.sentAt - b.sentAt || (a.seq ?? 0) - (b.seq ?? 0));
}

/**
 * Messages for one channel: history, live updates, optimistic sends with retry, and client-side hiding
 * of blocked users (the development relay also filters on the server; Nexconn group channels cannot).
 */
export function useChannelMessages(channel: ChannelRef | null) {
  const { transport, session, state } = useChat();
  const blocks = useBlocks();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);

  useEffect(() => {
    if (!transport || !channel) return;
    let cancelled = false;
    setMessages([]);
    setLoading(true);
    setLoadError(null);
    const off = transport.subscribe(channel, (incoming) => !cancelled && setMessages((prev) => merge(prev, incoming)));
    transport
      .loadHistory(channel)
      .then((history) => {
        if (cancelled) return;
        setMessages((prev) => merge(prev, history));
        setHasMore(history.length >= 30);
      })
      .catch((err: Error) => !cancelled && setLoadError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
      off();
    };
  }, [transport, channel?.id, channel?.providerChannelId]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadOlder = useCallback(async () => {
    if (!transport || !channel || messages.length === 0) return;
    const older = await transport.loadHistory(channel, messages[0]);
    setHasMore(older.length >= 30);
    setMessages((prev) => merge(prev, older));
  }, [transport, channel, messages]);

  const send = useCallback(
    async (text: string, retryOf?: ChatMessage) => {
      if (!transport || !channel) return;
      const localId = retryOf?.id ?? `local-${crypto.randomUUID()}`;
      const pending: ChatMessage = {
        id: localId,
        channelId: channel.id,
        senderPublicId: session?.chatUserId ?? null,
        sentAt: retryOf?.sentAt ?? Date.now(),
        kind: 'text',
        text,
        status: 'pending',
      };
      setMessages((prev) => merge(prev, [pending]));
      try {
        const sent = await transport.sendText(channel, text);
        setMessages((prev) => merge(prev.filter((m) => m.id !== localId), [{ ...sent, senderPublicId: session?.chatUserId ?? sent.senderPublicId }]));
      } catch (err) {
        setMessages((prev) => prev.map((m) => (m.id === localId ? { ...m, status: 'failed', error: (err as Error).message } : m)));
      }
    },
    [transport, channel, session?.chatUserId],
  );

  const discard = useCallback((id: string) => setMessages((prev) => prev.filter((m) => m.id !== id)), []);

  const blocked = useMemo(() => new Set((blocks.data?.blocked ?? []).map((b) => b.publicId)), [blocks.data]);
  const visible = useMemo(() => messages.filter((m) => !m.senderPublicId || !blocked.has(m.senderPublicId)), [messages, blocked]);

  return { messages: visible, loading, loadError, hasMore, loadOlder, send, discard, connection: state, me: session?.chatUserId ?? null, mode: transport?.mode ?? null };
}
