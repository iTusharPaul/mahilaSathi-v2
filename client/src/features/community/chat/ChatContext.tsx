import type { ChatSession } from '@mahilasathi/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { communityApi } from '@/services/communityApi';
import { createDevRelayTransport } from './devRelayTransport';
import { createNexconnTransport } from './nexconnTransport';
import type { ChatTransport, ConnectionState } from './types';

interface ChatContextValue {
  transport: ChatTransport | null;
  session: ChatSession | null;
  state: ConnectionState;
  error: string | null;
}

const ChatContext = createContext<ChatContextValue>({ transport: null, session: null, state: 'connecting', error: null });
export const chatSessionKey = ['community', 'session'] as const;

/**
 * Owns the single chat connection for the signed-in user. Connects lazily when a community screen
 * mounts it, reconnects when the browser comes back online, and disconnects on unmount (e.g. sign-out).
 */
export function ChatProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const session = useQuery({ queryKey: chatSessionKey, queryFn: communityApi.session, staleTime: Infinity, retry: 2 });
  const [state, setState] = useState<ConnectionState>('connecting');
  const [error, setError] = useState<string | null>(null);

  const transport = useMemo(() => {
    if (!session.data) return null;
    return session.data.mode === 'nexconn'
      ? createNexconnTransport(session.data, () => qc.fetchQuery({ queryKey: chatSessionKey, queryFn: communityApi.session, staleTime: 0 }))
      : createDevRelayTransport();
  }, [session.data, qc]);

  useEffect(() => {
    if (!transport) return;
    const off = transport.onStatus(setState);
    let cancelled = false;
    const connect = () =>
      transport.connect().then(
        () => !cancelled && setError(null),
        (err: Error) => !cancelled && setError(err.message),
      );
    void connect();
    const online = () => void connect();
    window.addEventListener('online', online);
    return () => {
      cancelled = true;
      off();
      window.removeEventListener('online', online);
      void transport.disconnect();
    };
  }, [transport]);

  const value = useMemo(
    () => ({ transport, session: session.data ?? null, state: session.isError ? ('error' as const) : state, error: session.error?.message ?? error }),
    [transport, session.data, session.isError, session.error, state, error],
  );
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export const useChat = () => useContext(ChatContext);
