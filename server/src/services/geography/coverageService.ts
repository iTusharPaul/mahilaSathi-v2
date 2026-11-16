import type { Logger } from 'pino';
import type { Coverage } from '@mahilasathi/shared';
import type { Db } from '../../db/connection.js';
import type { Clock } from '../../utils/crypto.js';
import type { RoutePlanningService } from '../routing/routePlanningService.js';
import { ESTABLISHMENT_KINDS } from '../scoring/types.js';
import type { GeoRegistry } from './geoRegistry.js';

const DAY = 86_400_000;

/**
 * Data coverage describes how complete the MAP DATA is around a neighbourhood, never how safe it is.
 * Thresholds are deliberately simple and published here and in docs/geography.md.
 */
export const COVERAGE_RULES = {
  staleAfterMs: 7 * DAY,
  high: { establishmentsPerKm2: 40, hoursShare: 0.2 },
  medium: { establishmentsPerKm2: 15, hoursShare: 0.08 },
} as const;

export function coverageLevel(establishmentsPerKm2: number, hoursShare: number): 'high' | 'medium' | 'low' {
  const { high, medium } = COVERAGE_RULES;
  if (establishmentsPerKm2 >= high.establishmentsPerKm2 && hoursShare >= high.hoursShare) return 'high';
  if (establishmentsPerKm2 >= medium.establishmentsPerKm2 && hoursShare >= medium.hoursShare) return 'medium';
  return 'low';
}

export function createCoverageService(deps: { db: Db; registry: GeoRegistry; planning: RoutePlanningService; hasPlaceProvider: boolean; clock: Clock; logger: Logger }) {
  const { db, registry, planning, hasPlaceProvider, clock, logger } = deps;
  const inFlight = new Set<string>();
  const upsert = db.prepare(
    `INSERT INTO coverage_assessments (area_type, area_id, level, basis_json, source, assessed_at) VALUES ('neighbourhood', ?, ?, ?, ?, ?)
     ON CONFLICT (area_type, area_id) DO UPDATE SET level = excluded.level, basis_json = excluded.basis_json, source = excluded.source, assessed_at = excluded.assessed_at`,
  );

  /** Assesses one curated neighbourhood from live place data. Returns null when data couldn't be fetched (nothing is stored). */
  async function assessNeighbourhood(id: string): Promise<Coverage | null> {
    const n = registry.neighbourhoodEntry(id);
    if (!n || !hasPlaceProvider) return null;
    const res = await planning.placesAround({ lat: n.center[1], lng: n.center[0] }, n.radiusM);
    if (!res.places) {
      logger.warn({ neighbourhood: id }, 'coverage assessment skipped: place data unavailable');
      return null;
    }
    const establishments = res.places.filter((p) => ESTABLISHMENT_KINDS.includes(p.kind));
    const withHours = establishments.filter((p) => p.openingHours !== null).length;
    const transit = res.places.filter((p) => p.kind === 'metro' || p.kind === 'bus').length;
    const areaKm2 = (Math.PI * n.radiusM * n.radiusM) / 1e6;
    const density = establishments.length / areaKm2;
    const hoursShare = establishments.length ? withHours / establishments.length : 0;
    const level = coverageLevel(density, hoursShare);
    const summary =
      `${establishments.length} shops, cafés and other places mapped within ${(n.radiusM / 1000).toFixed(1)} km ` +
      `(${Math.round(density)} per km²), ${Math.round(hoursShare * 100)}% with opening hours, ${transit} transit stops. ` +
      'This describes how complete the map data is, not how safe the area is.';
    const assessedAt = clock().toISOString();
    const coverage: Coverage = { level, summary, assessedAt, source: 'OpenStreetMap via Geoapify' };
    upsert.run(
      id,
      level,
      JSON.stringify({ summary, establishments: establishments.length, withHours, transitStops: transit, areaKm2: Math.round(areaKm2 * 100) / 100, establishmentsPerKm2: Math.round(density * 10) / 10, hoursShare: Math.round(hoursShare * 1000) / 1000, placeDataFetchedAt: res.fetchedAt, truncated: res.status === 'partial', rules: COVERAGE_RULES }),
      coverage.source,
      assessedAt,
    );
    registry.setCoverage('neighbourhood', id, coverage);
    return coverage;
  }

  return {
    assessNeighbourhood,

    /** Non-blocking: if a neighbourhood has never been assessed (or is stale), assess it in the background. */
    ensureFresh(areaType: 'district' | 'neighbourhood', id: string): void {
      if (areaType !== 'neighbourhood' || !hasPlaceProvider || inFlight.has(id)) return;
      const current = registry.coverageFor('neighbourhood', id);
      if (current.assessedAt && clock().getTime() - Date.parse(current.assessedAt) < COVERAGE_RULES.staleAfterMs) return;
      inFlight.add(id);
      void assessNeighbourhood(id)
        .catch((err: unknown) => logger.warn({ neighbourhood: id, reason: (err as Error).message }, 'coverage assessment failed'))
        .finally(() => inFlight.delete(id));
    },

    /** Every curated neighbourhood, one at a time (used by `npm run coverage:assess`). */
    async assessAll(onProgress?: (id: string, c: Coverage | null) => void): Promise<{ assessed: number; skipped: number }> {
      let assessed = 0;
      let skipped = 0;
      for (const n of registry.listNeighbourhoods({ limit: 1000 })) {
        const c = await assessNeighbourhood(n.id).catch(() => null);
        if (c) assessed++;
        else skipped++;
        onProgress?.(n.id, c);
      }
      return { assessed, skipped };
    },
  };
}

export type CoverageService = ReturnType<typeof createCoverageService>;
