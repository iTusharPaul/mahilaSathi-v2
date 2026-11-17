import type { UsageReport } from '@mahilasathi/shared';
import type { Db } from '../db/connection.js';

const DAY_MS = 24 * 60 * 60_000;
/** Days are counted in India Standard Time, which is when people use the app. */
const IST = "'+330 minutes'";

/**
 * Aggregate usage for the moderator screen (traction evidence). Counts only: no names, numbers, emails or
 * locations. The fictional demo accounts are always excluded, and so is everything they do.
 */
export function createUsageRepository(db: Db) {
  const n = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { n: number | null }).n ?? 0;
  const REAL = "SELECT id FROM users WHERE is_demo = 0";

  return {
    report(now: Date, days = 14): UsageReport {
      const iso = (ms: number) => new Date(ms).toISOString();
      const nowMs = now.getTime();
      const since = iso(nowMs - days * DAY_MS);

      const accounts = db
        .prepare(
          `SELECT COUNT(*) AS total,
                  COALESCE(SUM(google_sub IS NOT NULL), 0) AS google,
                  COALESCE(SUM(google_sub IS NULL), 0) AS phone
           FROM users WHERE is_demo = 0 AND status = 'active'`,
        )
        .get() as { total: number; google: number; phone: number };

      const signUps = db
        .prepare(
          `SELECT date(created_at, ${IST}) AS day, COUNT(*) AS count FROM users
           WHERE is_demo = 0 AND created_at >= ? GROUP BY day ORDER BY day`,
        )
        .all(since) as { day: string; count: number }[];

      const activeSince = (ms: number) =>
        n(`SELECT COUNT(DISTINCT user_id) AS n FROM user_sessions WHERE last_seen_at >= ? AND user_id IN (${REAL})`, iso(nowMs - ms));

      return {
        generatedAt: now.toISOString(),
        accounts: { ...accounts, deleted: n(`SELECT COUNT(*) AS n FROM users WHERE is_demo = 0 AND status = 'deleted'`) },
        signUpsByDay: signUps,
        activeUsers: { last24h: activeSince(DAY_MS), last7d: activeSince(7 * DAY_MS) },
        // Signed in on at least two different days: people who came back, not one-off visits.
        returningUsers: n(
          `SELECT COUNT(*) AS n FROM (
             SELECT actor_id FROM audit_events
             WHERE action = 'auth.login' AND actor_id IN (${REAL})
             GROUP BY actor_id HAVING COUNT(DISTINCT date(occurred_at, ${IST})) >= 2)`,
        ),
        routeComparisonsLast24h: n(`SELECT COUNT(*) AS n FROM route_plans WHERE created_at >= ? AND user_id IN (${REAL})`, iso(nowMs - DAY_MS)),
        journeys: {
          created: n(`SELECT COUNT(*) AS n FROM trips WHERE user_id IN (${REAL})`),
          started: n(`SELECT COUNT(*) AS n FROM trips WHERE started_at IS NOT NULL AND user_id IN (${REAL})`),
          arrived: n(`SELECT COUNT(*) AS n FROM trips WHERE status = 'ARRIVED' AND user_id IN (${REAL})`),
        },
        guardianCircles: n(
          `SELECT COUNT(*) AS n FROM circles c WHERE c.owner_id IN (${REAL})
             AND (SELECT COUNT(*) FROM circle_members m WHERE m.circle_id = c.id AND m.status = 'active') >= 2`,
        ),
        sosRaised: n(`SELECT COUNT(*) AS n FROM sos_events WHERE is_demo = 0`),
        usersWithNotifications: n(`SELECT COUNT(DISTINCT user_id) AS n FROM push_subscriptions WHERE user_id IN (${REAL})`),
        usersInCommunityChannels: n(
          `SELECT COUNT(DISTINCT user_id) AS n FROM community_memberships WHERE status = 'active' AND user_id IN (${REAL})`,
        ),
      };
    },
  };
}

export type UsageRepository = ReturnType<typeof createUsageRepository>;
