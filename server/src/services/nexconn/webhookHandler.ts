import { z } from 'zod';
import type { Logger } from 'pino';
import type { CommunityRepository } from '../../repositories/communityRepository.js';
import type { UserRepository } from '../../repositories/userRepository.js';
import type { Clock } from '../../utils/crypto.js';
import { SYSTEM_CHAT_USER_ID } from '../community/chatProvider.js';
import type { MessagePolicy } from '../moderation/messagePolicy.js';

/**
 * Nexconn pre-messaging webhook (https://docs.nexconn.ai/platform-chat-api/webhook/message/pre-messaging).
 * Every client-sent message passes through the same policy as the development relay. The response is
 * `{ pass: 1 }` to deliver or `{ pass: 0, extra }` to block, with `extra` explaining why to the sender.
 * Nexconn delivers the original message if the webhook times out, so this must answer well within 5 s.
 */
const preMessagingItem = z
  .object({
    userId: z.string(),
    channelId: z.string(),
    channelType: z.number().optional(),
    messageType: z.string(),
    content: z.string(),
  })
  .passthrough();

const envelope = z.object({ type: z.string(), id: z.string().optional(), time: z.number().optional(), data: z.array(z.unknown()).nullable().optional() });

export type WebhookVerdict = { pass: 0; extra: string } | { pass: 1 };

export function createNexconnWebhookHandler(deps: { community: CommunityRepository; users: UserRepository; policy: MessagePolicy; clock: Clock; logger: Logger }) {
  const { community, users, policy, logger } = deps;
  const block = (code: string, message: string): WebhookVerdict => ({ pass: 0, extra: JSON.stringify({ code, message }) });

  function preMessaging(type: string, raw: unknown): WebhookVerdict {
    const item = preMessagingItem.safeParse(raw);
    if (!item.success) return block('invalid', 'Message could not be checked.');
    const { userId, channelId, messageType } = item.data;
    if (userId === SYSTEM_CHAT_USER_ID) return { pass: 1 };

    // Only group channels are used. Direct messages arrive with Walk Together (mutual consent) later.
    if (type !== 'group_channel:pre_messaging') return block('unsupported_channel', 'Direct and open channels are not available.');

    const channel = community.channelByProviderId(channelId);
    const senderId = community.userIdForChatUserId(userId);
    const sender = senderId ? users.findById(senderId) : undefined;
    if (!channel || !sender) return block('not_member', 'You’re not a member of this channel.');

    let content: unknown;
    try {
      content = JSON.parse(item.data.content);
    } catch {
      return block('invalid_payload', 'Message could not be read.');
    }
    const verdict = policy.evaluate({ user: sender, channel, messageType, content });
    if (!verdict.allowed) return block(verdict.code, verdict.message);
    community.touchChannel(channel.id, deps.clock().toISOString());
    return { pass: 1 };
  }

  return {
    handle(body: unknown): WebhookVerdict | { ok: true } {
      const parsed = envelope.safeParse(body);
      if (!parsed.success) return { ok: true };
      if (parsed.data.type.endsWith(':pre_messaging')) {
        const verdict = preMessaging(parsed.data.type, parsed.data.data?.[0]);
        if (verdict.pass === 0) logger.info({ event: parsed.data.type, eventId: parsed.data.id }, 'message blocked by policy');
        return verdict;
      }
      // Other events (post-send, moderation results, group changes) are acknowledged; not yet used.
      return { ok: true };
    },
  };
}
