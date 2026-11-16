import { describe, expect, it } from 'vitest';
import { BASE_WEIGHTS, FACTOR_KEYS, type LngLat } from '@mahilasathi/shared';
import { evaluateRoute, explain, rank } from '../../server/src/services/scoring/evaluate.js';
import {
  GAP_HALF_SCORE_M,
  communityPulse,
  longestLowActivity,
  mainRoadCoverage,
  openEstablishments,
  placesOnRoute,
  routeSimplicity,
  type FactorValue,
} from '../../server/src/services/scoring/factors.js';
import { MIN_KNOWN_WEIGHT, combine, effectiveWeights } from '../../server/src/services/scoring/nightActivityScore.js';
import { isOpenAt, istWallClock } from '../../server/src/services/scoring/openingHours.js';
import { RouteLine, longestGap } from '../../server/src/services/scoring/routeGeometry.js';
import type { PlaceRecord, RouteCandidate, ScoringContext } from '../../server/src/services/scoring/types.js';
import { isDuplicateRoute } from '../../server/src/services/routing/routePlanningService.js';

// A straight 2 km east-west route along latitude 28.6 (≈ 0.02047° of longitude per 2 km).
const START: LngLat = [77.2, 28.6];
const lngAt = (m: number) => 77.2 + (m / 2000) * 0.02047;
const route = (over: Partial<RouteCandidate> = {}): RouteCandidate => ({
  variant: 'balanced',
  label: 'Test',
  synthetic: false,
  distanceM: 2000,
  durationS: 600,
  coordinates: Array.from({ length: 21 }, (_, i) => [lngAt(i * 100), 28.6] as LngLat),
  steps: [
    { fromIndex: 0, toIndex: 10, distanceM: 1000, roadClass: 'primary', instructionType: 'StartAtRight' },
    { fromIndex: 10, toIndex: 20, distanceM: 1000, roadClass: 'residential', instructionType: 'Left' },
  ],
  ...over,
});
const place = (alongM: number, kind: PlaceRecord['kind'], openingHours: string | null = null, offsetDeg = 0.0002): PlaceRecord => ({
  id: `${kind}-${alongM}-${openingHours}`,
  name: kind,
  kind,
  lat: 28.6 + offsetDeg,
  lng: lngAt(alongM),
  openingHours,
});
// 22:30 IST on a Thursday = 17:00 UTC.
const NIGHT = new Date('2026-11-12T17:00:00.000Z');
const ctx = (over: Partial<ScoringContext> = {}): ScoringContext => ({
  mode: 'walk',
  departure: NIGHT,
  places: [],
  placesFetchedAt: '2026-11-12T10:00:00.000Z',
  cameras: [],
  camerasFetchedAt: '2026-11-12T10:00:00.000Z',
  ...over,
});
const NO_PREFS = { fewerIsolatedStretches: false, preferMainRoads: false };

describe('weights', () => {
  it('match the specification and sum to 1', () => {
    expect(BASE_WEIGHTS).toEqual({
      openEstablishments: 0.22,
      publicTransport: 0.1,
      mainRoadCoverage: 0.16,
      longestLowActivity: 0.2,
      routeSimplicity: 0.07,
      assistance: 0.1,
      cameraCoverage: 0.05,
      communityPulse: 0.1,
    });
    expect(FACTOR_KEYS.reduce((s, k) => s + BASE_WEIGHTS[k], 0)).toBeCloseTo(1, 10);
  });

  it('apply preferences as a ×1.5 boost and renormalise', () => {
    const w = effectiveWeights({ fewerIsolatedStretches: true, preferMainRoads: true });
    expect(FACTOR_KEYS.reduce((s, k) => s + w[k], 0)).toBeCloseTo(1, 10);
    expect(w.longestLowActivity / w.openEstablishments).toBeCloseTo((0.2 * 1.5) / 0.22, 10);
    expect(w.mainRoadCoverage / w.assistance).toBeCloseTo((0.16 * 1.5) / 0.1, 10);
  });
});

const value = (key: FactorValue['key'], score: number | null, confidence: FactorValue['confidence'] = 'high'): FactorValue => ({
  key,
  score,
  raw: '',
  source: 'test',
  dataTimestamp: null,
  confidence,
  explanation: '',
});
const allKnown = (score: number) => FACTOR_KEYS.map((k) => value(k, score));

describe('Night Activity Score', () => {
  it('is the weighted mean of factor scores, on a 0–100 scale', () => {
    expect(combine(allKnown(1), NO_PREFS).score).toBe(100);
    expect(combine(allKnown(0), NO_PREFS).score).toBe(0);
    const mixed = FACTOR_KEYS.map((k) => value(k, k === 'openEstablishments' ? 1 : 0));
    expect(combine(mixed, NO_PREFS).score).toBe(22);
  });

  it('excludes unknown factors and redistributes their weight instead of counting them as zero', () => {
    const values = FACTOR_KEYS.map((k) => value(k, k === 'cameraCoverage' ? null : 0.8));
    const r = combine(values, NO_PREFS);
    expect(r.score).toBe(80); // not 76, which treating the unknown as 0 would give
    expect(r.missing).toEqual(['cameraCoverage']);
    const applied = r.factors.reduce((s, f) => s + f.appliedWeight, 0);
    expect(applied).toBeCloseTo(1, 10);
    expect(r.factors.find((f) => f.key === 'cameraCoverage')!.appliedWeight).toBe(0);
    expect(r.factors.find((f) => f.key === 'openEstablishments')!.appliedWeight).toBeCloseTo(0.22 / 0.95, 10);
  });

  it('lowers confidence as factors become unknown or low-confidence', () => {
    const full = combine(allKnown(0.5), NO_PREFS);
    expect(full).toMatchObject({ confidence: 'high', confidenceValue: 1 });
    const someUnknown = combine(FACTOR_KEYS.map((k) => value(k, ['openEstablishments', 'longestLowActivity'].includes(k) ? null : 0.5)), NO_PREFS);
    expect(someUnknown.confidenceValue).toBeCloseTo(0.58, 2);
    expect(someUnknown.confidence).toBe('medium');
    const lowQuality = combine(FACTOR_KEYS.map((k) => value(k, 0.5, 'low')), NO_PREFS);
    expect(lowQuality).toMatchObject({ confidence: 'low', confidenceValue: 0.4 });
  });

  it('withholds the score when too little is known, rather than guessing', () => {
    const values = FACTOR_KEYS.map((k) => value(k, ['routeSimplicity', 'communityPulse', 'cameraCoverage'].includes(k) ? 0.9 : null));
    const r = combine(values, NO_PREFS);
    expect(0.07 + 0.05).toBeLessThan(MIN_KNOWN_WEIGHT);
    expect(r.score).toBeNull();
  });

  it('uses a neutral, low-confidence Community Pulse at cold start', () => {
    expect(communityPulse()).toMatchObject({ score: 0.5, confidence: 'low', raw: 'Insufficient community data' });
  });
});

describe('opening hours', () => {
  it('evaluates in Indian time regardless of the server time zone', () => {
    const local = istWallClock(new Date('2026-11-12T17:00:00.000Z'));
    expect([local.getHours(), local.getMinutes()]).toEqual([22, 30]);
  });

  it('handles past-midnight ranges, 24/7, closed times and unknowns', () => {
    expect(isOpenAt('Mo-Su 11:00-01:00', NIGHT)).toBe(true); // 22:30
    expect(isOpenAt('Mo-Su 11:00-01:00', new Date('2026-11-12T20:30:00.000Z'))).toBe(false); // 02:00
    expect(isOpenAt('24/7', NIGHT)).toBe(true);
    expect(isOpenAt('Mo-Sa 09:00-21:00', NIGHT)).toBe(false);
    expect(isOpenAt(null, NIGHT)).toBeNull();
    expect(isOpenAt('open when the owner feels like it', NIGHT)).toBeNull();
  });

  it('never counts a place without hours as open', () => {
    const r = route();
    const c = ctx({ places: [place(500, 'food'), place(900, 'shop'), place(1500, 'food', '24/7')] });
    const on = placesOnRoute(r, new RouteLine(r.coordinates), c);
    expect(openEstablishments(on, 2, c)).toMatchObject({ open: 1, known: 1, mapped: 3 });
  });

  it('marks the factor unknown when no hours are mapped at all', () => {
    const r = route();
    const c = ctx({ places: [place(500, 'food'), place(900, 'shop')] });
    const f = openEstablishments(placesOnRoute(r, new RouteLine(r.coordinates), c), 2, c);
    expect(f.score).toBeNull();
    expect(f.explanation).toMatch(/none is counted as open/);
  });

  it('uses the time you pass each place, not the departure time', () => {
    // Departs 21:50 IST; a 70-minute trip reaches the far end at 23:00, after the shop closes at 22:30.
    const r = route({ durationS: 70 * 60 });
    const c = ctx({ departure: new Date('2026-11-12T16:20:00.000Z'), places: [place(100, 'shop', 'Mo-Su 08:00-22:30'), place(1900, 'shop', 'Mo-Su 08:00-22:30')] });
    const on = placesOnRoute(r, new RouteLine(r.coordinates), c);
    expect(on.map((p) => p.openAtPass)).toEqual([true, false]);
  });
});

describe('longest low-activity stretch', () => {
  it('measures gaps including from the start and to the end', () => {
    expect(longestGap([500, 900], 2000)).toEqual({ lengthM: 1100, fromM: 900, toM: 2000 });
    expect(longestGap([], 2000).lengthM).toBe(2000);
    expect(longestGap([0, 1000, 2000], 2000).lengthM).toBe(1000);
  });

  it('counts any mapped place within the corridor and ignores far ones', () => {
    const r = route();
    const line = new RouteLine(r.coordinates);
    const c = ctx({ places: [place(400, 'food'), place(800, 'bus'), place(1200, 'food', null, 0.01) /* ~1.1 km away */] });
    const f = longestLowActivity(placesOnRoute(r, line, c), line, c);
    expect(f.lengthM).toBeCloseTo(1200, -1);
    expect(f.score).toBeCloseTo(1 / (1 + (1200 / GAP_HALF_SCORE_M.walk) ** 2), 2);
  });

  it('is unknown, not zero, when place data is unavailable', () => {
    const r = route();
    const line = new RouteLine(r.coordinates);
    expect(longestLowActivity([], line, ctx({ places: null })).score).toBeNull();
  });
});

describe('route-based factors', () => {
  it('computes main-road share from road classes', () => {
    expect(mainRoadCoverage(route())).toMatchObject({ pct: 0.5, confidence: 'high' });
    expect(mainRoadCoverage(route({ steps: [{ fromIndex: 0, toIndex: 20, distanceM: 2000, roadClass: null, instructionType: null }] })).score).toBeNull();
  });

  it('counts turns, not straight segments', () => {
    expect(routeSimplicity(route()).turns).toBe(1);
  });
});

describe('route evaluation and explanation', () => {
  it('scores a route end to end and reports unknown sources honestly', () => {
    const r = route();
    const e = evaluateRoute(r, ctx({ places: [place(300, 'food', '24/7'), place(1000, 'metro'), place(1700, 'police')], cameras: null }), NO_PREFS);
    expect(e.result.score).not.toBeNull();
    expect(e.result.missing).toEqual(['cameraCoverage']);
    expect(e.metrics).toMatchObject({ openEstablishments: 1, transitStops: 1, mainRoadPct: 50 });
  });

  it('explains routes relative to each other', () => {
    const busy = evaluateRoute(route({ variant: 'a' }), ctx({ places: Array.from({ length: 10 }, (_, i) => place(i * 200 + 100, 'food', '24/7')) }), NO_PREFS);
    // Mapped places that are closed at night (an empty map would make the factor unknown, not comparable).
    const quiet = evaluateRoute(route({ variant: 'b', durationS: 500 }), ctx({ places: [place(500, 'shop', 'Mo-Sa 09:00-18:00'), place(1500, 'food', 'Mo-Sa 09:00-18:00')] }), NO_PREFS);
    const [busyReasons, quietReasons] = explain([busy, quiet]);
    expect(busyReasons).toContain('More establishments open when you pass');
    expect(quietReasons).toContain('Fastest option (8 min)');
    expect(busy.result.score!).toBeGreaterThan(quiet.result.score!);
  });

  it('ranks by score, by time, and balanced', () => {
    const r = rank([
      { id: 'a', score: 80, durationS: 1800 },
      { id: 'b', score: 70, durationS: 900 },
      { id: 'c', score: null, durationS: 600 },
    ]);
    expect(r.score).toEqual(['a', 'b', 'c']);
    expect(r.fastest).toEqual(['c', 'b', 'a']);
    expect(r.balanced).toEqual(['b', 'a', 'c']);
  });

  it('treats near-identical routing variants as one route', () => {
    expect(isDuplicateRoute(route(), route({ distanceM: 2010 }))).toBe(true);
    const detour = route({ distanceM: 2600, coordinates: [START, [lngAt(1000), 28.61], [lngAt(2000), 28.6]] });
    expect(isDuplicateRoute(route(), detour)).toBe(false);
  });
});
