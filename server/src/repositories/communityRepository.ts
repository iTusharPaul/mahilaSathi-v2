import crypto from 'node:crypto';
import type { Db } from '../db/connection.js';

export type ChannelKind = 'neighbourhood' | 'journey_room' | 'guardian_circle' | 'walk_together';

export interface ChannelRow {
  id: string;
  kind: ChannelKind;
  provider: 'nexconn' | 'dev-relay';
  provider_channel_id: string;
  name: string;
  neighbourhood_id: string | null;
  from_area_type: 'neighbourhood' | 'district' | null;
  from_area_id: string | null;
  to_area_type: 'neighbourhood' | 'district' | null;
  to_area_id: string | null;
  window_start: string | null;
  window_end: string | null;
  expires_at: string | null;
  max_members: number;
  created_by: string | null;
  status: 'active' | 'archived';
  archived_at: string | null;
  archive_reason: string | null;
  last_activity_at: string;
  created_at: string;
}

export interface MembershipRow {
  channel_id: string;
  user_id: string;
  role: 'member' | 'owner' | 'moderator';
  status: 'active' | 'left' | 'removed';
  joined_at: string;
}

export interface MemberView {
  user_id: string;
  chat_user_id: string;
  community_handle: string;
  display_name: string | null;
  role: MembershipRow['role'];
  is_demo: number;
}

export interface RelayMessageRow {
  id: string;
  channel_id: string;
  sender_user_id: string | null;
  sender_chat_user_id: string | null;
  message_type: string;
  content_json: string;
  sent_at: string;
  seq: number;
}

/** Chat ids must be letters and digits only (Nexconn constraint). */
export const chatUserIdFor = (userId: string) => `u${userId.replace(/-/g, '')}`;
export const providerChannelIdFor = (channelId: string) => `c${channelId.replace(/-/g, '')}`;

export function createCommunityRepository(db: Db) {
  return {
    // ─── Chat identities ──────────────────────────────────────────────────────
    ensureChatIdentity(userId: string, provider: 'nexconn' | 'dev-relay', now: string): string {
      const chatUserId = chatUserIdFor(userId);
      db.prepare(
        `INSERT INTO chat_identities (user_id, chat_user_id, provider, registered_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET provider = excluded.provider`,
      ).run(userId, chatUserId, provider, now);
      return chatUserId;
    },
    markTokenIssued(userId: string, now: string): void {
      db.prepare('UPDATE chat_identities SET last_token_issued_at = ? WHERE user_id = ?').run(now, userId);
    },
    userIdForChatUserId(chatUserId: string): string | null {
      const row = db.prepare('SELECT user_id FROM chat_identities WHERE chat_user_id = ?').get(chatUserId) as { user_id: string } | undefined;
      return row?.user_id ?? null;
    },

    // ─── Channels ─────────────────────────────────────────────────────────────
    insertChannel(row: Omit<ChannelRow, 'status' | 'archived_at' | 'archive_reason'>): ChannelRow {
      db.prepare(
        `INSERT INTO community_channels (id, kind, provider, provider_channel_id, name, neighbourhood_id, from_area_type, from_area_id,
           to_area_type, to_area_id, window_start, window_end, expires_at, max_members, created_by, last_activity_at, created_at)
         VALUES (@id, @kind, @provider, @provider_channel_id, @name, @neighbourhood_id, @from_area_type, @from_area_id,
           @to_area_type, @to_area_id, @window_start, @window_end, @expires_at, @max_members, @created_by, @last_activity_at, @created_at)`,
      ).run(row);
      return this.channel(row.id)!;
    },
    channel: (id: string) => db.prepare('SELECT * FROM community_channels WHERE id = ?').get(id) as ChannelRow | undefined,
    channelByProviderId: (providerChannelId: string) =>
      db.prepare('SELECT * FROM community_channels WHERE provider_channel_id = ?').get(providerChannelId) as ChannelRow | undefined,
    activeNeighbourhoodChannel: (neighbourhoodId: string) =>
      db
        .prepare("SELECT * FROM community_channels WHERE kind = 'neighbourhood' AND neighbourhood_id = ? AND status = 'active'")
        .get(neighbourhoodId) as ChannelRow | undefined,
    activeNeighbourhoodChannels: (neighbourhoodIds: string[]) =>
      db
        .prepare(
          "SELECT * FROM community_channels WHERE kind = 'neighbourhood' AND status = 'active' AND neighbourhood_id IN (SELECT value FROM json_each(?))",
        )
        .all(JSON.stringify(neighbourhoodIds)) as ChannelRow[],
    openJourneyRooms: (now: string, limit: number) =>
      db
        .prepare(
          "SELECT * FROM community_channels WHERE kind = 'journey_room' AND status = 'active' AND expires_at > ? ORDER BY window_start LIMIT ?",
        )
        .all(now, limit) as ChannelRow[],
    channelsForUser: (userId: string) =>
      db
        .prepare(
          `SELECT c.* FROM community_channels c JOIN community_memberships m ON m.channel_id = c.id
           WHERE m.user_id = ? AND m.status = 'active' ORDER BY c.last_activity_at DESC`,
        )
        .all(userId) as ChannelRow[],
    touchChannel(id: string, now: string): void {
      db.prepare('UPDATE community_channels SET last_activity_at = ? WHERE id = ?').run(now, id);
    },
    archiveChannel(id: string, reason: string, now: string): boolean {
      return (
        db
          .prepare("UPDATE community_channels SET status = 'archived', archived_at = ?, archive_reason = ? WHERE id = ? AND status = 'active'")
          .run(now, reason, id).changes === 1
      );
    },
    expiredJourneyRooms: (now: string) =>
      db
        .prepare("SELECT * FROM community_channels WHERE kind IN ('journey_room', 'walk_together') AND status = 'active' AND expires_at <= ?")
        .all(now) as ChannelRow[],
    /** Neighbourhood channels with no active members whose last activity is older than the cutoff. */
    abandonedNeighbourhoodChannels: (cutoff: string) =>
      db
        .prepare(
          `SELECT c.* FROM community_channels c WHERE c.kind = 'neighbourhood' AND c.status = 'active' AND c.last_activity_at < ?
           AND NOT EXISTS (SELECT 1 FROM community_memberships m WHERE m.channel_id = c.id AND m.status = 'active')`,
        )
        .all(cutoff) as ChannelRow[],
    countActiveRoomsCreatedBy: (userId: string, now: string) =>
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM community_channels WHERE kind = 'journey_room' AND status = 'active' AND created_by = ? AND expires_at > ?")
          .get(userId, now) as { n: number }
      ).n,

    // ─── Memberships ──────────────────────────────────────────────────────────
    membership: (channelId: string, userId: string) =>
      db.prepare('SELECT * FROM community_memberships WHERE channel_id = ? AND user_id = ?').get(channelId, userId) as MembershipRow | undefined,
    isActiveMember(channelId: string, userId: string): boolean {
      return this.membership(channelId, userId)?.status === 'active';
    },
    upsertMembership(channelId: string, userId: string, role: MembershipRow['role'], now: string): void {
      db.prepare(
        `INSERT INTO community_memberships (channel_id, user_id, role, status, joined_at) VALUES (?, ?, ?, 'active', ?)
         ON CONFLICT (channel_id, user_id) DO UPDATE SET status = 'active', role = excluded.role, joined_at = excluded.joined_at,
           left_at = NULL, removed_by = NULL`,
      ).run(channelId, userId, role, now);
    },
    endMembership(channelId: string, userId: string, status: 'left' | 'removed', now: string, removedBy: string | null = null): boolean {
      return (
        db
          .prepare(
            "UPDATE community_memberships SET status = ?, left_at = ?, removed_by = ? WHERE channel_id = ? AND user_id = ? AND status = 'active'",
          )
          .run(status, now, removedBy, channelId, userId).changes === 1
      );
    },
    activeMemberCount: (channelId: string) =>
      (db.prepare("SELECT COUNT(*) AS n FROM community_memberships WHERE channel_id = ? AND status = 'active'").get(channelId) as { n: number }).n,
    activeMembers: (channelId: string, limit = 200) =>
      db
        .prepare(
          `SELECT m.user_id, ci.chat_user_id, u.community_handle, u.display_name, m.role, u.is_demo
           FROM community_memberships m JOIN users u ON u.id = m.user_id JOIN chat_identities ci ON ci.user_id = m.user_id
           WHERE m.channel_id = ? AND m.status = 'active' AND u.status = 'active' ORDER BY m.joined_at LIMIT ?`,
        )
        .all(channelId, limit) as MemberView[],
    activeMemberUserIds: (channelId: string) =>
      (
        db.prepare("SELECT user_id FROM community_memberships WHERE channel_id = ? AND status = 'active'").all(channelId) as { user_id: string }[]
      ).map((r) => r.user_id),
    countActiveNeighbourhoodMemberships: (userId: string) =>
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM community_memberships m JOIN community_channels c ON c.id = m.channel_id
             WHERE m.user_id = ? AND m.status = 'active' AND c.kind = 'neighbourhood' AND c.status = 'active'`,
          )
          .get(userId) as { n: number }
      ).n,

    // ─── Development relay messages ───────────────────────────────────────────
    insertRelayMessage(m: { channelId: string; senderUserId: string | null; messageType: string; content: Record<string, unknown>; sentAt: string }) {
      const id = crypto.randomUUID();
      const seq = ((db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM dev_chat_messages').get() as { s: number }).s);
      db.prepare(
        'INSERT INTO dev_chat_messages (id, channel_id, sender_user_id, message_type, content_json, sent_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(id, m.channelId, m.senderUserId, m.messageType, JSON.stringify(m.content), m.sentAt, seq);
      return { id, seq };
    },
    relayMessage: (id: string) =>
      db
        .prepare(
          `SELECT d.*, ci.chat_user_id AS sender_chat_user_id FROM dev_chat_messages d
           LEFT JOIN chat_identities ci ON ci.user_id = d.sender_user_id WHERE d.id = ?`,
        )
        .get(id) as RelayMessageRow | undefined,
    /** Newest-first page before `beforeSeq`, or everything after `afterSeq` (oldest first). Excludes blocked senders. */
    relayMessages(channelId: string, opts: { afterSeq?: number; beforeSeq?: number; limit: number; excludeSenderIds: string[] }): RelayMessageRow[] {
      const exclude = JSON.stringify(opts.excludeSenderIds);
      const base = `SELECT d.*, ci.chat_user_id AS sender_chat_user_id FROM dev_chat_messages d
        LEFT JOIN chat_identities ci ON ci.user_id = d.sender_user_id
        WHERE d.channel_id = ? AND (d.sender_user_id IS NULL OR d.sender_user_id NOT IN (SELECT value FROM json_each(?)))`;
      if (opts.afterSeq !== undefined) {
        return db.prepare(`${base} AND d.seq > ? ORDER BY d.seq ASC LIMIT ?`).all(channelId, exclude, opts.afterSeq, opts.limit) as RelayMessageRow[];
      }
      const rows = db
        .prepare(`${base} AND d.seq < ? ORDER BY d.seq DESC LIMIT ?`)
        .all(channelId, exclude, opts.beforeSeq ?? Number.MAX_SAFE_INTEGER, opts.limit) as RelayMessageRow[];
      return rows.reverse();
    },
    recentRelayTexts(senderUserId: string, since: string): string[] {
      return (
        db
          .prepare("SELECT content_json FROM dev_chat_messages WHERE sender_user_id = ? AND sent_at >= ? AND message_type = 'RC:TxtMsg'")
          .all(senderUserId, since) as { content_json: string }[]
      ).map((r) => String((JSON.parse(r.content_json) as { content?: unknown }).content ?? ''));
    },
    purgeRelayMessages: (before: string) => db.prepare('DELETE FROM dev_chat_messages WHERE sent_at < ?').run(before).changes,
  };
}

export type CommunityRepository = ReturnType<typeof createCommunityRepository>;
