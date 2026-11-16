import type { Db } from '../db/connection.js';

export interface CachedCell {
  payload: unknown;
  truncated: boolean;
  fetchedAt: string;
}

export function createRoutingRepository(db: Db) {
  return {
    getRoute(cacheKey: string, now: string): { response: unknown; fetchedAt: string } | null {
      const row = db.prepare('SELECT response_json, fetched_at FROM route_cache WHERE cache_key = ? AND expires_at > ?').get(cacheKey, now) as
        | { response_json: string; fetched_at: string }
        | undefined;
      return row ? { response: JSON.parse(row.response_json), fetchedAt: row.fetched_at } : null;
    },
    putRoute(cacheKey: string, provider: string, response: unknown, fetchedAt: string, expiresAt: string): void {
      db.prepare(
        `INSERT INTO route_cache (cache_key, provider, response_json, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (cache_key) DO UPDATE SET response_json = excluded.response_json, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
      ).run(cacheKey, provider, JSON.stringify(response), fetchedAt, expiresAt);
    },

    getCell(cellId: string, layer: string, now: string): CachedCell | null {
      const row = db.prepare('SELECT payload_json, truncated, fetched_at FROM places_cache WHERE cell_id = ? AND layer = ? AND expires_at > ?').get(cellId, layer, now) as
        | { payload_json: string; truncated: number; fetched_at: string }
        | undefined;
      return row ? { payload: JSON.parse(row.payload_json), truncated: row.truncated === 1, fetchedAt: row.fetched_at } : null;
    },
    putCell(cellId: string, layer: string, provider: string, payload: unknown, truncated: boolean, fetchedAt: string, expiresAt: string): void {
      db.prepare(
        `INSERT INTO places_cache (cell_id, layer, provider, payload_json, truncated, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (cell_id, layer) DO UPDATE SET provider = excluded.provider, payload_json = excluded.payload_json,
           truncated = excluded.truncated, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
      ).run(cellId, layer, provider, JSON.stringify(payload), truncated ? 1 : 0, fetchedAt, expiresAt);
    },

    recordProvider(provider: string, ok: boolean, now: string, error?: string): void {
      if (ok) {
        db.prepare(
          `INSERT INTO provider_cache_metadata (provider, last_success_at, consecutive_failures) VALUES (?, ?, 0)
           ON CONFLICT (provider) DO UPDATE SET last_success_at = excluded.last_success_at, consecutive_failures = 0`,
        ).run(provider, now);
      } else {
        db.prepare(
          `INSERT INTO provider_cache_metadata (provider, last_failure_at, consecutive_failures, last_error) VALUES (?, ?, 1, ?)
           ON CONFLICT (provider) DO UPDATE SET last_failure_at = excluded.last_failure_at,
             consecutive_failures = consecutive_failures + 1, last_error = excluded.last_error`,
        ).run(provider, now, (error ?? '').slice(0, 300));
      }
    },

    providerStatus(provider: string): { lastFailureAt: string | null; consecutiveFailures: number } | null {
      const row = db.prepare('SELECT last_failure_at, consecutive_failures FROM provider_cache_metadata WHERE provider = ?').get(provider) as
        | { last_failure_at: string | null; consecutive_failures: number }
        | undefined;
      return row ? { lastFailureAt: row.last_failure_at, consecutiveFailures: row.consecutive_failures } : null;
    },

    insertPlan(p: {
      id: string;
      userId: string;
      origin: { lat: number; lng: number };
      destination: { lat: number; lng: number };
      departureTime: string;
      mode: string;
      preferences: unknown;
      result: unknown;
      createdAt: string;
      expiresAt: string;
    }): void {
      db.prepare(
        `INSERT INTO route_plans (id, user_id, origin_lat, origin_lng, destination_lat, destination_lng, departure_time, mode, preferences_json, result_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(p.id, p.userId, p.origin.lat, p.origin.lng, p.destination.lat, p.destination.lng, p.departureTime, p.mode, JSON.stringify(p.preferences), JSON.stringify(p.result), p.createdAt, p.expiresAt);
    },
    /** Owner-scoped: another user's plan id simply isn't found. */
    getPlan(id: string, userId: string, now: string): unknown | null {
      const row = db.prepare('SELECT result_json FROM route_plans WHERE id = ? AND user_id = ? AND expires_at > ?').get(id, userId, now) as
        | { result_json: string }
        | undefined;
      return row ? JSON.parse(row.result_json) : null;
    },

    purge(now: string): { plans: number; routes: number; cells: number } {
      return {
        plans: db.prepare('DELETE FROM route_plans WHERE expires_at <= ?').run(now).changes,
        routes: db.prepare('DELETE FROM route_cache WHERE expires_at <= ?').run(now).changes,
        cells: db.prepare('DELETE FROM places_cache WHERE expires_at <= ?').run(now).changes,
      };
    },
  };
}

export type RoutingRepository = ReturnType<typeof createRoutingRepository>;
