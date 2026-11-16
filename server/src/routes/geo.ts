import { Router } from 'express';
import { z } from 'zod';
import {
  coverageQuerySchema,
  geoSearchQuerySchema,
  neighbourhoodListQuerySchema,
  pointQuerySchema,
  type LngLat,
} from '@mahilasathi/shared';
import { requireAuth } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { parseQuery } from '../middleware/validate.js';
import type { GeoRegistry } from '../services/geography/geoRegistry.js';
import type { CoverageService } from '../services/geography/coverageService.js';
import type { GeoService } from '../services/geography/geoService.js';
import { notFound } from '../utils/errors.js';

const boundariesQuery = z.object({ level: z.enum(['district', 'state', 'ncr']).default('district') });

/**
 * Search, reverse and resolve take user-entered text or coordinates and may call a paid provider,
 * so they require sign-in. Boundaries, districts and neighbourhoods are public reference data.
 */
export function geoRouter(deps: { registry: GeoRegistry; geo: GeoService; coverage?: CoverageService; searchLimit: number }): Router {
  const { registry, geo } = deps;
  const router = Router();
  const searchLimiter = createRateLimiter({ windowMs: 60_000, limit: deps.searchLimit, message: 'Too many searches. Please slow down.' });

  router.get('/geo/search', requireAuth, searchLimiter, async (req, res) => {
    const { q, limit } = parseQuery(req, geoSearchQuerySchema);
    res.json(await geo.search(q, limit));
  });

  router.get('/geo/reverse', requireAuth, searchLimiter, async (req, res) => {
    const { lat, lng } = parseQuery(req, pointQuerySchema);
    res.json(await geo.reverse(lat, lng));
  });

  router.get('/geo/resolve', requireAuth, (req, res) => {
    const { lat, lng } = parseQuery(req, pointQuerySchema);
    res.json(registry.resolve(lat, lng));
  });

  router.get('/geo/neighbourhoods', (req, res) => {
    const query = parseQuery(req, neighbourhoodListQuerySchema);
    let near: LngLat | undefined;
    if (query.near) {
      const [lat, lng] = query.near.split(',').map(Number) as [number, number];
      near = [lng, lat];
    }
    res.json({ neighbourhoods: registry.listNeighbourhoods({ ...query, near }) });
  });

  router.get('/geo/districts', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=3600').json({ districts: registry.listDistricts(), dataset: registry.dataset });
  });

  router.get('/geo/coverage', (req, res) => {
    const query = parseQuery(req, coverageQuerySchema);
    if ('areaType' in query) {
      const exists =
        query.areaType === 'district' ? registry.districtRef(query.areaId) : registry.neighbourhoodEntry(query.areaId);
      if (!exists) throw notFound('Area');
      // First view (or a stale one) triggers a background assessment from live place data.
      deps.coverage?.ensureFresh(query.areaType, query.areaId);
      res.json({ areaType: query.areaType, areaId: query.areaId, coverage: registry.coverageFor(query.areaType, query.areaId) });
      return;
    }
    const r = registry.resolve(query.lat, query.lng);
    res.json({
      areaType: r.neighbourhood ? 'neighbourhood' : r.district ? 'district' : null,
      areaId: r.neighbourhood?.id ?? r.district?.id ?? null,
      inNcr: r.inNcr,
      coverage: r.coverage,
    });
  });

  router.get('/geo/boundaries', (req, res) => {
    const { level } = parseQuery(req, boundariesQuery);
    res
      .set('Cache-Control', 'public, max-age=3600')
      .type('application/geo+json')
      .send(registry.boundariesGeoJson(level));
  });

  return router;
}
