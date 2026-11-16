import { MS_MESSAGE_TYPES, TEXT_MESSAGE_TYPE, infraUpdatePayloadSchema, journeyStatusPayloadSchema, sosAlertPayloadSchema, systemNoticePayloadSchema, type InfraUpdatePayload, type TripStatus } from '@mahilasathi/shared';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'error';

/** Provider-neutral message shown by the UI. */
export interface ChatMessage {
  /** Provider message id (relay row id or Nexconn messageId). Local id while pending. */
  id: string;
  channelId: string;
  senderPublicId: string | null;
  sentAt: number;
  kind: 'text' | 'infra_update' | 'journey' | 'sos' | 'system' | 'unsupported';
  text: string;
  infra?: InfraUpdatePayload;
  journey?: { tripId: string; status: TripStatus };
  sos?: { sosId: string; status: 'ACTIVE' | 'RESOLVED' | 'CANCELLED' };
  status: 'sent' | 'pending' | 'failed';
  error?: string;
  /** Monotonic cursor for the development relay. */
  seq?: number;
}

export interface ChannelRef {
  id: string;
  providerChannelId: string;
}

/** The single seam between the UI and a chat backend (Nexconn SDK or the development relay). */
export interface ChatTransport {
  readonly mode: 'nexconn' | 'dev-relay';
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onStatus(listener: (state: ConnectionState) => void): () => void;
  /** Delivers live messages for one channel until unsubscribed. */
  subscribe(channel: ChannelRef, listener: (messages: ChatMessage[]) => void): () => void;
  /** Older messages, oldest first. */
  loadHistory(channel: ChannelRef, before?: ChatMessage): Promise<ChatMessage[]>;
  sendText(channel: ChannelRef, text: string): Promise<ChatMessage>;
}

/** Normalises a message from either provider. Unknown or invalid MS: payloads are never rendered raw. */
export function toChatMessage(input: {
  id: string;
  channelId: string;
  senderPublicId: string | null;
  sentAt: number;
  messageType: string;
  content: unknown;
  seq?: number;
}): ChatMessage {
  const base = { id: input.id, channelId: input.channelId, senderPublicId: input.senderPublicId, sentAt: input.sentAt, status: 'sent' as const, ...(input.seq !== undefined ? { seq: input.seq } : {}) };
  const c = (input.content ?? {}) as Record<string, unknown>;
  if (input.messageType === TEXT_MESSAGE_TYPE) return { ...base, kind: 'text', text: String(c.text ?? c.content ?? '') };
  if (input.messageType === MS_MESSAGE_TYPES.infraUpdate) {
    const parsed = infraUpdatePayloadSchema.safeParse(c);
    if (parsed.success) return { ...base, kind: 'infra_update', text: parsed.data.note, infra: parsed.data };
  }
  if (input.messageType === MS_MESSAGE_TYPES.journeyStatus) {
    const parsed = journeyStatusPayloadSchema.safeParse(c);
    if (parsed.success) return { ...base, kind: 'journey', text: parsed.data.text, journey: { tripId: parsed.data.tripId, status: parsed.data.status } };
  }
  if (input.messageType === MS_MESSAGE_TYPES.sosAlert) {
    const parsed = sosAlertPayloadSchema.safeParse(c);
    if (parsed.success) return { ...base, kind: 'sos', text: parsed.data.text, sos: { sosId: parsed.data.sosId, status: parsed.data.status } };
  }
  if (input.messageType === MS_MESSAGE_TYPES.systemNotice) {
    const parsed = systemNoticePayloadSchema.safeParse(c);
    if (parsed.success) return { ...base, kind: 'system', text: parsed.data.text };
  }
  return { ...base, kind: 'unsupported', text: 'This message type isn’t supported in this version.' };
}
