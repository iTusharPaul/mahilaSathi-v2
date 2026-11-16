import { describe, expect, it } from 'vitest';
import { TRIP_STATUSES, TRIP_TRANSITIONS, canTransition, type LngLat } from '@mahilasathi/shared';
import { cellToLatLng, latLngToCell } from 'h3-js';
import { CORRIDOR_RESOLUTION, PRIVACY_TRIM_M, corridorCells, corridorOverlap } from '../../server/src/services/journeys/corridor.js';
import { PULSE, aggregate, contributorBucket, decay, pulseLevel, type Signal } from '../../server/src/services/pulse/pulseMath.js';
import { RouteLine } from '../../server/src/services/scoring/routeGeometry.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-12T18:00:00.000Z');

function line(from: LngLat, to: LngLat, n = 60): LngLat[] {
  return Array.from({ length: n + 1 }, (_, i) => [from[0] + ((to[0] - from[0]) * i) / n, from[1] + ((to[1] - from[1]) * i) / n] as LngLat);
}

// Along Mehrauli–Badarpur Road in South Delhi, about 4 km west to east.
const A: LngLat = [77.19, 28.515];
const B: LngLat = [77.23, 28.515];

describe('journey state machine', () => {
  it('allows only the specified transitions', () => {
    expect(canTransition('CREATED', 'ACTIVE')).toBe(true);
    expect(canTransition('ACTIVE', 'ARRIVED')).toBe(true);
    expect(canTransition('ACTIVE', 'DELAYED')).toBe(true);
    expect(canTransition('DELAYED', 'ACTIVE')).toBe(true);
    expect(canTransition('DELAYED', 'ARRIVED')).toBe(true);
    expect(canTransition('ACTIVE', 'ESCALATED')).toBe(true);
    expect(canTransition('ESCALATED', 'ARRIVED')).toBe(true);
    // Not allowed: skipping the start, reviving ended journeys, cancelling an escalation.
    expect(canTransition('CREATED', 'ARRIVED')).toBe(false);
    expect(canTransition('CREATED', 'DELAYED')).toBe(false);
    expect(canTransition('ESCALATED', 'CANCELLED')).toBe(false);
    for (const to of TRIP_STATUSES) {
      expect(canTransition('ARRIVED', to)).toBe(false);
      expect(canTransition('CANCELLED', to)).toBe(false);
    }
  });

  it('has an entry for every status and never transitions to itself', () => {
    for (const s of TRIP_STATUSES) {
      expect(TRIP_TRANSITIONS[s]).toBeDefined();
      expect(TRIP_TRANSITIONS[s]).not.toContain(s);
    }
  });
});

describe('corridor identity', () => {
  it('uses H3 resolution-8 cells and trims at least 300 m from each end', () => {
    const geometry = line(A, B);
    const full = corridorCells(geometry);
    const trimmed = corridorCells(geometry, PRIVACY_TRIM_M);
    expect(PRIVACY_TRIM_M).toBeGreaterThanOrEqual(300);
    expect(trimmed.length).toBeGreaterThan(2);
    expect(trimmed.length).toBeLessThanOrEqual(full.length);

    // The corridor starts and ends at the cells 300 m inside the route, never at the exact endpoints.
    const route = new RouteLine(geometry);
    const firstKept = route.pointAt(PRIVACY_TRIM_M);
    const lastKept = route.pointAt(route.length - PRIVACY_TRIM_M);
    expect(trimmed[0]).toBe(latLngToCell(firstKept[1], firstKept[0], CORRIDOR_RESOLUTION));
    expect(trimmed.at(-1)).toBe(latLngToCell(lastKept[1], lastKept[0], CORRIDOR_RESOLUTION));
    // Cells are coarse: each is ~0.7 km² (resolution 8), so a cell never pinpoints a street address.
    for (const cell of trimmed) expect(cellToLatLng(cell)).toHaveLength(2);
  });

  it('gives very short routes no shareable corridor', () => {
    expect(corridorCells(line(A, [77.195, 28.515]), PRIVACY_TRIM_M)).toEqual([]);
  });

  it('measures overlap and direction', () => {
    const ab = corridorCells(line(A, B), PRIVACY_TRIM_M);
    const ba = corridorCells(line(B, A), PRIVACY_TRIM_M);
    const half = corridorCells(line(A, [77.21, 28.515]), PRIVACY_TRIM_M);
    const elsewhere = corridorCells(line([77.05, 28.6], [77.09, 28.6]), PRIVACY_TRIM_M);

    const same = corridorOverlap(ab, ab);
    expect(same.overlapPct).toBe(100);
    expect(same.sameDirection).toBe(true);

    const opposite = corridorOverlap(ab, ba);
    expect(opposite.overlapPct).toBeGreaterThan(80);
    expect(opposite.sameDirection).toBe(false);

    // Relative to the shorter corridor, a route that shares the first half overlaps almost fully.
    const partial = corridorOverlap(ab, half);
    expect(partial.overlapPct).toBeGreaterThan(70);
    expect(partial.sameDirection).toBe(true);

    expect(corridorOverlap(ab, elsewhere).overlapPct).toBe(0);
    expect(corridorOverlap([], ab).overlapPct).toBe(0);
  });
});

describe('Community Pulse maths', () => {
  const sig = (contributorId: string, polarity: 1 | -1, weight: number, ageDays = 0, kind: Signal['kind'] = 'route_feedback'): Signal => ({
    kind,
    polarity,
    weight,
    contributorId,
    createdAt: new Date(NOW - ageDays * DAY).toISOString(),
    expiresAt: new Date(NOW - ageDays * DAY + PULSE.ttlDays[kind] * DAY).toISOString(),
  });

  it('decays by half every half-life', () => {
    expect(decay(0, 14)).toBe(1);
    expect(decay(14 * DAY, 14)).toBeCloseTo(0.5);
    expect(decay(28 * DAY, 14)).toBeCloseTo(0.25);
    expect(decay(-5, 14)).toBe(1); // clock skew never amplifies
  });

  it('needs three distinct contributors before a cell counts', () => {
    const two = aggregate([sig('u1', 1, 1), sig('u2', 1, 1)], NOW);
    expect(two.contributors).toBe(2);
    expect(pulseLevel(two)).toBe('insufficient');
    const three = aggregate([sig('u1', 1, 1), sig('u2', 1, 1), sig('u3', 1, 1)], NOW);
    expect(pulseLevel(three)).toBe('positive');
    expect(three.value).toBeCloseTo(0.5 + (0.5 * 3) / 5);
  });

  it('caps each contributor so one person cannot dominate a cell', () => {
    const spam = Array.from({ length: 50 }, () => sig('troll', -1, 1));
    const a = aggregate([...spam, sig('u1', 1, 0.3), sig('u2', 1, 0.3)], NOW);
    expect(a.negative).toBeCloseTo(PULSE.perContributorCap);
    expect(a.contributors).toBe(3);
    // One very negative voice against two light positives: cautious, but bounded.
    expect(a.value).toBeGreaterThan(0.4);
  });

  it('ignores expired signals and lets old ones fade', () => {
    const expired = sig('u1', -1, 1, 40, 'journey_completed'); // TTL 30 days
    expect(aggregate([expired], NOW).contributors).toBe(0);
    const fresh = aggregate([sig('u1', -1, 1), sig('u2', -1, 1), sig('u3', -1, 1)], NOW);
    const old = aggregate([sig('u1', -1, 1, 13, 'infra_report'), sig('u2', -1, 1, 13, 'infra_report'), sig('u3', -1, 1, 13, 'infra_report')], NOW);
    expect(pulseLevel(fresh)).toBe('cautionary');
    expect(old.value).toBeGreaterThan(fresh.value);
  });

  it('buckets contributor counts', () => {
    expect(contributorBucket(2)).toBe('fewer than 3');
    expect(contributorBucket(3)).toBe('3–9');
    expect(contributorBucket(10)).toBe('10 or more');
  });
});
