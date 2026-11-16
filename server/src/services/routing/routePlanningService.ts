import crypto from 'node:crypto';
import {
  FACTOR_LABELS,
  SAFETY_DISCLAIMER,
  type LngLat,
  type PlanRouteRequest,
  type Ranking,
  type RoutePlan,
  type ScoredRoute,
  type TravelMode,
} from '@mahilasathi/shared';
import type { Logger } from 'pino';
import type { RoutingRepository } from '../../repositories/routingRepository.js';
import type { UserRow } from '../../repositories/userRepository.js';
import { AppError, notFound } from '../../utils/errors.js';
import type { Clock } from '../../utils/crypto.js';
import type { GeoRegistry } from '../geography/geoRegistry.js';
import { effectiveWeights } from '../scoring/nightActivityScore.js';
import { evaluateRoute, explain, rank, type Evaluated } from '../scoring/evaluate.js';
import { RouteLine } from '../scoring/routeGeometry.js';
import type { PlaceRecord, RouteCandidate, ScoringContext } from '../scoring/types.js';
import { corridorCells } from '../journeys/corridor.js';
import type { PulseService } from '../pulse/pulseService.js';
import { NoRouteError, type CameraProvider, type PlaceLayer, type PlacesProvider, type RoutingProvider } from './providers.js';

export const ROUTING_LIMITS = {
  minDistanceM: 50,
  maxDistanceM: 150_000,
  maxDepartureAheadMs: 7 * 24 * 60 * 60_000,
  maxDepartureBehindMs: 30 * 60_000,
  planTtlMs: 24 * 60 * 60_000,
  routeCacheTtlMs: 24 * 60 * 60_000,
  placesCacheTtlMs: 7 * 24 * 60 * 60_000,
  cellDeg: 0.02,
  maxCells: 60,
  maxCameraBboxDeg: 0.35,
  /** After a camera-provider failure, skip it for this long instead of waiting on timeouts. */
  cameraBackoffMs: 10 * 60_000,
} as const;

const LETTERS = 'ABCDEFGH';

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/** Two variants are the same route if lengths are within 3% and almost all of one lies on the other. */
export function isDuplicateRoute(a: RouteCandidate, b: RouteCandidate): boolean {
  if (Math.abs(a.distanceM - b.distanceM) / Math.max(a.distanceM, b.distanceM) > 0.03) return false;
  const la = new RouteLine(a.coordinates);
  const lb = new RouteLine(b.coordinates);
  const samples = la.sample(250);
  const on = samples.filter((p) => lb.project(p).offsetM <= 60).length;
  return on / samples.length >= 0.9;
}

export function cellsForRoutes(routes: RouteCandidate[], cellDeg: number = ROUTING_LIMITS.cellDeg): string[] {
  const cells = new Set<string>();
  const pad = 0.003; // ~300 m, the widest scoring corridor
  for (const r of routes) {
    for (const [lng, lat] of new RouteLine(r.coordinates).sample(250)) {
      for (const dLat of [-pad, pad]) for (const dLng of [-pad, pad]) cells.add(`${Math.floor((lat + dLat) / cellDeg)}:${Math.floor((lng + dLng) / cellDeg)}`);
    }
  }
  return [...cells];
}

const cellBbox = (cellId: string, cellDeg: number = ROUTING_LIMITS.cellDeg) => {
  const [i, j] = cellId.split(':').map(Number) as [number, number];
  return { minLat: i * cellDeg, minLng: j * cellDeg, maxLat: (i + 1) * cellDeg, maxLng: (j + 1) * cellDeg };
};

export function createRoutePlanningService(deps: {
  registry: GeoRegistry;
  repo: RoutingRepository;
  routing: RoutingProvider;
  places: PlacesProvider | null;
  cameras: CameraProvider | null;
  pulse?: PulseService;
  clock: Clock;
  logger: Logger;
}) {
  const { registry, repo, routing, clock, logger } = deps;
  const nowIso = () => clock().toISOString();
  const later = (ms: number) => new Date(clock().getTime() + ms).toISOString();

  async function fetchRoute(origin: LngLat, destination: LngLat, mode: TravelMode, variant: string): Promise<RouteCandidate> {
    if (routing.mode !== 'live') return routing.route(origin, destination, mode, variant);
    const key = crypto
      .createHash('sha256')
      .update(`${routing.name}|${mode}|${variant}|${origin.map((x) => x.toFixed(4))}|${destination.map((x) => x.toFixed(4))}`)
      .digest('hex');
    const cached = repo.getRoute(key, nowIso());
    if (cached) return cached.response as RouteCandidate;
    try {
      const route = await routing.route(origin, destination, mode, variant);
      repo.putRoute(key, routing.name, route, nowIso(), later(ROUTING_LIMITS.routeCacheTtlMs));
      repo.recordProvider(routing.name, true, nowIso());
      return route;
    } catch (err) {
      repo.recordProvider(routing.name, false, nowIso(), (err as Error).message);
      throw err;
    }
  }

  /** All-or-nothing: if any cell can't be fetched (after one retry), place data is treated as unknown. */
  type PlacesResult = { places: PlaceRecord[] | null; fetchedAt: string | null; cached: boolean; status: 'ok' | 'partial' | 'unavailable'; note: string | null };

  async function fetchPlaces(routes: RouteCandidate[]): Promise<PlacesResult> {
    if (!deps.places) return { places: null, fetchedAt: null, cached: false, status: 'unavailable', note: 'No place-data provider is configured, so place-based factors are not counted.' };
    const cells = cellsForRoutes(routes);
    if (cells.length > ROUTING_LIMITS.maxCells) {
      return { places: null, fetchedAt: null, cached: false, status: 'unavailable', note: 'This route is too long to assess place data along all of it, so place-based factors are not counted.' };
    }
    return fetchPlacesForCells(cells);
  }

  /** Places for a set of grid cells, from the 7-day cache or the provider. All-or-nothing, like route scoring. */
  async function fetchPlacesForCells(cells: string[]): Promise<PlacesResult> {
    if (!deps.places) return { places: null, fetchedAt: null, cached: false, status: 'unavailable', note: 'No place-data provider is configured.' };
    const provider = deps.places;
    const jobs = cells.flatMap((cell) => (['amenities', 'transit'] as PlaceLayer[]).map((layer) => ({ cell, layer })));
    let anyLive = false;
    let truncated = false;
    let oldest: string | null = null;
    const results = await pool(jobs, 4, async ({ cell, layer }) => {
      const hit = repo.getCell(cell, layer, nowIso());
      if (hit) {
        truncated ||= hit.truncated;
        oldest = !oldest || hit.fetchedAt < oldest ? hit.fetchedAt : oldest;
        return hit.payload as PlaceRecord[];
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await provider.fetchCell(cellBbox(cell), layer);
          const at = nowIso();
          repo.putCell(cell, layer, provider.name, res.places, res.truncated, at, later(ROUTING_LIMITS.placesCacheTtlMs));
          repo.recordProvider(provider.name, true, at);
          anyLive = true;
          truncated ||= res.truncated;
          oldest = !oldest || at < oldest ? at : oldest;
          return res.places;
        } catch (err) {
          repo.recordProvider(provider.name, false, nowIso(), (err as Error).message);
          logger.warn({ provider: provider.name, reason: (err as Error).message }, 'place cell fetch failed');
        }
      }
      return null;
    });
    if (results.some((r) => r === null)) {
      return { places: null, fetchedAt: null, cached: false, status: 'unavailable', note: 'Place data could not be fetched for the whole route, so place-based factors are not counted.' };
    }
    const byId = new Map<string, PlaceRecord>();
    for (const list of results) for (const p of list!) byId.set(p.id, p);
    return {
      places: [...byId.values()],
      fetchedAt: oldest,
      cached: !anyLive,
      status: truncated ? 'partial' : 'ok',
      note: truncated ? 'Some very dense areas returned the maximum number of places, so counts there are a lower bound.' : null,
    };
  }

  async function fetchCameras(routes: RouteCandidate[]): Promise<{ cameras: { lat: number; lng: number }[] | null; fetchedAt: string | null }> {
    if (!deps.cameras) return { cameras: null, fetchedAt: null };
    const health = repo.providerStatus(deps.cameras.name);
    const backingOff = health && health.consecutiveFailures > 0 && health.lastFailureAt && clock().getTime() - Date.parse(health.lastFailureAt) < ROUTING_LIMITS.cameraBackoffMs;
    const boxes = routes.map((r) => new RouteLine(r.coordinates).bbox());
    const pad = 0.003;
    const g = ROUTING_LIMITS.cellDeg;
    const b = {
      minLat: Math.floor((Math.min(...boxes.map((x) => x.minLat)) - pad) / g) * g,
      minLng: Math.floor((Math.min(...boxes.map((x) => x.minLng)) - pad) / g) * g,
      maxLat: Math.ceil((Math.max(...boxes.map((x) => x.maxLat)) + pad) / g) * g,
      maxLng: Math.ceil((Math.max(...boxes.map((x) => x.maxLng)) + pad) / g) * g,
    };
    if (b.maxLat - b.minLat > ROUTING_LIMITS.maxCameraBboxDeg || b.maxLng - b.minLng > ROUTING_LIMITS.maxCameraBboxDeg) return { cameras: null, fetchedAt: null };
    const key = `${b.minLat.toFixed(2)},${b.minLng.toFixed(2)},${b.maxLat.toFixed(2)},${b.maxLng.toFixed(2)}`;
    const hit = repo.getCell(key, 'cameras', nowIso());
    if (hit) return { cameras: hit.payload as { lat: number; lng: number }[], fetchedAt: hit.fetchedAt };
    if (backingOff) return { cameras: null, fetchedAt: null };
    try {
      const cameras = await deps.cameras.fetch(b);
      const at = nowIso();
      repo.putCell(key, 'cameras', deps.cameras.name, cameras, false, at, later(ROUTING_LIMITS.placesCacheTtlMs));
      repo.recordProvider(deps.cameras.name, true, at);
      return { cameras, fetchedAt: at };
    } catch (err) {
      repo.recordProvider(deps.cameras.name, false, nowIso(), (err as Error).message);
      logger.warn({ provider: deps.cameras.name, reason: (err as Error).message }, 'camera data unavailable');
      return { cameras: null, fetchedAt: null };
    }
  }

  function jurisdictions(line: RouteLine): ScoredRoute['jurisdictions'] {
    const out: ScoredRoute['jurisdictions'] = [];
    for (const [lng, lat] of line.sample(1000)) {
      const r = registry.resolve(lat, lng);
      if (!r.inNcr || !r.state || !r.district) continue;
      const last = out[out.length - 1];
      if (!last || last.districtName !== r.district.name) out.push({ stateId: r.state.id, stateName: r.state.name, districtName: r.district.name });
    }
    return out;
  }

  function findPlanRoute(user: UserRow, routeId: string): { plan: RoutePlan; route: ScoredRoute } {
    const [planId] = routeId.split('.');
    const plan = planId ? (repo.getPlan(planId, user.id, nowIso()) as RoutePlan | null) : null;
    const route = plan?.routes.find((r) => r.id === routeId);
    if (!plan || !route) throw notFound('Route');
    return { plan, route };
  }

  return {
    async plan(user: UserRow, req: PlanRouteRequest & { mode: TravelMode; preferences: { fewerIsolatedStretches: boolean; preferMainRoads: boolean } }): Promise<RoutePlan> {
      const now = clock().getTime();
      const departure = req.departureTime ? new Date(req.departureTime) : new Date(now);
      if (departure.getTime() < now - ROUTING_LIMITS.maxDepartureBehindMs || departure.getTime() > now + ROUTING_LIMITS.maxDepartureAheadMs) {
        throw new AppError('VALIDATION_FAILED', 'Choose a departure time within the next 7 days');
      }
      const originRes = registry.resolve(req.origin.lat, req.origin.lng);
      const destRes = registry.resolve(req.destination.lat, req.destination.lng);
      if (!originRes.inNcr || !destRes.inNcr) {
        throw new AppError('VALIDATION_FAILED', `${!originRes.inNcr ? 'The start' : 'The destination'} is outside the National Capital Region. mahilaSathi plans journeys within Delhi NCR.`);
      }
      const origin: LngLat = [req.origin.lng, req.origin.lat];
      const destination: LngLat = [req.destination.lng, req.destination.lat];
      const straight = new RouteLine([origin, destination]).length;
      if (straight < ROUTING_LIMITS.minDistanceM) throw new AppError('VALIDATION_FAILED', 'Start and destination are too close together to plan a route.');
      if (straight > ROUTING_LIMITS.maxDistanceM) throw new AppError('VALIDATION_FAILED', 'This journey is too long to plan.');

      // 1. Route variants (failures of individual variants are tolerated; all failing is not).
      const variants = routing.variants(req.mode);
      const fetched = await Promise.all(variants.map((v) => fetchRoute(origin, destination, req.mode, v.variant).catch((err: unknown) => err)));
      const candidates = fetched.filter((r): r is RouteCandidate => !(r instanceof Error));
      for (const [i, r] of fetched.entries()) {
        if (r instanceof Error) logger.warn({ variant: variants[i]?.variant, mode: req.mode, reason: r.message }, 'route variant failed');
      }
      if (candidates.length === 0) {
        if (fetched.every((r) => r instanceof NoRouteError)) {
          throw new AppError('VALIDATION_FAILED', `No ${req.mode === 'walk' ? 'walking' : 'driving'} route was found between these points. Try moving the start or destination to a nearby road.`);
        }
        throw new AppError('PROVIDER_UNAVAILABLE', 'Routes could not be fetched right now. Please try again shortly.');
      }
      const unique: RouteCandidate[] = [];
      for (const c of candidates) if (!unique.some((u) => isDuplicateRoute(u, c))) unique.push(c);

      // 2. Context data shared by all routes.
      const [placeData, cameraData] = await Promise.all([fetchPlaces(unique), fetchCameras(unique)]);
      const ctx: ScoringContext = {
        mode: req.mode,
        departure,
        places: placeData.places,
        placesFetchedAt: placeData.fetchedAt,
        cameras: cameraData.cameras,
        camerasFetchedAt: cameraData.fetchedAt,
      };
      if (deps.pulse) {
        const sufficient = new Map<string, number>();
        let updatedAt: string | null = null;
        for (const r of unique) {
          const res = deps.pulse.routeCells(r.coordinates);
          for (const [cell, v] of res.sufficient) sufficient.set(cell, v);
          if (res.updatedAt && (!updatedAt || res.updatedAt > updatedAt)) updatedAt = res.updatedAt;
        }
        ctx.pulse = { sufficient, updatedAt, cellsFor: (g) => corridorCells(g, 0, 150) };
      }

      // 3. Score, explain, rank.
      const prefs = req.preferences;
      const evaluated: Evaluated[] = unique.map((r) => evaluateRoute(r, ctx, prefs));
      const reasons = explain(evaluated);
      const planId = crypto.randomUUID();
      const order = [...evaluated.keys()].sort((a, b) => (evaluated[b]!.result.score ?? -1) - (evaluated[a]!.result.score ?? -1) || evaluated[a]!.route.durationS - evaluated[b]!.route.durationS);
      const routes: ScoredRoute[] = order.map((i, position) => {
        const e = evaluated[i]!;
        return {
          id: `${planId}.${position}`,
          label: `Route ${LETTERS[position]}`,
          variant: e.route.label,
          synthetic: e.route.synthetic,
          score: e.result.score,
          confidence: e.result.confidence,
          confidenceValue: e.result.confidenceValue,
          durationS: Math.round(e.route.durationS),
          distanceM: Math.round(e.route.distanceM),
          turns: e.turns,
          metrics: e.metrics,
          factors: e.result.factors,
          reasons: reasons[i]!,
          jurisdictions: jurisdictions(e.line),
          geometry: e.route.coordinates.map(([lng, lat]) => [Math.round(lng * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5] as [number, number]),
          places: e.markers,
        };
      });

      const notices: string[] = [];
      if (routes.some((r) => r.synthetic)) notices.push('Synthetic route: no routing provider is configured. This is a straight line, not real roads.');
      if (placeData.note) notices.push(placeData.note);
      if (!cameraData.cameras) notices.push(`${FACTOR_LABELS.cameraCoverage}: data was unavailable, so it is not counted.`);
      for (const [name, r] of [['start', originRes], ['destination', destRes]] as const) {
        if (r.needsManualConfirmation) notices.push(`The ${name} is close to a boundary; the area shown may be approximate.`);
      }
      const states = [...new Set(routes[0]?.jurisdictions.map((j) => j.stateName) ?? [])];
      if (states.length > 1) notices.push(`This journey crosses ${states.join(' → ')}. It is planned as one journey.`);

      const plan: RoutePlan = {
        planId,
        createdAt: nowIso(),
        departureTime: departure.toISOString(),
        mode: req.mode,
        origin: { label: req.origin.label ?? null, resolution: originRes },
        destination: { label: req.destination.label ?? null, resolution: destRes },
        routes,
        rankings: rank(routes),
        providers: {
          routing: { name: routing.name, mode: routing.mode },
          places: { name: deps.places?.name ?? 'none', status: placeData.status, fetchedAt: placeData.fetchedAt, cached: placeData.cached },
          cameras: { name: deps.cameras?.name ?? 'none', status: cameraData.cameras ? 'ok' : 'unavailable', fetchedAt: cameraData.fetchedAt },
        },
        notices,
        disclaimer: SAFETY_DISCLAIMER,
      };
      repo.insertPlan({
        id: planId,
        userId: user.id,
        origin: req.origin,
        destination: req.destination,
        departureTime: plan.departureTime,
        mode: req.mode,
        preferences: prefs,
        result: plan,
        createdAt: plan.createdAt,
        expiresAt: later(ROUTING_LIMITS.planTtlMs),
      });
      return plan;
    },

    /** The owner's plan and route, for starting a journey from it. */
    planRoute(user: UserRow, routeId: string): { plan: RoutePlan; route: ScoredRoute } {
      return findPlanRoute(user, routeId);
    },

    getRoute(user: UserRow, routeId: string): ScoredRoute {
      return findPlanRoute(user, routeId).route;
    },

    explanation(user: UserRow, routeId: string) {
      const { plan, route } = findPlanRoute(user, routeId);
      return {
        routeId,
        label: route.label,
        score: route.score,
        confidence: route.confidence,
        reasons: route.reasons,
        factors: route.factors,
        methodology: {
          scale: '0–100 contextual Night Activity Score. It describes available context, not a safety probability or guarantee.',
          baseWeights: effectiveWeights({ fewerIsolatedStretches: false, preferMainRoads: false }),
          unknownFactors: 'Factors without data are excluded and the remaining weights are scaled up proportionally; confidence is lowered.',
          departureTime: plan.departureTime,
        },
        disclaimer: plan.disclaimer,
      };
    },

    compare(user: UserRow, planId: string, ranking: Ranking) {
      const plan = repo.getPlan(planId, user.id, nowIso()) as RoutePlan | null;
      if (!plan) throw notFound('Route plan');
      const byId = new Map(plan.routes.map((r) => [r.id, r]));
      return {
        planId,
        ranking,
        routes: plan.rankings[ranking].map((id) => {
          const r = byId.get(id)!;
          return { id, label: r.label, score: r.score, confidence: r.confidence, durationS: r.durationS, distanceM: r.distanceM, reasons: r.reasons };
        }),
      };
    },

    purge: () => repo.purge(nowIso()),

    /** Mapped places within a circle (e.g. a neighbourhood), reusing the same cells and cache as route scoring. */
    async placesAround(center: { lat: number; lng: number }, radiusM: number): Promise<PlacesResult> {
      const g = ROUTING_LIMITS.cellDeg;
      const dLat = radiusM / 111_320;
      const dLng = radiusM / (111_320 * Math.cos((center.lat * Math.PI) / 180));
      const cells: string[] = [];
      for (let i = Math.floor((center.lat - dLat) / g); i <= Math.floor((center.lat + dLat) / g); i++) {
        for (let j = Math.floor((center.lng - dLng) / g); j <= Math.floor((center.lng + dLng) / g); j++) cells.push(`${i}:${j}`);
      }
      const res = await fetchPlacesForCells(cells);
      if (!res.places) return res;
      const inside = res.places.filter((p) => new RouteLine([[center.lng, center.lat], [p.lng, p.lat]]).length <= radiusM);
      return { ...res, places: inside };
    },
  };
}

export type RoutePlanningService = ReturnType<typeof createRoutePlanningService>;
