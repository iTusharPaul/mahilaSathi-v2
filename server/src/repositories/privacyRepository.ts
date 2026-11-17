import type { Db } from '../db/connection.js';

/**
 * Reads for "download my data" and bulk privacy actions. Every query is scoped to one user and returns only
 * that user's own records; other people appear by display name or pseudonym only, never by phone or location.
 */
export function createPrivacyRepository(db: Db) {
  const all = (sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as Record<string, unknown>[];
  const one = (sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as Record<string, unknown> | undefined;

  return {
    exportFor(userId: string) {
      const trips = all(
        `SELECT t.id, t.status, t.mode, t.origin_label, t.destination_label, t.destination_area, t.origin_lat, t.origin_lng, t.destination_lat, t.destination_lng,
           t.departure_time, t.started_at, t.expected_arrival_at, t.arrived_at, t.ended_at, t.feedback, t.created_at,
           r.label AS route_label, r.distance_m, r.duration_s, r.score, r.geometry_json
         FROM trips t LEFT JOIN trip_routes r ON r.trip_id = t.id WHERE t.user_id = ? ORDER BY t.created_at`,
        userId,
      ).map(({ geometry_json, ...t }) => ({
        ...t,
        routeGeometry: geometry_json ? JSON.parse(String(geometry_json)) : null,
        checkins: all('SELECT kind, note, created_at FROM trip_checkins WHERE trip_id = ? ORDER BY created_at', t.id),
        liveLocations: all('SELECT lat, lng, accuracy_m, recorded_at FROM trip_locations WHERE trip_id = ? ORDER BY recorded_at', t.id),
        sharedWith: all(
          'SELECT c.name AS circle, s.level, s.created_at, s.revoked_at FROM trip_shares s JOIN circles c ON c.id = s.circle_id WHERE s.trip_id = ?',
          t.id,
        ),
      }));
      const sos = all(
        `SELECT id, status, outcome, note, location_detail, contacts_policy, escalate_after_minutes, lat, lng, area_name, location_recorded_at,
           activated_at, ended_at FROM sos_events WHERE user_id = ? ORDER BY activated_at`,
        userId,
      ).map((e) => ({
        ...e,
        recipients: all(
          `SELECT r.kind, r.name, r.location_level, a.response, a.acknowledged_at FROM sos_recipients r
           LEFT JOIN sos_acknowledgements a ON a.recipient_id = r.id WHERE r.sos_id = ?`,
          e.id,
        ),
        deliveries: all('SELECT channel, purpose, status, attempts, last_error, accepted_at, delivered_at FROM sos_deliveries WHERE sos_id = ?', e.id),
      }));
      return {
        account: one(
          "SELECT id, phone_e164 AS phone, email, CASE WHEN google_sub IS NULL THEN 'phone' ELSE 'google' END AS sign_in_method, display_name, community_handle, home_district_id, home_neighbourhood_id, created_at FROM users WHERE id = ?",
          userId,
        ),
        preferences: one('SELECT * FROM user_preferences WHERE user_id = ?', userId) ?? null,
        sosSettings: one('SELECT location_detail, emergency_contacts, escalate_after_minutes, shortcut FROM sos_settings WHERE user_id = ?', userId) ?? null,
        emergencyContacts: all('SELECT name, phone_e164 AS phone, relationship, priority FROM emergency_contacts WHERE user_id = ? ORDER BY priority', userId),
        guardianCircles: all(
          `SELECT c.name, m.role, m.status, m.joined_at FROM circle_members m JOIN circles c ON c.id = m.circle_id WHERE m.user_id = ?`,
          userId,
        ),
        communityChannels: all(
          `SELECT ch.kind, ch.name, m.role, m.status, m.joined_at FROM community_memberships m JOIN community_channels ch ON ch.id = m.channel_id WHERE m.user_id = ?`,
          userId,
        ),
        blockedUsers: all('SELECT u.community_handle AS handle, b.created_at FROM user_blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ?', userId),
        journeys: trips,
        walkTogether: all(
          `SELECT m.status, m.overlap_pct, m.shared_areas_json, m.created_at,
             (SELECT community_handle FROM users WHERE id = CASE WHEN m.user_a = ? THEN m.user_b ELSE m.user_a END) AS other_handle
           FROM walk_together_matches m WHERE m.user_a = ? OR m.user_b = ?`,
          userId,
          userId,
          userId,
        ),
        communityReports: all('SELECT category, description, area_name, occurred_at, status, created_at, expires_at FROM community_reports WHERE user_id = ?', userId),
        routePlans: all('SELECT id, created_at, expires_at FROM route_plans WHERE user_id = ?', userId),
        sos,
        myActivityLog: all('SELECT occurred_at, action, target_type, metadata_json FROM audit_events WHERE actor_id = ? ORDER BY occurred_at', userId),
      };
    },

    /** Turns off live location on every open journey and deletes the stored points. */
    stopTripLocations(userId: string): number {
      return db.transaction(() => {
        const ids = (
          db.prepare("SELECT id FROM trips WHERE user_id = ? AND location_sharing = 1 AND status IN ('CREATED', 'ACTIVE', 'DELAYED', 'ESCALATED')").all(userId) as { id: string }[]
        ).map((r) => r.id);
        for (const id of ids) {
          db.prepare('UPDATE trips SET location_sharing = 0 WHERE id = ?').run(id);
          db.prepare('DELETE FROM trip_locations WHERE trip_id = ?').run(id);
        }
        return ids.length;
      })();
    },

    /** Deletes ended journeys (with routes, check-ins, shares and live points by cascade). Returns their ids. */
    deleteEndedTrips(userId: string): string[] {
      return db.transaction(() => {
        const ids = (db.prepare("SELECT id FROM trips WHERE user_id = ? AND status IN ('ARRIVED', 'CANCELLED')").all(userId) as { id: string }[]).map((r) => r.id);
        const del = db.prepare('DELETE FROM trips WHERE id = ?');
        for (const id of ids) del.run(id);
        return ids;
      })();
    },
  };
}

export type PrivacyRepository = ReturnType<typeof createPrivacyRepository>;
