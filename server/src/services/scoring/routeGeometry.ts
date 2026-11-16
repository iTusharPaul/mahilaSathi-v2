import type { LngLat } from '@mahilasathi/shared';

const R = 6_371_008.8;
const RAD = Math.PI / 180;

/** Pre-computed polyline with cumulative distances, for projecting points onto a route. */
export class RouteLine {
  readonly cumulative: number[];
  readonly length: number;

  constructor(readonly coords: LngLat[]) {
    this.cumulative = [0];
    for (let i = 1; i < coords.length; i++) {
      this.cumulative.push(this.cumulative[i - 1]! + segmentLength(coords[i - 1]!, coords[i]!));
    }
    this.length = this.cumulative[this.cumulative.length - 1] ?? 0;
  }

  /**
   * Nearest position on the route to `p`: distance from the route (offset) and distance along it.
   * Uses a local equirectangular projection around `p`, accurate to well under 1% at these scales.
   */
  project(p: LngLat): { offsetM: number; alongM: number } {
    const kx = Math.cos(p[1] * RAD) * RAD * R;
    const ky = RAD * R;
    let best = { offsetM: Infinity, alongM: 0 };
    for (let i = 1; i < this.coords.length; i++) {
      const a = this.coords[i - 1]!;
      const b = this.coords[i]!;
      const ax = (a[0] - p[0]) * kx;
      const ay = (a[1] - p[1]) * ky;
      const dx = (b[0] - a[0]) * kx;
      const dy = (b[1] - a[1]) * ky;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < best.offsetM) best = { offsetM: d, alongM: this.cumulative[i - 1]! + t * Math.sqrt(len2) };
    }
    return best;
  }

  /** Points every `stepM` metres along the route (used to find the jurisdictions it crosses). */
  sample(stepM: number): LngLat[] {
    const out: LngLat[] = [];
    for (let target = 0; target <= this.length; target += stepM) out.push(this.pointAt(target));
    out.push(this.coords[this.coords.length - 1]!);
    return out;
  }

  pointAt(alongM: number): LngLat {
    let i = 1;
    while (i < this.cumulative.length - 1 && this.cumulative[i]! < alongM) i++;
    const a = this.coords[i - 1]!;
    const b = this.coords[i] ?? a;
    const seg = this.cumulative[i]! - this.cumulative[i - 1]!;
    const t = seg === 0 ? 0 : Math.min(1, Math.max(0, (alongM - this.cumulative[i - 1]!) / seg));
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  bbox(): { minLng: number; minLat: number; maxLng: number; maxLat: number } {
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    for (const [lng, lat] of this.coords) {
      minLng = Math.min(minLng, lng);
      maxLng = Math.max(maxLng, lng);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
    }
    return { minLng, minLat, maxLng, maxLat };
  }
}

function segmentLength(a: LngLat, b: LngLat): number {
  const dLat = (b[1] - a[1]) * RAD;
  const dLng = (b[0] - a[0]) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Longest stretch of route without any activity point, including from the start to the first point
 * and from the last point to the end. `positions` are distances along the route in metres.
 */
export function longestGap(positions: number[], routeLength: number): { lengthM: number; fromM: number; toM: number } {
  const sorted = [...positions].filter((p) => p >= 0 && p <= routeLength).sort((a, b) => a - b);
  let best = { lengthM: 0, fromM: 0, toM: 0 };
  let prev = 0;
  for (const p of [...sorted, routeLength]) {
    if (p - prev > best.lengthM) best = { lengthM: p - prev, fromM: prev, toM: p };
    prev = p;
  }
  return best;
}
