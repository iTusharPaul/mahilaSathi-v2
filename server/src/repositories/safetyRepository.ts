import crypto from 'node:crypto';
import type { Db } from '../db/connection.js';

export interface MessageReportRow {
  id: string;
  channel_id: string;
  provider_message_id: string;
  reporter_id: string;
  reported_user_id: string | null;
  reason: string;
  details: string | null;
  snapshot_text: string | null;
  snapshot_source: 'server' | 'reporter';
  status: 'open' | 'actioned' | 'dismissed';
  created_at: string;
}

export interface UserReportRow {
  id: string;
  reporter_id: string;
  reported_user_id: string;
  reason: string;
  details: string | null;
  context_channel_id: string | null;
  status: 'open' | 'actioned' | 'dismissed';
  created_at: string;
}

export function createSafetyRepository(db: Db) {
  return {
    // ─── Blocks ───────────────────────────────────────────────────────────────
    block(blockerId: string, blockedId: string, now: string): boolean {
      return db.prepare('INSERT OR IGNORE INTO user_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)').run(blockerId, blockedId, now).changes === 1;
    },
    unblock: (blockerId: string, blockedId: string) =>
      db.prepare('DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?').run(blockerId, blockedId).changes === 1,
    /** True if either user has blocked the other. */
    eitherBlocked: (a: string, b: string) =>
      db
        .prepare('SELECT 1 FROM user_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)')
        .get(a, b, b, a) !== undefined,
    /** Users with a block relationship (either direction) to `userId` among `others`. */
    anyBlockedAmong(userId: string, others: string[]): boolean {
      if (others.length === 0) return false;
      return (
        db
          .prepare(
            `SELECT 1 FROM user_blocks WHERE (blocker_id = ? AND blocked_id IN (SELECT value FROM json_each(?)))
               OR (blocked_id = ? AND blocker_id IN (SELECT value FROM json_each(?))) LIMIT 1`,
          )
          .get(userId, JSON.stringify(others), userId, JSON.stringify(others)) !== undefined
      );
    },
    blockedByMe: (userId: string) =>
      db
        .prepare(
          `SELECT b.blocked_id, b.created_at, ci.chat_user_id, u.community_handle FROM user_blocks b
           JOIN users u ON u.id = b.blocked_id LEFT JOIN chat_identities ci ON ci.user_id = b.blocked_id
           WHERE b.blocker_id = ? ORDER BY b.created_at DESC`,
        )
        .all(userId) as { blocked_id: string; created_at: string; chat_user_id: string | null; community_handle: string }[],
    blockedIds: (userId: string) =>
      (db.prepare('SELECT blocked_id FROM user_blocks WHERE blocker_id = ?').all(userId) as { blocked_id: string }[]).map((r) => r.blocked_id),

    // ─── Reports ──────────────────────────────────────────────────────────────
    insertMessageReport(r: Omit<MessageReportRow, 'id' | 'status'>): { id: string; duplicate: boolean } {
      const id = crypto.randomUUID();
      const changes = db
        .prepare(
          `INSERT OR IGNORE INTO message_reports (id, channel_id, provider_message_id, reporter_id, reported_user_id, reason, details,
             snapshot_text, snapshot_source, created_at)
           VALUES (@id, @channel_id, @provider_message_id, @reporter_id, @reported_user_id, @reason, @details, @snapshot_text, @snapshot_source, @created_at)`,
        )
        .run({ id, ...r }).changes;
      if (changes === 1) return { id, duplicate: false };
      const existing = db
        .prepare('SELECT id FROM message_reports WHERE reporter_id = ? AND channel_id = ? AND provider_message_id = ?')
        .get(r.reporter_id, r.channel_id, r.provider_message_id) as { id: string };
      return { id: existing.id, duplicate: true };
    },
    insertUserReport(r: Omit<UserReportRow, 'id' | 'status'>): string {
      const id = crypto.randomUUID();
      db.prepare(
        `INSERT INTO user_reports (id, reporter_id, reported_user_id, reason, details, context_channel_id, created_at)
         VALUES (@id, @reporter_id, @reported_user_id, @reason, @details, @context_channel_id, @created_at)`,
      ).run({ id, ...r });
      return id;
    },
    /** Distinct users who reported `userId` (messages or profile) since `since`. */
    distinctReportersSince(userId: string, since: string): number {
      return (
        db
          .prepare(
            `SELECT COUNT(DISTINCT reporter_id) AS n FROM (
               SELECT reporter_id FROM message_reports WHERE reported_user_id = ? AND created_at >= ?
               UNION ALL SELECT reporter_id FROM user_reports WHERE reported_user_id = ? AND created_at >= ?)`,
          )
          .get(userId, since, userId, since) as { n: number }
      ).n;
    },
    openReports(limit: number) {
      const messages = db
        .prepare("SELECT 'message' AS type, * FROM message_reports WHERE status = 'open' ORDER BY created_at LIMIT ?")
        .all(limit) as (MessageReportRow & { type: 'message' })[];
      const users = db
        .prepare("SELECT 'user' AS type, * FROM user_reports WHERE status = 'open' ORDER BY created_at LIMIT ?")
        .all(limit) as (UserReportRow & { type: 'user' })[];
      return { messages, users };
    },
    /** Pseudonym, demo flag and suspension for moderator views. Never the phone number. */
    userSummary: (id: string) =>
      db.prepare('SELECT community_handle, is_demo, community_suspended_until FROM users WHERE id = ?').get(id) as
        | { community_handle: string; is_demo: number; community_suspended_until: string | null }
        | undefined,
    openReportsAgainst: (userId: string) =>
      (
        db
          .prepare(
            `SELECT (SELECT COUNT(*) FROM message_reports WHERE reported_user_id = ? AND status = 'open')
                  + (SELECT COUNT(*) FROM user_reports WHERE reported_user_id = ? AND status = 'open') AS n`,
          )
          .get(userId, userId) as { n: number }
      ).n,
    findReport(id: string): ({ type: 'message' } & MessageReportRow) | ({ type: 'user' } & UserReportRow) | null {
      const m = db.prepare('SELECT * FROM message_reports WHERE id = ?').get(id) as MessageReportRow | undefined;
      if (m) return { type: 'message', ...m };
      const u = db.prepare('SELECT * FROM user_reports WHERE id = ?').get(id) as UserReportRow | undefined;
      return u ? { type: 'user', ...u } : null;
    },
    resolveReport(id: string, type: 'message' | 'user', status: 'actioned' | 'dismissed', resolution: string, now: string): void {
      const table = type === 'message' ? 'message_reports' : 'user_reports';
      db.prepare(`UPDATE ${table} SET status = ?, resolution = ?, resolved_at = ? WHERE id = ?`).run(status, resolution, now, id);
    },

    // ─── Moderation actions & suspensions ─────────────────────────────────────
    recordAction(a: {
      actorType: 'admin' | 'system';
      action: 'dismiss_report' | 'warn' | 'remove_from_channel' | 'suspend' | 'unsuspend' | 'auto_suspend';
      targetUserId: string | null;
      channelId: string | null;
      reportId: string | null;
      reason: string;
      expiresAt: string | null;
      now: string;
    }): string {
      const id = crypto.randomUUID();
      db.prepare(
        `INSERT INTO moderation_actions (id, actor_type, action, target_user_id, channel_id, report_id, reason, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, a.actorType, a.action, a.targetUserId, a.channelId, a.reportId, a.reason, a.expiresAt, a.now);
      return id;
    },
    setSuspension(userId: string, until: string | null): void {
      db.prepare('UPDATE users SET community_suspended_until = ? WHERE id = ?').run(until, userId);
    },
    suspendedUntil(userId: string): string | null {
      return (db.prepare('SELECT community_suspended_until AS s FROM users WHERE id = ?').get(userId) as { s: string | null } | undefined)?.s ?? null;
    },
  };
}

export type SafetyRepository = ReturnType<typeof createSafetyRepository>;
