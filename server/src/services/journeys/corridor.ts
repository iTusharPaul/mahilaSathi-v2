import { latLngToCell } from 'h3-js';
import type { LngLat } from '@mahilasathi/shared';
import { RouteLine } from '../scoring/routeGeometry.js';

/** H3 resolution 8: hexagons with ~460 m edges. Coarse enough not to reveal exact streets. */
export const CORRIDOR_RESOLUTION = 8;
/** Trimmed from each end of a route before it is used for matching or aggregation (spec: ≥300 m). */
export const PRIVACY_TRIM_M = 300;

/**
 * Corridor identity: the ordered H3 cells a route passes through, independent of city or state
 * boundaries. With `trimM`, the first and last stretch is dropped so the cells never reveal the exact
 * start or destination; very short routes then have no shareable corridor at all.
 */
export function corridorCells(geometry: LngLat[], trimM = 0, stepM = 100): string[] {
  const line = new RouteLine(geometry);
  if (line.length <= 2 * trimM + stepM) return [];
  const cells: string[] = [];
  for (let at = trimM; at <= line.length - trimM; at += stepM) {
    const [lng, lat] = line.pointAt(at);
    const cell = latLngToCell(lat, lng, CORRIDOR_RESOLUTION);
    if (cells[cells.length - 1] !== cell) cells.push(cell);
  }
  return cells;
}

export interface CorridorOverlap {
  /** Share of the shorter corridor that the two have in common (0–100). */
  overlapPct: number;
  /** True when shared cells are visited in the same order, i.e. both travel the same way. */
  sameDirection: boolean;
  /** Shared cells in the order of `a`. */
  shared: string[];
}

/**
 * Compares two corridors. Direction is checked with pairwise order agreement, which tolerates small
 * variations in the cells each route touches.
 */
export function corridorOverlap(a: string[], b: string[]): CorridorOverlap {
  const posB = new Map<string, number>();
  b.forEach((c, i) => {
    if (!posB.has(c)) posB.set(c, i);
  });
  const shared = [...new Set(a)].filter((c) => posB.has(c));
  const shorter = Math.min(new Set(a).size, new Set(b).size);
  const overlapPct = shorter === 0 ? 0 : Math.round((100 * shared.length) / shorter);

  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < shared.length; i++) {
    for (let j = i + 1; j < shared.length; j++) {
      // Within `shared`, i < j means a visits shared[i] first.
      if (posB.get(shared[i]!)! < posB.get(shared[j]!)!) concordant++;
      else discordant++;
    }
  }
  const sameDirection = shared.length < 2 ? shared.length === 1 : concordant > discordant;
  return { overlapPct, sameDirection, shared };
}
