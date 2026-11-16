import { describe, expect, it } from 'vitest';
import {
  distanceToBoundaryMeters,
  haversineMeters,
  maskPhone,
  multiPolygonAreaKm2,
  normalizeIndianMobile,
  pointInMultiPolygon,
  pointInPolygon,
  simplifyRing,
  type MultiPolygonCoords,
  type PolygonCoords,
  type Ring,
} from '@mahilasathi/shared';

// A 1°×1° square near Delhi with a 0.2° hole in the middle.
const square: Ring = [[77, 28], [78, 28], [78, 29], [77, 29], [77, 28]];
const hole: Ring = [[77.4, 28.4], [77.6, 28.4], [77.6, 28.6], [77.4, 28.6], [77.4, 28.4]];
const withHole: PolygonCoords = [square, hole];

describe('point in polygon', () => {
  it('handles the outer ring and holes', () => {
    expect(pointInPolygon([77.1, 28.1], withHole)).toBe(true);
    expect(pointInPolygon([77.5, 28.5], withHole)).toBe(false); // inside the hole
    expect(pointInPolygon([76.9, 28.5], withHole)).toBe(false);
  });

  it('handles multipolygons', () => {
    const multi: MultiPolygonCoords = [[square], [[[80, 20], [81, 20], [81, 21], [80, 21], [80, 20]]]];
    expect(pointInMultiPolygon([80.5, 20.5], multi)).toBe(true);
    expect(pointInMultiPolygon([79, 25], multi)).toBe(false);
  });
});

describe('distances and areas', () => {
  it('computes haversine distance (CP to India Gate ≈ 2.2 km)', () => {
    const d = haversineMeters([77.2167, 28.6315], [77.2295, 28.6129]);
    expect(d).toBeGreaterThan(2_100);
    expect(d).toBeLessThan(2_500);
  });

  it('measures distance to the nearest edge, including hole edges', () => {
    // 0.01° east of the west edge at 28.1°N ≈ 980 m.
    expect(distanceToBoundaryMeters([77.01, 28.1], [withHole])).toBeCloseTo(980, -1);
    // Just outside the hole's west edge.
    expect(distanceToBoundaryMeters([77.399, 28.5], [withHole])).toBeLessThan(110);
  });

  it('computes spherical area and subtracts holes', () => {
    // 1° × 1° at ~28.5°N ≈ 111.2 km × 97.7 km ≈ 10,860 km²
    const full = multiPolygonAreaKm2([[square]]);
    expect(full).toBeGreaterThan(10_700);
    expect(full).toBeLessThan(11_000);
    expect(multiPolygonAreaKm2([withHole])).toBeCloseTo(full * 0.96, -1);
  });
});

describe('simplifyRing', () => {
  it('drops points within tolerance and keeps the ring closed', () => {
    const noisy: Ring = [[77, 28], [77.5, 28.00001], [78, 28], [78, 29], [77, 29], [77, 28]];
    const out = simplifyRing(noisy, 30);
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual(out[out.length - 1]);
  });
});

describe('Indian mobile numbers', () => {
  it.each([
    ['9876543210', '+919876543210'],
    ['+91 98765 43210', '+919876543210'],
    ['+91-98765-43210', '+919876543210'],
    ['09876543210', '+919876543210'],
    ['919876543210', '+919876543210'],
    ['0091 9876543210', '+919876543210'],
  ])('normalises %s', (input, expected) => {
    expect(normalizeIndianMobile(input)).toBe(expected);
  });

  it.each(['12345', '5876543210', '98765432101', '+1 415 555 0100', 'abcdefghij'])('rejects %s', (input) => {
    expect(normalizeIndianMobile(input)).toBeNull();
  });

  it('masks all but the last four digits', () => {
    expect(maskPhone('+919876543210')).toBe('+91 ••••• •3210');
  });
});
