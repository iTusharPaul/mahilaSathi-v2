import crypto from 'node:crypto';
import type { ShareLevel, TripStatus } from '@mahilasathi/shared';
import type { Db } from '../db/connection.js';

export interface TripRow {
  id: string;
  user_id: string;
  status: TripStatus;
  mode: 'walk' | 'drive';
  origin_lat: number | null;
  origin_lng: number | null;
  destination_lat: number | null;
  destination_lng: number | null;
  origin_label: string | null;
  destination_label: string | null;
  destination_area: string | null;
  departure_time: string;
  expected_duration_s: number;
  started_at: string | null;
  expected_arrival_at: string | null;
  delayed_at: string | null;
  escalated_at: string | null;
  arrived_at: string | null;
  ended_at: string | null;
  last_checkin_at: string | null;
  next_checkin_due_at: string | null;
  location_sharing: number;
  feedback: 'comfortable' | 'uneasy' | null;
  created_at: string;
  updated_at: string;
}

export interface TripRouteRow {
  trip_id: string;
  plan_route_id: string;
  label: string;
  distance_m: number;
  duration_s: number;
  score: number | null;
  confidence: string;
  geometry_json: string;
}

export interface ShareRow {
  id: string;
  trip_id: string;
  circle_id: string;
  level: ShareLevel;
  created_at: string;
  revoked_at: string | null;
}

const OPEN_STATUSES = "('CREATED', 'ACTIVE', 'DELAYED', 'ESCALATED')";

export function createTripRepository(db: Db) {
  return {
    insertTrip(t: TripRow, route: TripRouteRow, corridor: string[]): void {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO trips (id, user_id, status, mode, origin_lat, origin_lng, destination_lat, destination_lng, origin_label, destination_label,
             destination_area, departure_time, expected_duration_s, started_at, expected_arrival_at, delayed_at, escalated_at, arrived_at, ended_at,
             last_checkin_at, next_checkin_due_at, location_sharing, feedback, created_at, updated_at)
           VALUES (@id, @user_id, @status, @mode, @origin_lat, @origin_lng, @destination_lat, @destination_lng, @origin_label, @destination_label,
             @destination_area, @departure_time, @expected_duration_s, @started_at, @expected_arrival_at, @delayed_at, @escalated_at, @arrived_at, @ended_at,
             @last_checkin_at, @next_checkin_due_at, @location_sharing, @feedback, @created_at, @updated_at)`,
        ).run(t);
        db.prepare(
          `INSERT INTO trip_routes (trip_id, plan_route_id, label, distance_m, duration_s, score, confidence, geometry_json)
           VALUES (@trip_id, @plan_route_id, @label, @distance_m, @duration_s, @score, @confidence, @geometry_json)`,
        ).run(route);
        const seg = db.prepare('INSERT INTO corridor_segments (trip_id, seq, cell) VALUES (?, ?, ?)');
        corridor.forEach((cell, i) => seg.run(t.id, i, cell));
      })();
    },
    trip: (id: string) => db.prepare('SELECT * FROM trips WHERE id = ?').get(id) as TripRow | undefined,
    route: (tripId: string) => db.prepare('SELECT * FROM trip_routes WHERE trip_id = ?').get(tripId) as TripRouteRow | undefined,
    corridor: (tripId: string) =>
      (db.prepare('SELECT cell FROM corridor_segments WHERE trip_id = ? ORDER BY seq').all(tripId) as { cell: string }[]).map((r) => r.cell),
    openTripForUser: (userId: string) =>
      db.prepare(`SELECT * FROM trips WHERE user_id = ? AND status IN ${OPEN_STATUSES} ORDER BY created_at DESC LIMIT 1`).get(userId) as TripRow | undefined,
    recentTrips: (userId: string, limit = 20) =>
      db.prepare('SELECT * FROM trips WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit) as TripRow[],

    /** Guarded update: only applies if the trip is still in `from` (prevents racing transitions). */
    transition(id: string, from: TripStatus, fields: Partial<TripRow> & { status: TripStatus }, now: string): boolean {
      const keys = Object.keys(fields) as (keyof TripRow)[];
      return (
        db
          .prepare(`UPDATE trips SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @__now WHERE id = @__id AND status = @__from`)
          .run({ ...fields, __now: now, __id: id, __from: from }).changes === 1
      );
    },
    update(id: string, fields: Partial<TripRow>, now: string): void {
      const keys = Object.keys(fields) as (keyof TripRow)[];
      if (keys.length === 0) return;
      db.prepare(`UPDATE trips SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @__now WHERE id = @__id`).run({ ...fields, __now: now, __id: id });
    },
    insertCheckin(tripId: string, kind: 'start' | 'manual' | 'arrival', note: string | null, now: string): void {
      db.prepare('INSERT INTO trip_checkins (id, trip_id, kind, note, created_at) VALUES (?, ?, ?, ?, ?)').run(crypto.randomUUID(), tripId, kind, note, now);
    },

    // ─── Shares ───────────────────────────────────────────────────────────────
    upsertShare(tripId: string, circleId: string, level: ShareLevel, now: string): string {
      const existing = db.prepare('SELECT id FROM trip_shares WHERE trip_id = ? AND circle_id = ?').get(tripId, circleId) as { id: string } | undefined;
      if (existing) {
        db.prepare('UPDATE trip_shares SET level = ?, revoked_at = NULL WHERE id = ?').run(level, existing.id);
        return existing.id;
      }
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO trip_shares (id, trip_id, circle_id, level, created_at) VALUES (?, ?, ?, ?, ?)').run(id, tripId, circleId, level, now);
      return id;
    },
    revokeShares: (tripId: string, now: string) =>
      db.prepare('UPDATE trip_shares SET revoked_at = ? WHERE trip_id = ? AND revoked_at IS NULL').run(now, tripId).changes,
    sharesForTrip: (tripId: string) => db.prepare('SELECT * FROM trip_shares WHERE trip_id = ? ORDER BY created_at').all(tripId) as ShareRow[],
    share: (id: string) => db.prepare('SELECT * FROM trip_shares WHERE id = ?').get(id) as ShareRow | undefined,
    /** Shares visible to a guardian: active shares into circles where they are an active, non-owner member. */
    sharesForGuardian: (userId: string) =>
      db
        .prepare(
          `SELECT s.* FROM trip_shares s
           JOIN circle_members m ON m.circle_id = s.circle_id AND m.user_id = ? AND m.status = 'active' AND m.role = 'guardian'
           JOIN trips t ON t.id = s.trip_id
           WHERE s.revoked_at IS NULL AND t.user_id != ? ORDER BY t.updated_at DESC LIMIT 50`,
        )
        .all(userId, userId) as ShareRow[],
    acknowledge(shareId: string, userId: string, now: string): void {
      db.prepare('INSERT OR IGNORE INTO trip_share_acks (share_id, user_id, acknowledged_at) VALUES (?, ?, ?)').run(shareId, userId, now);
    },
    acknowledgedBy: (shareId: string) =>
      (
        db
          .prepare('SELECT u.display_name, u.community_handle FROM trip_share_acks a JOIN users u ON u.id = a.user_id WHERE a.share_id = ? ORDER BY a.acknowledged_at')
          .all(shareId) as { display_name: string | null; community_handle: string }[]
      ).map((r) => r.display_name ?? r.community_handle),
    isAcknowledged: (shareId: string, userId: string) => db.prepare('SELECT 1 FROM trip_share_acks WHERE share_id = ? AND user_id = ?').get(shareId, userId) !== undefined,

    // ─── Location ─────────────────────────────────────────────────────────────
    insertLocation(tripId: string, lat: number, lng: number, accuracyM: number | null, now: string): void {
      db.prepare('INSERT INTO trip_locations (id, trip_id, lat, lng, accuracy_m, recorded_at) VALUES (?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(), tripId, lat, lng, accuracyM, now);
    },
    latestLocation: (tripId: string) =>
      db.prepare('SELECT lat, lng, accuracy_m, recorded_at FROM trip_locations WHERE trip_id = ? ORDER BY recorded_at DESC LIMIT 1').get(tripId) as
        | { lat: number; lng: number; accuracy_m: number | null; recorded_at: string }
        | undefined,
    deleteLocations: (tripId: string) => db.prepare('DELETE FROM trip_locations WHERE trip_id = ?').run(tripId).changes,

    // ─── Scheduled work ───────────────────────────────────────────────────────
    overdueActive: (now: string) =>
      db.prepare("SELECT * FROM trips WHERE status = 'ACTIVE' AND expected_arrival_at IS NOT NULL AND expected_arrival_at < ?").all(now) as TripRow[],
    staleCreated: (before: string) => db.prepare("SELECT * FROM trips WHERE status = 'CREATED' AND departure_time < ?").all(before) as TripRow[],
    /** Retention: live locations 24 h after a journey ends; exact endpoints 30 days after. */
    purge(locationsBefore: string, coordinatesBefore: string): { locations: number; coordinates: number } {
      const locations = db
        .prepare('DELETE FROM trip_locations WHERE trip_id IN (SELECT id FROM trips WHERE ended_at IS NOT NULL AND ended_at < ?)')
        .run(locationsBefore).changes;
      const coordinates = db
        .prepare(
          `UPDATE trips SET origin_lat = NULL, origin_lng = NULL, destination_lat = NULL, destination_lng = NULL, origin_label = NULL, destination_label = NULL
           WHERE ended_at IS NOT NULL AND ended_at < ? AND origin_lat IS NOT NULL`,
        )
        .run(coordinatesBefore).changes;
      return { locations, coordinates };
    },
  };
}

export type TripRepository = ReturnType<typeof createTripRepository>;
