/**
 * Small, dependency-free planar/spherical geometry used by the NCR registry.
 * Coordinates follow GeoJSON order: [longitude, latitude] in WGS84 degrees.
 */

export type LngLat = [number, number];
export type Ring = LngLat[];
export type PolygonCoords = Ring[];
export type MultiPolygonCoords = PolygonCoords[];

export interface BBox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (d: number) => (d * Math.PI) / 180;

export function bboxOf(multi: MultiPolygonCoords): BBox {
  const b: BBox = { minLng: Infinity, minLat: Infinity, maxLng: -Infinity, maxLat: -Infinity };
  for (const poly of multi) {
    for (const [lng, lat] of poly[0] ?? []) {
      if (lng < b.minLng) b.minLng = lng;
      if (lng > b.maxLng) b.maxLng = lng;
      if (lat < b.minLat) b.minLat = lat;
      if (lat > b.maxLat) b.maxLat = lat;
    }
  }
  return b;
}

export function bboxContains(b: BBox, [lng, lat]: LngLat, marginDeg = 0): boolean {
  return lng >= b.minLng - marginDeg && lng <= b.maxLng + marginDeg && lat >= b.minLat - marginDeg && lat <= b.maxLat + marginDeg;
}

/** Ray casting. Points exactly on an edge may fall either way; callers handle that with a boundary-distance band. */
export function pointInRing([x, y]: LngLat, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside the outer ring and outside every hole. */
export function pointInPolygon(p: LngLat, poly: PolygonCoords): boolean {
  if (!poly[0] || !pointInRing(p, poly[0])) return false;
  for (let h = 1; h < poly.length; h++) if (pointInRing(p, poly[h]!)) return false;
  return true;
}

export function pointInMultiPolygon(p: LngLat, multi: MultiPolygonCoords): boolean {
  return multi.some((poly) => pointInPolygon(p, poly));
}

export function haversineMeters([lng1, lat1]: LngLat, [lng2, lat2]: LngLat): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Distance from a point to a segment in metres, using an equirectangular projection centred on the
 * point. Accurate to well under 1% at NCR latitudes for the short distances this is used for.
 */
function pointSegmentMeters(p: LngLat, a: LngLat, b: LngLat): number {
  const kx = Math.cos(toRad(p[1])) * (Math.PI / 180) * EARTH_RADIUS_M;
  const ky = (Math.PI / 180) * EARTH_RADIUS_M;
  const ax = (a[0] - p[0]) * kx;
  const ay = (a[1] - p[1]) * ky;
  const bx = (b[0] - p[0]) * kx;
  const by = (b[1] - p[1]) * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** Shortest distance in metres from a point to any edge (outer or hole) of the multipolygon. */
export function distanceToBoundaryMeters(p: LngLat, multi: MultiPolygonCoords): number {
  let best = Infinity;
  for (const poly of multi) {
    for (const ring of poly) {
      for (let i = 1; i < ring.length; i++) {
        const d = pointSegmentMeters(p, ring[i - 1]!, ring[i]!);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

/** Signed spherical area of a ring in km² (absolute value taken by callers). */
function ringAreaKm2(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [lng1, lat1] = ring[i]!;
    const [lng2, lat2] = ring[i + 1]!;
    sum += toRad(lng2 - lng1) * (2 + Math.sin(toRad(lat1)) + Math.sin(toRad(lat2)));
  }
  return Math.abs((sum * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2) / 1e6;
}

export function multiPolygonAreaKm2(multi: MultiPolygonCoords): number {
  let total = 0;
  for (const poly of multi) {
    poly.forEach((ring, i) => {
      total += i === 0 ? ringAreaKm2(ring) : -ringAreaKm2(ring);
    });
  }
  return total;
}

/** Douglas–Peucker simplification with a tolerance in metres. Keeps rings closed and valid (≥ 4 points). */
export function simplifyRing(ring: Ring, toleranceM: number): Ring {
  if (ring.length <= 4) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = 1;
  keep[ring.length - 1] = 1;
  const stack: [number, number][] = [[0, ring.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = pointSegmentMeters(ring[i]!, ring[s]!, ring[e]!);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx !== -1 && maxD > toleranceM) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  const out = ring.filter((_, i) => keep[i]);
  return out.length >= 4 ? out : ring;
}

export function simplifyMultiPolygon(multi: MultiPolygonCoords, toleranceM: number, decimals = 5): MultiPolygonCoords {
  const f = 10 ** decimals;
  const round = ([lng, lat]: LngLat): LngLat => [Math.round(lng * f) / f, Math.round(lat * f) / f];
  return multi.map((poly) => poly.map((ring) => simplifyRing(ring, toleranceM).map(round)));
}
