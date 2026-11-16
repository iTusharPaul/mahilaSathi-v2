import type { ChatSession } from '@mahilasathi/shared';
import { toChatMessage, type ChannelRef, type ChatMessage, type ChatTransport, type ConnectionState } from './types';

type Sdk = typeof import('@nexconn/chat');

const HANDLER_ID = 'mahilasathi';
const PAGE_SIZE = 30;
let initialisedWithKey: string | null = null;

/**
 * Nexconn transport, built only on documented SDK calls (@nexconn/chat 26.2.1):
 * NCEngine.initialize / registerCustomMessages / addConnectionStatusHandler / addMessageHandler /
 * connect / disconnect, GroupChannel.sendMessage(SendTextMessageParams), BaseChannel.createMessagesQuery.
 * The SDK is loaded on demand so the development build never ships it unused.
 */
export function createNexconnTransport(session: ChatSession, refreshSession: () => Promise<ChatSession>): ChatTransport {
  if (!session.nexconn) throw new Error('Nexconn session details missing');
  const statusListeners = new Set<(s: ConnectionState) => void>();
  const channelListeners = new Map<string, { channel: ChannelRef; listeners: Set<(m: ChatMessage[]) => void> }>();
  let sdk: Sdk | null = null;
  let state: ConnectionState = 'connecting';
  let current = session;

  const setState = (s: ConnectionState) => {
    if (s === state) return;
    state = s;
    statusListeners.forEach((l) => l(s));
  };

  const ourChannelId = (providerChannelId: string) =>
    [...channelListeners.values()].find((c) => c.channel.providerChannelId === providerChannelId)?.channel.id ?? null;

  function map(sdkMessage: { messageId: string; senderUserId: string; sentTime: number; messageType: string; content: unknown; channelIdentifier: { channelId: string } }, channelId: string): ChatMessage {
    return toChatMessage({
      id: sdkMessage.messageId,
      channelId,
      senderPublicId: sdkMessage.senderUserId,
      sentAt: sdkMessage.sentTime,
      messageType: sdkMessage.messageType,
      content: sdkMessage.content,
    });
  }

  /**
   * Resolves once the SDK is connected. Requests made while it is still connecting fail with code 30002
   * (seen live: history asked for on a fresh page load before the socket was up), so history and sends wait.
   */
  function whenConnected(timeoutMs = 15_000): Promise<void> {
    if (state === 'connected') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        statusListeners.delete(listener);
        reject(new Error('Community chat is still connecting. Please try again in a moment.'));
      }, timeoutMs);
      const listener = (s: ConnectionState) => {
        if (s !== 'connected') return;
        clearTimeout(timer);
        statusListeners.delete(listener);
        resolve();
      };
      statusListeners.add(listener);
    });
  }

  async function load(): Promise<Sdk> {
    if (sdk) return sdk;
    sdk = await import('@nexconn/chat');
    const { NCEngine, ConnectionStatusHandler, MessageHandler, ConnectionStatus, AreaCode, LogLevel } = sdk;
    const appKey = current.nexconn!.appKey;
    if (initialisedWithKey !== appKey) {
      // "Before using any Chat SDK features, you must call the initialization method exactly once."
      NCEngine.initialize({ appKey, areaCode: current.nexconn!.areaCode === 'na' ? AreaCode.NA : AreaCode.SG, logLevel: LogLevel.WARN });
      // Custom MS: types must be registered before connect.
      NCEngine.registerCustomMessages(current.customMessageTypes.map((t) => ({ messageType: t.messageType, isPersisted: t.isPersisted, isCounted: t.isCounted })));
      initialisedWithKey = appKey;
    }
    NCEngine.addConnectionStatusHandler(
      HANDLER_ID,
      new ConnectionStatusHandler({
        onConnectionStatusChanged({ status }) {
          if (status === ConnectionStatus.CONNECTED) setState('connected');
          else if (status === ConnectionStatus.CONNECTING) setState(state === 'connected' ? 'reconnecting' : 'connecting');
          else if (status === ConnectionStatus.SUSPENDED) setState('reconnecting'); // the SDK retries on its own
          else setState(typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'error');
        },
      }),
    );
    NCEngine.addMessageHandler(
      HANDLER_ID,
      new MessageHandler({
        onMessageReceived({ messages }) {
          const byChannel = new Map<string, ChatMessage[]>();
          for (const m of messages) {
            const channelId = ourChannelId(m.channelIdentifier.channelId);
            if (!channelId) continue;
            const list = byChannel.get(channelId) ?? [];
            list.push(map(m, channelId));
            byChannel.set(channelId, list);
          }
          for (const [channelId, list] of byChannel) channelListeners.get(channelId)?.listeners.forEach((l) => l(list));
        },
      }),
    );
    return sdk;
  }

  return {
    mode: 'nexconn',
    async connect() {
      const { NCEngine } = await load();
      setState('connecting');
      let res = await NCEngine.connect({ token: current.nexconn!.token });
      if (res.code !== 0) {
        // Tokens can expire; fetch a fresh one from our server once and retry.
        current = await refreshSession();
        res = await NCEngine.connect({ token: current.nexconn!.token });
      }
      if (res.code !== 0) {
        setState('error');
        throw new Error(`Could not connect to community chat (code ${res.code}).`);
      }
      setState('connected');
    },
    async disconnect() {
      if (!sdk) return;
      sdk.NCEngine.removeMessageHandler(HANDLER_ID);
      sdk.NCEngine.removeConnectionStatusHandler(HANDLER_ID);
      await sdk.NCEngine.disconnect();
      channelListeners.clear();
      setState('connecting');
    },
    onStatus(listener) {
      statusListeners.add(listener);
      listener(state);
      return () => statusListeners.delete(listener);
    },
    subscribe(channel, listener) {
      const entry = channelListeners.get(channel.id) ?? { channel, listeners: new Set() };
      entry.listeners.add(listener);
      channelListeners.set(channel.id, entry);
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size === 0) channelListeners.delete(channel.id);
      };
    },
    async loadHistory(channel, before) {
      const { BaseChannel, GroupChannel } = await load();
      await whenConnected();
      const query = BaseChannel.createMessagesQuery({
        channelIdentifier: new GroupChannel(channel.providerChannelId).identifier,
        startTime: before?.sentAt ?? Date.now(),
        pageSize: PAGE_SIZE,
        isAscending: false,
      });
      const res = await query.loadNextPage();
      if (res.code !== 0 || !res.data) throw new Error('Could not load messages.');
      return res.data.data.map((m) => map(m, channel.id)).sort((a, b) => a.sentAt - b.sentAt);
    },
    async sendText(channel, text) {
      const { GroupChannel, SendTextMessageParams } = await load();
      await whenConnected();
      const res = await new GroupChannel(channel.providerChannelId).sendMessage(new SendTextMessageParams({ text }));
      if (res.code !== 0 || !res.data) {
        // Includes messages refused by mahilaSathi's pre-messaging policy (contact details, rate limits, …).
        throw new Error('Message not delivered. It may break community rules, or the connection dropped.');
      }
      return map(res.data, channel.id);
    },
  };
}
