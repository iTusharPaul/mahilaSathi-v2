import crypto from 'node:crypto';
import {
  MS_MESSAGE_REGISTRATIONS,
  MS_MESSAGE_TYPES,
  TEXT_MESSAGE_TYPE,
  type ChannelMember,
  type ChannelSummary,
  type ChatSession,
  type CreateJourneyRoom,
  type RelayMessage,
} from '@mahilasathi/shared';
import type { Logger } from 'pino';
import type { AuditRepository } from '../../repositories/auditRepository.js';
import {
  providerChannelIdFor,
  type ChannelRow,
  type CommunityRepository,
} from '../../repositories/communityRepository.js';
import type { SafetyRepository } from '../../repositories/safetyRepository.js';
import type { UserRow } from '../../repositories/userRepository.js';
import { AppError, forbidden, notFound } from '../../utils/errors.js';
import type { Clock } from '../../utils/crypto.js';
import type { GeoRegistry } from '../geography/geoRegistry.js';
import type { MessagePolicy } from '../moderation/messagePolicy.js';
import { NexconnApiError } from '../nexconn/nexconnServerApi.js';
import { SYSTEM_CHAT_USER_ID, type ChatProvider } from './chatProvider.js';

/** The channel no longer exists or is archived: retrying a send cannot succeed. */
export class ChannelUnavailableError extends Error {
  constructor() {
    super('The chat channel is no longer available');
    this.name = 'ChannelUnavailableError';
  }
}

export const COMMUNITY_LIMITS = {
  maxNeighbourhoodChannels: 3,
  neighbourhoodMaxMembers: 5000,
  journeyRoomMaxMembers: 12,
  journeyRoomGraceMs: 2 * 60 * 60_000,
  maxActiveRoomsCreated: 2,
  roomLeadMs: 24 * 60 * 60_000,
  roomLagMs: 15 * 60_000,
  abandonedChannelMs: 30 * 24 * 60 * 60_000,
  relayRetentionMs: 30 * 24 * 60 * 60_000,
} as const;

type AreaInput = { type: 'neighbourhood' | 'district'; id: string };

export function createCommunityService(deps: {
  repo: CommunityRepository;
  safety: SafetyRepository;
  audit: AuditRepository;
  registry: GeoRegistry;
  provider: ChatProvider;
  policy: MessagePolicy;
  nexconnPublic: { appKey: string; areaCode: 'sg' | 'na' } | null;
  clock: Clock;
  logger: Logger;
}) {
  const { repo, safety, audit, registry, provider, policy, clock, logger } = deps;
  const nowIso = () => clock().toISOString();

  /** Provider calls are made before committing membership, so a provider outage never leaves a half-joined state. */
  async function viaProvider<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof NexconnApiError) {
        logger.warn({ what, reason: err.message, code: err.code }, 'chat provider call failed');
        throw new AppError('PROVIDER_UNAVAILABLE', 'Community chat is temporarily unavailable. Please try again shortly.');
      }
      throw err;
    }
  }

  /** Best-effort provider cleanup: our database (checked by the pre-messaging webhook) stays authoritative. */
  async function bestEffort(what: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      logger.warn({ what, reason: (err as Error).message }, 'chat provider cleanup failed; database membership is authoritative');
    }
  }

  function areaRef(a: { type: 'neighbourhood' | 'district'; id: string }) {
    if (a.type === 'neighbourhood') {
      const n = registry.neighbourhoodEntry(a.id);
      return n ? { type: a.type, id: n.id, name: n.name, districtId: n.districtId } : null;
    }
    const d = registry.districtRef(a.id);
    return d ? { type: a.type, id: d.id, name: d.name, districtId: d.id } : null;
  }

  function summarize(c: ChannelRow, userId: string): ChannelSummary {
    const membership = repo.membership(c.id, userId);
    const isMember = membership?.status === 'active';
    const n = c.neighbourhood_id ? registry.neighbourhoodEntry(c.neighbourhood_id) : null;
    const from = c.from_area_type && c.from_area_id ? areaRef({ type: c.from_area_type, id: c.from_area_id }) : null;
    const to = c.to_area_type && c.to_area_id ? areaRef({ type: c.to_area_type, id: c.to_area_id }) : null;
    return {
      id: c.id,
      kind: c.kind,
      name: n ? n.name : c.name,
      status: c.status,
      memberCount: repo.activeMemberCount(c.id),
      maxMembers: c.max_members,
      isMember,
      role: isMember ? membership!.role : null,
      providerChannelId: isMember ? c.provider_channel_id : null,
      neighbourhood: n ? { id: n.id, name: n.name, districtName: registry.districtRef(n.districtId)?.name ?? '' } : null,
      journey:
        c.kind === 'journey_room' && from && to
          ? {
              from: { type: from.type, id: from.id, name: from.name },
              to: { type: to.type, id: to.id, name: to.name },
              windowStart: c.window_start!,
              windowEnd: c.window_end!,
              expiresAt: c.expires_at!,
            }
          : null,
      lastActivityAt: c.last_activity_at,
    };
  }

  function requireChannel(id: string): ChannelRow {
    const c = repo.channel(id);
    if (!c) throw notFound('Channel');
    return c;
  }

  function requireMember(c: ChannelRow, userId: string): void {
    if (!repo.isActiveMember(c.id, userId)) throw forbidden('You’re not a member of this channel');
  }

  function assertNotSuspended(user: UserRow): void {
    const until = safety.suspendedUntil(user.id);
    if (until && Date.parse(until) > clock().getTime()) {
      throw new AppError('FORBIDDEN', 'Your community access is paused while reports are reviewed.');
    }
  }

  async function createChannel(row: Omit<ChannelRow, 'status' | 'archived_at' | 'archive_reason' | 'provider' | 'provider_channel_id' | 'id' | 'created_at' | 'last_activity_at'>, owner: { chatUserId: string }) {
    const id = crypto.randomUUID();
    const providerChannelId = providerChannelIdFor(id);
    await viaProvider('createChannel', () => provider.createChannel(providerChannelId, row.name, owner.chatUserId));
    const now = nowIso();
    return repo.insertChannel({ ...row, id, provider: provider.mode, provider_channel_id: providerChannelId, created_at: now, last_activity_at: now });
  }

  async function addMember(c: ChannelRow, user: UserRow, role: 'member' | 'owner'): Promise<void> {
    const chatUserId = repo.ensureChatIdentity(user.id, provider.mode, nowIso());
    await viaProvider('addMembers', () => provider.addMembers(c.provider_channel_id, [chatUserId]));
    repo.upsertMembership(c.id, user.id, role, nowIso());
    audit.record({ actorType: 'user', actorId: user.id, action: 'community.joined', targetType: 'channel', targetId: c.id, metadata: { kind: c.kind } });
  }

  return {
    summarize,

    chatUserId: (userId: string) => repo.ensureChatIdentity(userId, provider.mode, nowIso()),

    async session(user: UserRow): Promise<ChatSession> {
      const chatUserId = repo.ensureChatIdentity(user.id, provider.mode, nowIso());
      let nexconn: ChatSession['nexconn'] = null;
      if (provider.mode === 'nexconn' && deps.nexconnPublic) {
        // The pseudonym, never the phone number or real name, is what Nexconn sees.
        const token = await viaProvider('issueToken', () => provider.issueClientToken(chatUserId, user.community_handle));
        repo.markTokenIssued(user.id, nowIso());
        nexconn = { ...deps.nexconnPublic, token: token! };
      }
      return { mode: provider.mode, chatUserId, nexconn, customMessageTypes: [...MS_MESSAGE_REGISTRATIONS] };
    },

    myChannels: (user: UserRow) => repo.channelsForUser(user.id).map((c) => summarize(c, user.id)),

    channelSummary(user: UserRow, channelId: string): ChannelSummary {
      const c = requireChannel(channelId);
      // Circles are private: non-members cannot even see that the channel exists.
      if (c.kind === 'guardian_circle' && !repo.isActiveMember(c.id, user.id)) throw notFound('Channel');
      return summarize(c, user.id);
    },

    members(user: UserRow, channelId: string): ChannelMember[] {
      const c = requireChannel(channelId);
      if (!repo.isActiveMember(c.id, user.id)) throw c.kind === 'guardian_circle' ? notFound('Channel') : forbidden('Join this channel to see its members');
      return repo.activeMembers(c.id).map((m) => ({
        publicId: m.chat_user_id,
        handle: m.community_handle,
        displayName: c.kind === 'guardian_circle' ? m.display_name : null,
        role: m.role,
        isMe: m.user_id === user.id,
        isDemo: m.is_demo === 1,
      }));
    },

    /** Neighbourhoods the user may join: their home area plus others in their home district. */
    neighbourhoodOptions(user: UserRow) {
      const homeNeighbourhood = user.home_neighbourhood_id ? registry.neighbourhoodEntry(user.home_neighbourhood_id) : null;
      const districtId = homeNeighbourhood?.districtId ?? user.home_district_id;
      const list = districtId ? registry.listNeighbourhoods({ districtId, limit: 100 }) : [];
      if (homeNeighbourhood && !list.some((n) => n.id === homeNeighbourhood.id)) list.unshift(registry.toNeighbourhood(homeNeighbourhood));
      list.sort((a, b) => Number(b.id === homeNeighbourhood?.id) - Number(a.id === homeNeighbourhood?.id));
      const channels = new Map(repo.activeNeighbourhoodChannels(list.map((n) => n.id)).map((c) => [c.neighbourhood_id!, c]));
      return {
        homeNeighbourhoodId: homeNeighbourhood?.id ?? null,
        joinedCount: repo.countActiveNeighbourhoodMemberships(user.id),
        limit: COMMUNITY_LIMITS.maxNeighbourhoodChannels,
        neighbourhoods: list.map((n) => {
          const c = channels.get(n.id);
          return {
            id: n.id,
            name: n.name,
            city: n.city?.name ?? null,
            district: n.district.name,
            isHome: n.id === homeNeighbourhood?.id,
            channel: c ? summarize(c, user.id) : null,
          };
        }),
      };
    },

    /**
     * Controlled provisioning: a neighbourhood channel is created only when a resident first joins, at most
     * one exists per neighbourhood (unique index), and users join at most three neighbourhoods.
     */
    async joinNeighbourhood(user: UserRow, neighbourhoodId: string): Promise<ChannelSummary> {
      assertNotSuspended(user);
      const n = registry.neighbourhoodEntry(neighbourhoodId);
      if (!n) throw notFound('Neighbourhood');
      const home = user.home_neighbourhood_id ? registry.neighbourhoodEntry(user.home_neighbourhood_id) : null;
      const homeDistrict = home?.districtId ?? user.home_district_id;
      if (n.id !== home?.id && n.districtId !== homeDistrict) {
        throw forbidden('You can join neighbourhood channels in your home district. Update your home area to join others.');
      }

      let channel = repo.activeNeighbourhoodChannel(n.id);
      if (channel && repo.isActiveMember(channel.id, user.id)) return summarize(channel, user.id);
      if (repo.countActiveNeighbourhoodMemberships(user.id) >= COMMUNITY_LIMITS.maxNeighbourhoodChannels) {
        throw new AppError('CONFLICT', `You can be in up to ${COMMUNITY_LIMITS.maxNeighbourhoodChannels} neighbourhood channels. Leave one to join another.`);
      }
      if (!channel) {
        const ownerChat = repo.ensureChatIdentity(user.id, provider.mode, nowIso());
        try {
          channel = await createChannel(
            {
              kind: 'neighbourhood',
              name: `${n.name} · ${registry.cityRef(n.cityId)?.name ?? registry.districtRef(n.districtId)?.name ?? ''}`.slice(0, 64),
              neighbourhood_id: n.id,
              from_area_type: null,
              from_area_id: null,
              to_area_type: null,
              to_area_id: null,
              window_start: null,
              window_end: null,
              expires_at: null,
              max_members: COMMUNITY_LIMITS.neighbourhoodMaxMembers,
              created_by: user.id,
            },
            { chatUserId: ownerChat },
          );
          audit.record({ actorType: 'system', action: 'community.channel_provisioned', targetType: 'channel', targetId: channel.id, metadata: { neighbourhoodId: n.id } });
        } catch (err) {
          // Another request provisioned it first: use that one.
          const existing = repo.activeNeighbourhoodChannel(n.id);
          if (!existing) throw err;
          channel = existing;
        }
      }
      if (repo.activeMemberCount(channel.id) >= channel.max_members) throw new AppError('CONFLICT', 'This channel is full.');
      await addMember(channel, user, 'member');
      return summarize(channel, user.id);
    },

    async leave(user: UserRow, channelId: string): Promise<void> {
      const c = requireChannel(channelId);
      if (c.kind === 'guardian_circle') throw new AppError('BAD_REQUEST', 'Use the Guardian Circle settings to leave a circle.');
      requireMember(c, user.id);
      repo.endMembership(c.id, user.id, 'left', nowIso());
      audit.record({ actorType: 'user', actorId: user.id, action: 'community.left', targetType: 'channel', targetId: c.id });
      const chatUserId = repo.ensureChatIdentity(user.id, provider.mode, nowIso());
      await bestEffort('removeMembers', () => provider.removeMembers(c.provider_channel_id, [chatUserId]));
    },

    async createJourneyRoom(user: UserRow, input: CreateJourneyRoom): Promise<ChannelSummary> {
      assertNotSuspended(user);
      const from = areaRef(input.from);
      const to = areaRef(input.to);
      if (!from || !to) throw new AppError('VALIDATION_FAILED', 'Choose a start and destination area within NCR');
      if (from.type === to.type && from.id === to.id) throw new AppError('VALIDATION_FAILED', 'Start and destination must be different areas');
      const now = clock().getTime();
      const start = Date.parse(input.windowStart);
      if (start < now - COMMUNITY_LIMITS.roomLagMs || start > now + COMMUNITY_LIMITS.roomLeadMs) {
        throw new AppError('VALIDATION_FAILED', 'The departure window must start within the next 24 hours');
      }
      if (repo.countActiveRoomsCreatedBy(user.id, nowIso()) >= COMMUNITY_LIMITS.maxActiveRoomsCreated) {
        throw new AppError('CONFLICT', `You can have up to ${COMMUNITY_LIMITS.maxActiveRoomsCreated} open journey rooms at a time.`);
      }
      const end = start + input.windowMinutes * 60_000;
      const ownerChat = repo.ensureChatIdentity(user.id, provider.mode, nowIso());
      const channel = await createChannel(
        {
          kind: 'journey_room',
          name: `${from.name} → ${to.name}`.slice(0, 64),
          neighbourhood_id: null,
          from_area_type: from.type,
          from_area_id: from.id,
          to_area_type: to.type,
          to_area_id: to.id,
          window_start: new Date(start).toISOString(),
          window_end: new Date(end).toISOString(),
          expires_at: new Date(end + COMMUNITY_LIMITS.journeyRoomGraceMs).toISOString(),
          max_members: COMMUNITY_LIMITS.journeyRoomMaxMembers,
          created_by: user.id,
        },
        { chatUserId: ownerChat },
      );
      repo.upsertMembership(channel.id, user.id, 'owner', nowIso());
      audit.record({ actorType: 'user', actorId: user.id, action: 'community.journey_room_created', targetType: 'channel', targetId: channel.id });
      return summarize(channel, user.id);
    },

    /** Open rooms, optionally limited to those starting or ending in a district. Coarse area names only. */
    journeyRooms(user: UserRow, districtId?: string): ChannelSummary[] {
      return repo
        .openJourneyRooms(nowIso(), 100)
        .filter((c) => {
          if (!districtId) return true;
          const from = areaRef({ type: c.from_area_type!, id: c.from_area_id! });
          const to = areaRef({ type: c.to_area_type!, id: c.to_area_id! });
          return from?.districtId === districtId || to?.districtId === districtId;
        })
        .map((c) => summarize(c, user.id));
    },

    async joinJourneyRoom(user: UserRow, channelId: string): Promise<ChannelSummary> {
      assertNotSuspended(user);
      const c = requireChannel(channelId);
      if (c.kind !== 'journey_room') throw notFound('Journey room');
      if (c.status !== 'active' || Date.parse(c.expires_at!) <= clock().getTime()) throw new AppError('CONFLICT', 'This journey room has ended.');
      if (repo.isActiveMember(c.id, user.id)) return summarize(c, user.id);
      if (repo.activeMemberCount(c.id) >= c.max_members) throw new AppError('CONFLICT', 'This journey room is full.');
      // A block in either direction prevents sharing a small room. The reason is not revealed.
      if (safety.anyBlockedAmong(user.id, repo.activeMemberUserIds(c.id))) {
        throw forbidden('You can’t join this room. Try another room or create your own.');
      }
      await addMember(c, user, 'member');
      return summarize(c, user.id);
    },

    // ─── Messaging ────────────────────────────────────────────────────────────

    relayMessages(user: UserRow, channelId: string, opts: { afterSeq?: number; beforeSeq?: number }): { messages: RelayMessage[]; mode: 'dev-relay' } {
      if (provider.mode !== 'dev-relay') throw new AppError('BAD_REQUEST', 'Messages are delivered by Nexconn; use the chat SDK.');
      const c = requireChannel(channelId);
      requireMember(c, user.id);
      const rows = repo.relayMessages(c.id, { ...opts, limit: 50, excludeSenderIds: safety.blockedIds(user.id) });
      return {
        mode: 'dev-relay',
        messages: rows.map((r) => ({
          id: r.id,
          channelId: r.channel_id,
          senderPublicId: r.sender_user_id ? r.sender_chat_user_id : SYSTEM_CHAT_USER_ID,
          messageType: r.message_type,
          content: JSON.parse(r.content_json) as Record<string, unknown>,
          sentAt: r.sent_at,
          seq: r.seq,
        })),
      };
    },

    sendRelayText(user: UserRow, channelId: string, text: string) {
      if (provider.mode !== 'dev-relay') throw new AppError('BAD_REQUEST', 'Messages are sent through Nexconn; use the chat SDK.');
      const c = requireChannel(channelId);
      if (c.kind === 'guardian_circle' && !repo.isActiveMember(c.id, user.id)) throw notFound('Channel');
      const content = { content: text };
      const verdict = policy.evaluate({ user, channel: c, messageType: TEXT_MESSAGE_TYPE, content });
      if (!verdict.allowed) throw new AppError(verdict.code === 'not_member' ? 'FORBIDDEN' : verdict.code === 'rate_limited' ? 'RATE_LIMITED' : 'BAD_REQUEST', verdict.message, { policy: verdict.code });
      const sentAt = nowIso();
      const { id, seq } = repo.insertRelayMessage({ channelId: c.id, senderUserId: user.id, messageType: TEXT_MESSAGE_TYPE, content, sentAt });
      repo.touchChannel(c.id, sentAt);
      return { id, seq, sentAt };
    },

    /** Structured neighbourhood update (MS:InfraUpdate). Validated here, then sent by the server in either mode. */
    async sendInfraUpdate(user: UserRow, channelId: string, input: { category: string; note: string }) {
      const c = requireChannel(channelId);
      if (c.kind !== 'neighbourhood') throw new AppError('BAD_REQUEST', 'Neighbourhood updates can only be posted in neighbourhood channels.');
      const n = registry.neighbourhoodEntry(c.neighbourhood_id!);
      const content = { category: input.category, note: input.note, areaLabel: n?.name ?? c.name };
      const verdict = policy.evaluate({ user, channel: c, messageType: MS_MESSAGE_TYPES.infraUpdate, content, viaServer: true });
      if (!verdict.allowed) throw new AppError(verdict.code === 'not_member' ? 'FORBIDDEN' : verdict.code === 'rate_limited' ? 'RATE_LIMITED' : 'BAD_REQUEST', verdict.message, { policy: verdict.code });
      const chatUserId = repo.ensureChatIdentity(user.id, provider.mode, nowIso());
      const id = await viaProvider('sendServerMessage', () =>
        provider.sendServerMessage({
          channelId: c.id,
          providerChannelId: c.provider_channel_id,
          fromChatUserId: chatUserId,
          senderUserId: user.id,
          messageType: MS_MESSAGE_TYPES.infraUpdate,
          content,
          pushContent: 'New neighbourhood update',
        }),
      );
      repo.touchChannel(c.id, nowIso());
      audit.record({ actorType: 'user', actorId: user.id, action: 'community.infra_update_posted', targetType: 'channel', targetId: c.id, metadata: { category: input.category } });
      return { id };
    },

    /**
     * A server-generated notice (e.g. MS:JourneyStatus) sent as the system user. Best effort: a chat
     * outage must never block a journey transition, so failures are logged, not thrown.
     */
    async sendSystemMessage(channelId: string, messageType: string, content: Record<string, unknown>, pushContent?: string): Promise<boolean> {
      try {
        await this.postSystemMessage(channelId, messageType, content, pushContent);
        return true;
      } catch (err) {
        logger.warn({ what: 'sendSystemMessage', messageType, reason: (err as Error).message }, 'system message not delivered');
        return false;
      }
    },

    /**
     * Same as sendSystemMessage but throws, for callers that track delivery and retry (SOS).
     * Throws ChannelUnavailableError when the channel is gone (retrying cannot help); provider errors propagate.
     * Resolves with the provider's message id once the provider has ACCEPTED the message.
     */
    async postSystemMessage(channelId: string, messageType: string, content: Record<string, unknown>, pushContent?: string): Promise<string> {
      const c = repo.channel(channelId);
      if (!c || c.status !== 'active') throw new ChannelUnavailableError();
      const id = await provider.sendServerMessage({
        channelId: c.id,
        providerChannelId: c.provider_channel_id,
        fromChatUserId: SYSTEM_CHAT_USER_ID,
        senderUserId: null,
        messageType,
        content,
        ...(pushContent ? { pushContent } : {}),
      });
      repo.touchChannel(c.id, nowIso());
      return id;
    },

    /** Archives a channel (e.g. a cancelled Walk Together pair). Database first; provider best-effort. */
    async archiveChannel(channelId: string, reason: string): Promise<boolean> {
      const c = repo.channel(channelId);
      if (!c || !repo.archiveChannel(c.id, reason, nowIso())) return false;
      audit.record({ actorType: 'system', action: 'community.channel_archived', targetType: 'channel', targetId: c.id, metadata: { reason } });
      await bestEffort('archiveChannel', () => provider.archiveChannel(c.provider_channel_id));
      return true;
    },

    // ─── Lifecycle jobs ───────────────────────────────────────────────────────

    async archiveExpiredRooms(): Promise<number> {
      const rooms = repo.expiredJourneyRooms(nowIso());
      for (const room of rooms) {
        if (!repo.archiveChannel(room.id, 'expired', nowIso())) continue;
        audit.record({ actorType: 'system', action: 'community.journey_room_archived', targetType: 'channel', targetId: room.id });
        await bestEffort('archiveChannel', () => provider.archiveChannel(room.provider_channel_id));
      }
      return rooms.length;
    },

    async archiveAbandonedNeighbourhoods(): Promise<number> {
      const cutoff = new Date(clock().getTime() - COMMUNITY_LIMITS.abandonedChannelMs).toISOString();
      const channels = repo.abandonedNeighbourhoodChannels(cutoff);
      for (const c of channels) {
        if (!repo.archiveChannel(c.id, 'inactive', nowIso())) continue;
        audit.record({ actorType: 'system', action: 'community.channel_archived', targetType: 'channel', targetId: c.id, metadata: { reason: 'inactive' } });
        await bestEffort('archiveChannel', () => provider.archiveChannel(c.provider_channel_id));
      }
      return channels.length;
    },

    purgeRelay: () => repo.purgeRelayMessages(new Date(clock().getTime() - COMMUNITY_LIMITS.relayRetentionMs).toISOString()),

    /** Removes a user from a channel (moderation). Database first; provider best-effort. */
    async removeFromChannel(channelId: string, userId: string, removedBy: string): Promise<boolean> {
      const c = repo.channel(channelId);
      if (!c) return false;
      const ended = repo.endMembership(channelId, userId, 'removed', nowIso(), removedBy);
      if (ended) {
        const chatUserId = repo.ensureChatIdentity(userId, provider.mode, nowIso());
        await bestEffort('removeMembers', () => provider.removeMembers(c.provider_channel_id, [chatUserId]));
      }
      return ended;
    },

    addMember,
    createChannel,
  };
}

export type CommunityService = ReturnType<typeof createCommunityService>;
