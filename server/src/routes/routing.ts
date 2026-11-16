import { Router } from 'express';
import { z } from 'zod';
import { compareRequestSchema, planRouteRequestSchema } from '@mahilasathi/shared';
import { currentAuth, requireAuth } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { parseBody, parseParams } from '../middleware/validate.js';
import type { RoutePlanningService } from '../services/routing/routePlanningService.js';
import { AppError } from '../utils/errors.js';

const routeParams = z.object({ id: z.string().regex(/^[0-9a-f-]{36}\.\d{1,2}$/, 'Invalid route id') });
const tileParams = z.object({
  style: z.enum(['light', 'dark']),
  z: z.coerce.number().int().min(0).max(19),
  x: z.coerce.number().int().min(0),
  y: z.coerce.number().int().min(0),
});
const TILE_STYLES = { light: 'osm-bright-grey', dark: 'dark-matter-brown' } as const;

export function routingRouter(deps: {
  planning: RoutePlanningService;
  geoapifyKey: string | null;
  planLimit: number;
  tileLimit: number;
  fetchImpl?: typeof fetch;
}): Router {
  const { planning } = deps;
  const router = Router();
  const planLimiter = createRateLimiter({ windowMs: 15 * 60_000, limit: deps.planLimit, message: 'Too many route plans in a short time. Please wait a few minutes.' });
  const tileLimiter = createRateLimiter({ windowMs: 10 * 60_000, limit: deps.tileLimit, message: 'Too many map requests.' });

  router.post('/routes/plan', requireAuth, planLimiter, async (req, res) => {
    res.status(201).json(await planning.plan(currentAuth(req).user, parseBody(req, planRouteRequestSchema)));
  });

  router.post('/routes/compare', requireAuth, (req, res) => {
    const { planId, ranking } = parseBody(req, compareRequestSchema);
    res.json(planning.compare(currentAuth(req).user, planId, ranking));
  });

  router.get('/routes/:id', requireAuth, (req, res) => {
    res.json(planning.getRoute(currentAuth(req).user, parseParams(req, routeParams).id));
  });

  router.get('/routes/:id/explanation', requireAuth, (req, res) => {
    res.json(planning.explanation(currentAuth(req).user, parseParams(req, routeParams).id));
  });

  /** Raster map tiles proxied from Geoapify so the API key never reaches the browser. */
  router.get('/map/tiles/:style/:z/:x/:y.png', requireAuth, tileLimiter, async (req, res) => {
    if (!deps.geoapifyKey) throw new AppError('NOT_FOUND', 'Map tiles are not configured');
    const { style, z: zoom, x, y } = parseParams(req, tileParams);
    const max = 2 ** zoom;
    if (x >= max || y >= max) throw new AppError('BAD_REQUEST', 'Tile out of range');
    const upstream = await (deps.fetchImpl ?? fetch)(
      `https://maps.geoapify.com/v1/tile/${TILE_STYLES[style]}/${zoom}/${x}/${y}.png?apiKey=${encodeURIComponent(deps.geoapifyKey)}`,
      { signal: AbortSignal.timeout(10_000) },
    ).catch(() => null);
    if (!upstream || !upstream.ok) throw new AppError('PROVIDER_UNAVAILABLE', 'Map tiles are temporarily unavailable');
    res
      .set('Content-Type', 'image/png')
      .set('Cache-Control', 'private, max-age=86400')
      .send(Buffer.from(await upstream.arrayBuffer()));
  });

  return router;
}
