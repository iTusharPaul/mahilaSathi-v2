import type { CommunityRepository } from '../../repositories/communityRepository.js';
import type { NexconnServerApi } from '../nexconn/nexconnServerApi.js';

/**
 * The only boundary between community business logic and the chat vendor. Membership and moderation
 * decisions are made by mahilaSathi; providers carry them out.
 */
export interface ChatProvider {
  readonly mode: 'nexconn' | 'dev-relay';
  /** Registers/refreshes the user at the provider and returns a client token (null for the dev relay). */
  issueClientToken(chatUserId: string, displayName: string): Promise<string | null>;
  createChannel(providerChannelId: string, name: string, ownerChatUserId: string): Promise<void>;
  addMembers(providerChannelId: string, chatUserIds: string[]): Promise<void>;
  removeMembers(providerChannelId: string, chatUserIds: string[]): Promise<void>;
  archiveChannel(providerChannelId: string): Promise<void>;
  /** Sends a message the server has already validated (MS: types, system notices). Returns its id. */
  sendServerMessage(input: {
    channelId: string;
    providerChannelId: string;
    fromChatUserId: string;
    senderUserId: string | null;
    messageType: string;
    content: Record<string, unknown>;
    pushContent?: string;
  }): Promise<string>;
}

export const SYSTEM_CHAT_USER_ID = 'mssystem';

export function createNexconnProvider(api: NexconnServerApi): ChatProvider {
  return {
    mode: 'nexconn',
    issueClientToken: (chatUserId, name) => api.issueAccessToken(chatUserId, name),
    createChannel: (id, name, owner) => api.createGroup(id, name, owner),
    addMembers: (id, users) => api.joinGroup(id, users),
    removeMembers: (id, users) => api.leaveGroup(id, users),
    archiveChannel: (id) => api.dismissGroup(id),
    async sendServerMessage({ providerChannelId, fromChatUserId, messageType, content, pushContent }) {
      const id = await api.sendGroupMessage({
        fromUserId: fromChatUserId,
        channelId: providerChannelId,
        messageType,
        content: JSON.stringify(content),
        ...(pushContent ? { pushContent } : {}),
      });
      return id ?? 'unknown';
    },
  };
}

/**
 * Development relay: used only when Nexconn is not configured. Membership lives in our database (as it
 * does for Nexconn), and messages are stored in dev_chat_messages and fetched by polling. The UI and
 * /api/config label it as a development adapter; it is never presented as Nexconn.
 */
export function createDevRelayProvider(repo: CommunityRepository, clock: () => Date): ChatProvider {
  return {
    mode: 'dev-relay',
    issueClientToken: async () => null,
    createChannel: async () => undefined,
    addMembers: async () => undefined,
    removeMembers: async () => undefined,
    archiveChannel: async () => undefined,
    async sendServerMessage({ channelId, senderUserId, messageType, content }) {
      return repo.insertRelayMessage({ channelId, senderUserId, messageType, content, sentAt: clock().toISOString() }).id;
    },
  };
}
