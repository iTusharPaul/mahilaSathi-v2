import { CONTACT_INFO_MESSAGE, containsContactInfo } from '@mahilasathi/shared';
import {
  MAX_TEXT_LENGTH,
  MS_PAYLOAD_SCHEMAS,
  SERVER_ONLY_MESSAGE_TYPES,
  TEXT_MESSAGE_TYPE,
} from '@mahilasathi/shared';
import type { ChannelRow, CommunityRepository } from '../../repositories/communityRepository.js';
import type { SafetyRepository } from '../../repositories/safetyRepository.js';
import type { UserRow } from '../../repositories/userRepository.js';
import type { Clock } from '../../utils/crypto.js';

export type PolicyResult = { allowed: true } | { allowed: false; code: PolicyCode; message: string };

export type PolicyCode =
  | 'not_member'
  | 'archived'
  | 'suspended'
  | 'rate_limited'
  | 'duplicate'
  | 'contact_info'
  | 'new_account_link'
  | 'too_long'
  | 'invalid_payload'
  | 'unsupported_type';

export const POLICY = {
  perMinute: 10,
  perHour: 120,
  duplicateWindowMs: 10 * 60_000,
  duplicateLimit: 2,
  newAccountMs: 24 * 60 * 60_000,
  autoSuspendReporters: 3,
  autoSuspendWindowMs: 24 * 60 * 60_000,
  autoSuspendMs: 24 * 60 * 60_000,
} as const;

// Personal contact details and precise locations are blocked outside private Guardian Circles.
const LINK = /(https?:\/\/|www\.)\S+/i;

// The detector lives in the shared package so the client applies the same rule before sending.
export { containsContactInfo };

const normalise = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();

/** Extracts the user-visible text from a message for content checks. */
export function messageText(messageType: string, content: unknown): string {
  if (typeof content !== 'object' || content === null) return '';
  const c = content as Record<string, unknown>;
  if (messageType === TEXT_MESSAGE_TYPE) return String(c.content ?? c.text ?? '');
  return Object.values(c).filter((v) => typeof v === 'string').join(' ');
}

/**
 * Decides whether `user` may post `messageType`/`content` to `channel`. Pure apart from an in-memory
 * sliding-window counter (single instance; move to a shared store when scaling out).
 */
export function createMessagePolicy(deps: { community: CommunityRepository; safety: SafetyRepository; clock: Clock }) {
  const sent = new Map<string, number[]>();
  const recentTexts = new Map<string, { text: string; at: number }[]>();

  return {
    evaluate(input: { user: UserRow; channel: ChannelRow; messageType: string; content: unknown; viaServer?: boolean }): PolicyResult {
      const { user, channel, messageType, content } = input;
      const now = deps.clock().getTime();

      if (!deps.community.isActiveMember(channel.id, user.id)) {
        return { allowed: false, code: 'not_member', message: 'You’re not a member of this channel.' };
      }
      if (channel.status !== 'active') {
        return { allowed: false, code: 'archived', message: 'This room has ended. Messages can no longer be sent.' };
      }
      const suspendedUntil = deps.safety.suspendedUntil(user.id);
      if (suspendedUntil && Date.parse(suspendedUntil) > now && channel.kind !== 'guardian_circle') {
        return {
          allowed: false,
          code: 'suspended',
          message: `You can’t post in community channels until ${new Date(suspendedUntil).toUTCString()} while reports are reviewed.`,
        };
      }

      if (SERVER_ONLY_MESSAGE_TYPES.includes(messageType) && !input.viaServer) {
        return { allowed: false, code: 'unsupported_type', message: 'This message type can only be sent by mahilaSathi.' };
      }
      if (messageType !== TEXT_MESSAGE_TYPE) {
        const schema = MS_PAYLOAD_SCHEMAS[messageType];
        if (!schema) return { allowed: false, code: 'unsupported_type', message: 'This message type isn’t supported.' };
        if (!schema.safeParse(content).success) return { allowed: false, code: 'invalid_payload', message: 'This update isn’t valid.' };
      }

      const text = messageText(messageType, content);
      if (text.length > MAX_TEXT_LENGTH) return { allowed: false, code: 'too_long', message: `Messages can be up to ${MAX_TEXT_LENGTH} characters.` };

      if (channel.kind !== 'guardian_circle') {
        if (containsContactInfo(text)) {
          return {
            allowed: false,
            code: 'contact_info',
            message: CONTACT_INFO_MESSAGE,
          };
        }
        if (LINK.test(text) && now - Date.parse(user.created_at) < POLICY.newAccountMs) {
          return { allowed: false, code: 'new_account_link', message: 'New accounts can’t post links for the first 24 hours.' };
        }
      }

      const times = (sent.get(user.id) ?? []).filter((t) => now - t < 60 * 60_000);
      if (times.filter((t) => now - t < 60_000).length >= POLICY.perMinute || times.length >= POLICY.perHour) {
        return { allowed: false, code: 'rate_limited', message: 'You’re sending messages too quickly. Please wait a moment.' };
      }

      const key = normalise(text);
      const texts = (recentTexts.get(user.id) ?? []).filter((t) => now - t.at < POLICY.duplicateWindowMs);
      if (key.length > 0 && texts.filter((t) => t.text === key).length >= POLICY.duplicateLimit) {
        return { allowed: false, code: 'duplicate', message: 'You’ve already posted this message.' };
      }

      times.push(now);
      sent.set(user.id, times);
      if (key) texts.push({ text: key, at: now });
      recentTexts.set(user.id, texts);
      return { allowed: true };
    },
  };
}

export type MessagePolicy = ReturnType<typeof createMessagePolicy>;
