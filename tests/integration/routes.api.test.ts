import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { routePlanSchema, type LngLat } from '@mahilasathi/shared';
import { ProviderError } from '../../server/src/services/geography/providers/types.js';
import {
  NoRouteError,
  createSyntheticRouting,
  normaliseGeoapifyRoute,
  placeKind,
  type CameraProvider,
  type PlacesProvider,
  type RoutingProvider,
} from '../../server/src/services/routing/providers.js';
import type { PlaceRecord, RouteCandidate } from '../../server/src/services/scoring/types.js';
import { createTestApp, signIn } from '../helpers/testApp.js';

// Cyber City (Gurugram, Haryana) → Saket (Delhi): a cross-state journey.
const CYBER_CITY = { lat: 28.495, lng: 77.0895 };
const SAKET = { lat: 28.5245, lng: 77.2066 };
const NIGHT = '2026-11-12T17:00:00.000Z'; // 22:30 IST

function line(from: LngLat, to: LngLat, bend = 0): LngLat[] {
  return Array.from({ length: 51 }, (_, i) => {
    const t = i / 50;
    return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t + Math.sin(Math.PI * t) * bend];
  });
}

function fakeRouting(opts: { fail?: 'all' | 'noroute' } = {}): RoutingProvider & { calls: number } {
  const p = {
    name: 'fake-routing',
    mode: 'live' as const,
    calls: 0,
    variants: () => [
      { variant: 'balanced', label: 'Recommended by routing' },
      { variant: 'short', label: 'Shortest distance' },
    ],
    async route(o: LngLat, d: LngLat, _mode: string, variant: string): Promise<RouteCandidate> {
      p.calls++;
      if (opts.fail === 'all') throw new ProviderError('fake', 'down');
      if (opts.fail === 'noroute') throw new NoRouteError('fake');
      const coords = line(o, d, variant === 'short' ? 0 : 0.02);
      return {
        variant,
        label: variant,
        synthetic: false,
        distanceM: variant === 'short' ? 13_000 : 17_000,
        durationS: variant === 'short' ? 1500 : 1300,
        coordinates: coords,
        steps: [
          { fromIndex: 0, toIndex: 25, distanceM: 8000, roadClass: 'trunk', instructionType: 'StartAtRight' },
          { fromIndex: 25, toIndex: 50, distanceM: variant === 'short' ? 5000 : 9000, roadClass: variant === 'short' ? 'residential' : 'primary', instructionType: 'Left' },
        ],
      };
    },
  };
  return p;
}

/** Puts a few places along the straight (short) variant only. */
function fakePlaces(opts: { fail?: boolean } = {}): PlacesProvider & { calls: number } {
  const along = line([CYBER_CITY.lng, CYBER_CITY.lat], [SAKET.lng, SAKET.lat]);
  const places: PlaceRecord[] = [
    { id: 'p1', name: '24x7 Store', kind: 'shop', lat: along[10]![1], lng: along[10]![0], openingHours: '24/7' },
    { id: 'p2', name: 'Dhaba', kind: 'food', lat: along[20]![1], lng: along[20]![0], openingHours: 'Mo-Su 11:00-01:00' },
    { id: 'p3', name: 'Bakery', kind: 'food', lat: along[30]![1], lng: along[30]![0], openingHours: 'Mo-Su 08:00-20:00' },
    { id: 'p4', name: 'Saket', kind: 'metro', lat: along[45]![1], lng: along[45]![0], openingHours: null },
    { id: 'p5', name: 'Police Post', kind: 'police', lat: along[35]![1], lng: along[35]![0], openingHours: null },
  ];
  const p = {
    name: 'fake-places',
    calls: 0,
    async fetchCell(b: { minLng: number; minLat: number; maxLng: number; maxLat: number }, layer: string) {
      p.calls++;
      if (opts.fail) throw new ProviderError('fake', 'down');
      const inCell = places.filter((x) => x.lng >= b.minLng && x.lng < b.maxLng && x.lat >= b.minLat && x.lat < b.maxLat);
      return { places: inCell.filter((x) => (layer === 'transit' ? ['metro', 'bus'].includes(x.kind) : !['metro', 'bus'].includes(x.kind))), truncated: false };
    },
  };
  return p;
}

const failingCameras: CameraProvider = { name: 'fake-cameras', fetch: async () => { throw new ProviderError('overpass', 'timed out'); } };

// All tests run at a fixed time just before the 22:30 IST departure, so results never depend on today's date.
const CLOCK = () => new Date('2026-11-12T16:55:00.000Z');
function app(providers: NonNullable<Parameters<typeof createTestApp>[0]>['routingProviders']) {
  return createTestApp({ clock: CLOCK, routingProviders: providers });
}

const planBody = (over: Record<string, unknown> = {}) => ({ origin: CYBER_CITY, destination: SAKET, departureTime: NIGHT, mode: 'drive', ...over });

describe('POST /api/routes/plan', () => {
  it('plans a cross-state journey with scored alternatives, explanations and rankings', async () => {
    const { app: a } = app({ routing: fakeRouting(), places: fakePlaces(), cameras: failingCameras });
    const { agent } = await signIn(a);
    const res = await agent.post('/api/routes/plan').send(planBody()).expect(201);
    const plan = routePlanSchema.parse(res.body);

    expect(plan.routes).toHaveLength(2);
    expect(plan.origin.resolution.state?.id).toBe('haryana');
    expect(plan.destination.resolution.state?.id).toBe('delhi');
    expect(plan.notices.join(' ')).toMatch(/crosses Haryana → NCT of Delhi\. It is planned as one journey/);
    expect(plan.routes[0]!.jurisdictions.map((j) => j.stateId)).toEqual(expect.arrayContaining(['haryana', 'delhi']));

    const best = plan.routes.find((r) => r.distanceM === 13_000)!; // the straight variant passes the fake places
    expect(best.score).not.toBeNull();
    expect(best.metrics).toMatchObject({ openEstablishments: 2, hoursKnown: 3, mappedEstablishments: 3, transitStops: 1, assistancePoints: 1 });
    // Cameras unavailable: excluded with zero applied weight, never scored as 0.
    const cam = best.factors.find((f) => f.key === 'cameraCoverage')!;
    expect(cam).toMatchObject({ score: null, appliedWeight: 0 });
    expect(plan.providers.cameras.status).toBe('unavailable');
    expect(best.factors.reduce((s, f) => s + f.appliedWeight, 0)).toBeCloseTo(1, 6);
    expect(best.reasons.length).toBeGreaterThan(0);
    expect(plan.rankings.fastest[0]).toBe(plan.routes.find((r) => r.durationS === 1300)!.id);
    expect(plan.disclaimer).toMatch(/not a guarantee/);
  });

  it('rejects places outside NCR and trips that are too short', async () => {
    const { app: a } = app({ routing: fakeRouting(), places: fakePlaces(), cameras: null });
    const { agent } = await signIn(a);
    const out = await agent.post('/api/routes/plan').send(planBody({ origin: { lat: 26.9124, lng: 75.7873 } })).expect(400);
    expect(out.body.error.message).toMatch(/outside the National Capital Region/);
    await agent.post('/api/routes/plan').send(planBody({ destination: CYBER_CITY })).expect(400);
    await agent.post('/api/routes/plan').send(planBody({ departureTime: '2030-01-01T00:00:00.000Z' })).expect(400);
    await agent.post('/api/routes/plan').send(planBody({ mode: 'teleport' })).expect(400);
  });

  it('distinguishes "no route exists" from a provider outage', async () => {
    const noRoute = app({ routing: fakeRouting({ fail: 'noroute' }), places: null, cameras: null });
    const s1 = await signIn(noRoute.app);
    expect((await s1.agent.post('/api/routes/plan').send(planBody({ mode: 'walk' })).expect(400)).body.error.message).toMatch(/No walking route was found/);

    const down = app({ routing: fakeRouting({ fail: 'all' }), places: null, cameras: null });
    const s2 = await signIn(down.app);
    expect((await s2.agent.post('/api/routes/plan').send(planBody()).expect(503)).body.error.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('treats place data as unknown when the provider fails, and withholds a score rather than guessing', async () => {
    const { app: a } = app({ routing: fakeRouting(), places: fakePlaces({ fail: true }), cameras: failingCameras });
    const { agent } = await signIn(a);
    const plan = routePlanSchema.parse((await agent.post('/api/routes/plan').send(planBody()).expect(201)).body);
    expect(plan.providers.places.status).toBe('unavailable');
    expect(plan.notices.join(' ')).toMatch(/Place data could not be fetched/);
    for (const r of plan.routes) {
      expect(r.factors.filter((f) => f.score === null).map((f) => f.key)).toEqual(
        expect.arrayContaining(['openEstablishments', 'publicTransport', 'longestLowActivity', 'assistance', 'cameraCoverage']),
      );
      // Only main roads (0.16) + simplicity (0.07) are known: below the minimum, so no score.
      expect(r.score).toBeNull();
      expect(r.confidence).toBe('low');
      expect(r.reasons[0]).toBe('Not enough information to score this route');
    }
  });

  it('caches routing and place data, and shows when it was fetched', async () => {
    const routing = fakeRouting();
    const places = fakePlaces();
    const { app: a } = app({ routing, places, cameras: null });
    const { agent } = await signIn(a);
    const first = routePlanSchema.parse((await agent.post('/api/routes/plan').send(planBody()).expect(201)).body);
    const calls = { routing: routing.calls, places: places.calls };
    const second = routePlanSchema.parse((await agent.post('/api/routes/plan').send(planBody()).expect(201)).body);
    expect(routing.calls).toBe(calls.routing);
    expect(places.calls).toBe(calls.places);
    expect(first.providers.places.cached).toBe(false);
    expect(second.providers.places).toMatchObject({ cached: true, fetchedAt: first.providers.places.fetchedAt });
  });

  it('labels synthetic routes when no routing provider is configured', async () => {
    const { app: a } = app({ routing: createSyntheticRouting(), places: null, cameras: null });
    const { agent } = await signIn(a);
    const plan = routePlanSchema.parse((await agent.post('/api/routes/plan').send(planBody()).expect(201)).body);
    expect(plan.providers.routing).toEqual({ name: 'synthetic', mode: 'dev-adapter' });
    expect(plan.routes[0]!.synthetic).toBe(true);
    expect(plan.notices[0]).toMatch(/Synthetic route.*not real roads/);
  });

  it('requires sign-in', async () => {
    const { app: a } = app({ routing: fakeRouting(), places: null, cameras: null });
    await request(a).post('/api/routes/plan').send(planBody()).expect(401);
  });
});

describe('route detail, explanation and comparison', () => {
  it('serves the owner’s routes and hides them from everyone else', async () => {
    const { app: a } = app({ routing: fakeRouting(), places: fakePlaces(), cameras: null });
    const owner = await signIn(a);
    const other = await signIn(a);
    const plan = routePlanSchema.parse((await owner.agent.post('/api/routes/plan').send(planBody()).expect(201)).body);
    const id = plan.routes[0]!.id;

    expect((await owner.agent.get(`/api/routes/${id}`).expect(200)).body.id).toBe(id);
    const why = (await owner.agent.get(`/api/routes/${id}/explanation`).expect(200)).body;
    expect(why.factors).toHaveLength(8);
    expect(why.methodology.scale).toMatch(/not a safety probability/);

    const cmp = (await owner.agent.post('/api/routes/compare').send({ planId: plan.planId, ranking: 'fastest' }).expect(200)).body;
    expect(cmp.routes.map((r: { durationS: number }) => r.durationS)).toEqual([1300, 1500]);

    await other.agent.get(`/api/routes/${id}`).expect(404);
    await other.agent.get(`/api/routes/${id}/explanation`).expect(404);
    await other.agent.post('/api/routes/compare').send({ planId: plan.planId, ranking: 'score' }).expect(404);
    await owner.agent.get('/api/routes/not-a-route').expect(400);
  });

  it('deletes stored plans (which hold exact coordinates) with the account', async () => {
    const { app: a, db } = app({ routing: fakeRouting(), places: null, cameras: null });
    const { agent, user } = await signIn(a);
    await agent.post('/api/routes/plan').send(planBody()).expect(201);
    expect((db.prepare('SELECT COUNT(*) AS n FROM route_plans WHERE user_id = ?').get(user.id) as { n: number }).n).toBe(1);
    await agent.delete('/api/users/me').send({ confirm: 'DELETE' }).expect(204);
    expect((db.prepare('SELECT COUNT(*) AS n FROM route_plans WHERE user_id = ?').get(user.id) as { n: number }).n).toBe(0);
  });
});

describe('provider adapters', () => {
  it('normalises Geoapify multi-leg routes, shifting step indices per leg', () => {
    const body = {
      features: [
        {
          geometry: { type: 'MultiLineString', coordinates: [[[77, 28], [77.01, 28]], [[77.01, 28], [77.02, 28], [77.03, 28]]] },
          properties: {
            distance: 3000,
            time: 300,
            legs: [
              { steps: [{ from_index: 0, to_index: 1, distance: 1000, road_class: 'primary', instruction: { type: 'StartAt' } }] },
              { steps: [{ from_index: 0, to_index: 2, distance: 2000, road_class: 'residential', instruction: { type: 'Left' } }] },
            ],
          },
        },
      ],
    };
    const r = normaliseGeoapifyRoute(body, 'balanced', 'Recommended');
    expect(r.coordinates).toHaveLength(5);
    expect(r.steps[1]).toMatchObject({ fromIndex: 2, toIndex: 4, roadClass: 'residential', instructionType: 'Left' });
    expect(() => normaliseGeoapifyRoute({ statusCode: 400 }, 'x', 'x')).toThrow(ProviderError);
  });

  it('maps Geoapify categories to place kinds', () => {
    expect(placeKind(['public_transport', 'public_transport.subway'])).toBe('metro');
    expect(placeKind(['public_transport.subway.entrance'])).toBe('metro');
    expect(placeKind(['catering', 'catering.fast_food'])).toBe('food');
    expect(placeKind(['service', 'service.police'])).toBe('police');
    expect(placeKind(['building'])).toBeNull();
  });

  it('keeps the map tile proxy disabled without a key', async () => {
    const { app: a } = createTestApp({ clock: CLOCK });
    const { agent } = await signIn(a);
    await agent.get('/api/map/tiles/light/14/11718/6874.png').expect(404);
    await request(a).get('/api/map/tiles/light/14/11718/6874.png').expect(401);
  });
});
