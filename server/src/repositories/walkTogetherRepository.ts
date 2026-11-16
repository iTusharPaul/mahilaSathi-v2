import crypto from 'node:crypto';
import type { Db } from '../db/connection.js';

export interface WalkRequestRow {
  id: string;
  trip_id: string;
  user_id: string;
  mode: string;
  window_start: string;
  window_end: string;
  status: 'open' | 'cancelled' | 'expired';
  created_at: string;
}

export interface WalkMatchRow {
  id: string;
  request_a: string;
  request_b: string;
  user_a: string;
  user_b: string;
  overlap_pct: number;
  shared_areas_json: string;
  status: 'proposed' | 'accepted' | 'rejected' | 'cancelled';
  a_accepted_at: string | null;
  b_accepted_at: string | null;
  channel_id: string | null;
  created_at: string;
  updated_at: string;
}

export function createWalkTogetherRepository(db: Db) {
  return {
    /** One request per trip: re-requesting reopens it with a new window. */
    upsertRequest(r: Omit<WalkRequestRow, 'id' | 'status'>): WalkRequestRow {
      db.prepare(
        `INSERT INTO walk_together_requests (id, trip_id, user_id, mode, window_start, window_end, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?)
         ON CONFLICT (trip_id) DO UPDATE SET window_start = excluded.window_start, window_end = excluded.window_end, status = 'open'`,
      ).run(crypto.randomUUID(), r.trip_id, r.user_id, r.mode, r.window_start, r.window_end, r.created_at);
      return db.prepare('SELECT * FROM walk_together_requests WHERE trip_id = ?').get(r.trip_id) as WalkRequestRow;
    },
    request: (id: string) => db.prepare('SELECT * FROM walk_together_requests WHERE id = ?').get(id) as WalkRequestRow | undefined,
    requestForTrip: (tripId: string) => db.prepare('SELECT * FROM walk_together_requests WHERE trip_id = ?').get(tripId) as WalkRequestRow | undefined,
    /** Open requests from other people, same mode, whose window overlaps [start, end). */
    candidates(userId: string, mode: string, start: string, end: string): WalkRequestRow[] {
      return db
        .prepare(
          `SELECT * FROM walk_together_requests
           WHERE status = 'open' AND user_id != ? AND mode = ? AND window_start < ? AND window_end > ? ORDER BY created_at LIMIT 200`,
        )
        .all(userId, mode, end, start) as WalkRequestRow[];
    },
    /** Closes a request and every proposal still pending on it. Accepted pairs keep their channel until it expires. */
    closeRequest(id: string, status: 'cancelled' | 'expired', now: string): void {
      db.transaction(() => {
        db.prepare("UPDATE walk_together_requests SET status = ? WHERE id = ? AND status = 'open'").run(status, id);
        db.prepare("UPDATE walk_together_matches SET status = 'cancelled', updated_at = ? WHERE status = 'proposed' AND (request_a = ? OR request_b = ?)").run(now, id, id);
      })();
    },
    endedOpenRequests: (now: string) =>
      db.prepare("SELECT * FROM walk_together_requests WHERE status = 'open' AND window_end <= ?").all(now) as WalkRequestRow[],

    insertMatch(m: Omit<WalkMatchRow, 'id' | 'status' | 'a_accepted_at' | 'b_accepted_at' | 'channel_id' | 'updated_at'>): boolean {
      return (
        db
          .prepare(
            `INSERT OR IGNORE INTO walk_together_matches (id, request_a, request_b, user_a, user_b, overlap_pct, shared_areas_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(crypto.randomUUID(), m.request_a, m.request_b, m.user_a, m.user_b, m.overlap_pct, m.shared_areas_json, m.created_at, m.created_at).changes === 1
      );
    },
    match: (id: string) => db.prepare('SELECT * FROM walk_together_matches WHERE id = ?').get(id) as WalkMatchRow | undefined,
    /** A user's live matches: proposals and accepted pairs on requests that are still open or recently matched. */
    matchesForUser: (userId: string) =>
      db
        .prepare(
          `SELECT * FROM walk_together_matches WHERE (user_a = ? OR user_b = ?) AND status IN ('proposed', 'accepted')
           ORDER BY status = 'accepted' DESC, overlap_pct DESC, created_at DESC LIMIT 20`,
        )
        .all(userId, userId) as WalkMatchRow[],
    setAccepted(id: string, side: 'a' | 'b', now: string): void {
      db.prepare(`UPDATE walk_together_matches SET ${side}_accepted_at = ?, updated_at = ? WHERE id = ? AND status = 'proposed'`).run(now, now, id);
    },
    /** Guarded: only moves a match that is still in `from`. */
    setStatus(id: string, from: WalkMatchRow['status'], to: WalkMatchRow['status'], now: string, channelId?: string): boolean {
      return (
        db
          .prepare('UPDATE walk_together_matches SET status = ?, channel_id = COALESCE(?, channel_id), updated_at = ? WHERE id = ? AND status = ?')
          .run(to, channelId ?? null, now, id, from).changes === 1
      );
    },
    /** Once a pair is formed, other pending proposals for either request are withdrawn. */
    cancelOtherProposals(requestIds: string[], keepMatchId: string, now: string): number {
      return db
        .prepare(
          `UPDATE walk_together_matches SET status = 'cancelled', updated_at = ?
           WHERE status = 'proposed' AND id != ? AND (request_a IN (SELECT value FROM json_each(?)) OR request_b IN (SELECT value FROM json_each(?)))`,
        )
        .run(now, keepMatchId, JSON.stringify(requestIds), JSON.stringify(requestIds)).changes;
    },
    addMembers(matchId: string, userIds: string[], now: string): void {
      const stmt = db.prepare('INSERT OR IGNORE INTO walk_together_members (match_id, user_id, joined_at) VALUES (?, ?, ?)');
      for (const u of userIds) stmt.run(matchId, u, now);
    },
    cancelAllForUser(userId: string, now: string): void {
      db.prepare("UPDATE walk_together_requests SET status = 'cancelled' WHERE user_id = ? AND status = 'open'").run(userId);
      db.prepare("UPDATE walk_together_matches SET status = 'cancelled', updated_at = ? WHERE (user_a = ? OR user_b = ?) AND status IN ('proposed', 'accepted')").run(now, userId, userId);
    },
  };
}

export type WalkTogetherRepository = ReturnType<typeof createWalkTogetherRepository>;
