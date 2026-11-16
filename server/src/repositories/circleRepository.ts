import crypto from 'node:crypto';
import type { Db } from '../db/connection.js';

export interface CircleRow {
  id: string;
  owner_id: string;
  name: string;
  channel_id: string;
  created_at: string;
}

export interface CircleInviteRow {
  id: string;
  circle_id: string;
  code_hash: string;
  bound_phone_hash: string | null;
  created_by: string;
  created_at: string;
  expires_at: string;
  accepted_by: string | null;
  accepted_at: string | null;
  revoked_at: string | null;
}

export function createCircleRepository(db: Db) {
  return {
    insertCircle(c: CircleRow): void {
      db.prepare('INSERT INTO circles (id, owner_id, name, channel_id, created_at) VALUES (@id, @owner_id, @name, @channel_id, @created_at)').run(c);
      db.prepare("INSERT INTO circle_members (circle_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)").run(c.id, c.owner_id, c.created_at);
    },
    byId: (id: string) => db.prepare('SELECT * FROM circles WHERE id = ?').get(id) as CircleRow | undefined,
    byOwner: (ownerId: string) => db.prepare('SELECT * FROM circles WHERE owner_id = ?').get(ownerId) as CircleRow | undefined,
    byChannel: (channelId: string) => db.prepare('SELECT * FROM circles WHERE channel_id = ?').get(channelId) as CircleRow | undefined,
    /** Circles where the user is an active member (as owner or guardian). */
    forMember: (userId: string) =>
      db
        .prepare(
          "SELECT c.* FROM circles c JOIN circle_members m ON m.circle_id = c.id WHERE m.user_id = ? AND m.status = 'active' ORDER BY c.created_at",
        )
        .all(userId) as CircleRow[],
    isActiveMember: (circleId: string, userId: string) =>
      db.prepare("SELECT 1 FROM circle_members WHERE circle_id = ? AND user_id = ? AND status = 'active'").get(circleId, userId) !== undefined,
    activeMembers: (circleId: string) =>
      db
        .prepare(
          `SELECT m.user_id, m.role, m.joined_at, u.community_handle, u.display_name, ci.chat_user_id
           FROM circle_members m JOIN users u ON u.id = m.user_id LEFT JOIN chat_identities ci ON ci.user_id = m.user_id
           WHERE m.circle_id = ? AND m.status = 'active' AND u.status = 'active' ORDER BY m.role DESC, m.joined_at, m.rowid`,
        )
        .all(circleId) as { user_id: string; role: 'owner' | 'guardian'; joined_at: string; community_handle: string; display_name: string | null; chat_user_id: string | null }[],
    activeMemberCount: (circleId: string) =>
      (db.prepare("SELECT COUNT(*) AS n FROM circle_members WHERE circle_id = ? AND status = 'active'").get(circleId) as { n: number }).n,
    addGuardian(circleId: string, userId: string, now: string): void {
      db.prepare(
        `INSERT INTO circle_members (circle_id, user_id, role, status, joined_at) VALUES (?, ?, 'guardian', 'active', ?)
         ON CONFLICT (circle_id, user_id) DO UPDATE SET status = 'active', joined_at = excluded.joined_at, ended_at = NULL`,
      ).run(circleId, userId, now);
    },
    endMember(circleId: string, userId: string, status: 'removed' | 'left', now: string): boolean {
      return (
        db
          .prepare("UPDATE circle_members SET status = ?, ended_at = ? WHERE circle_id = ? AND user_id = ? AND status = 'active' AND role = 'guardian'")
          .run(status, now, circleId, userId).changes === 1
      );
    },

    insertInvite(i: Omit<CircleInviteRow, 'id' | 'accepted_by' | 'accepted_at' | 'revoked_at'>): string {
      const id = crypto.randomUUID();
      db.prepare(
        `INSERT INTO circle_invites (id, circle_id, code_hash, bound_phone_hash, created_by, created_at, expires_at)
         VALUES (@id, @circle_id, @code_hash, @bound_phone_hash, @created_by, @created_at, @expires_at)`,
      ).run({ id, ...i });
      return id;
    },
    inviteByCodeHash: (codeHash: string) => db.prepare('SELECT * FROM circle_invites WHERE code_hash = ?').get(codeHash) as CircleInviteRow | undefined,
    pendingInvites: (circleId: string, now: string) =>
      db
        .prepare(
          'SELECT * FROM circle_invites WHERE circle_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at',
        )
        .all(circleId, now) as CircleInviteRow[],
    /** Single-use: only succeeds once. */
    acceptInvite(id: string, userId: string, now: string): boolean {
      return (
        db
          .prepare('UPDATE circle_invites SET accepted_by = ?, accepted_at = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL')
          .run(userId, now, id).changes === 1
      );
    },
    revokeInvite: (id: string, circleId: string, now: string) =>
      db.prepare('UPDATE circle_invites SET revoked_at = ? WHERE id = ? AND circle_id = ? AND accepted_at IS NULL AND revoked_at IS NULL').run(now, id, circleId)
        .changes === 1,
    purgeInvites: (before: string) => db.prepare('DELETE FROM circle_invites WHERE expires_at < ?').run(before).changes,
  };
}

export type CircleRepository = ReturnType<typeof createCircleRepository>;
