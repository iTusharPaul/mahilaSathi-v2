import {
  bboxContains,
  distanceToBoundaryMeters,
  haversineMeters,
  pointInMultiPolygon,
  type AreaRef,
  type BBox,
  type Coverage,
  type DistrictSummary,
  type GeoSearchResult,
  type LngLat,
  type MultiPolygonCoords,
  type Neighbourhood,
  type Resolution,
} from '@mahilasathi/shared';
import type { Db } from '../../db/connection.js';

/**
 * District edges are simplified (30 m) and the source itself is approximate, so a point this close
 * to an edge is reported as uncertain and the user is asked to confirm.
 */
export const BOUNDARY_UNCERTAINTY_M = 300;
const DEG_MARGIN = 0.01; // ~1.1 km, generous bbox prefilter margin

interface DistrictEntry {
  id: string;
  name: string;
  stateId: string;
  aliases: string[];
  areaKm2: number;
  bbox: BBox;
  geometry: MultiPolygonCoords;
  representativePoint: LngLat;
}

interface CityEntry {
  id: string;
  name: string;
  stateId: string;
  aliases: string[];
  kind: 'districts' | 'circle';
  districtIds: string[];
  center: LngLat | null;
  radiusM: number | null;
}

interface NeighbourhoodEntry {
  id: string;
  name: string;
  aliases: string[];
  stateId: string;
  districtId: string;
  cityId: string | null;
  center: LngLat;
  radiusM: number;
}

const UNKNOWN_COVERAGE: Coverage = {
  level: 'unknown',
  summary: 'Not assessed yet. Missing information is not a sign that an area is unsafe.',
  assessedAt: null,
  source: null,
};

export const OUTSIDE_NCR_MESSAGE =
  'This location is outside the National Capital Region. mahilaSathi currently supports places within Delhi NCR.';

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

function matchScore(query: string, names: string[]): number {
  let best = 0;
  for (const raw of names) {
    const name = normalize(raw);
    if (name === query) best = Math.max(best, 4);
    else if (name.startsWith(query)) best = Math.max(best, 3);
    else if (name.split(' ').some((w) => w.startsWith(query))) best = Math.max(best, 2);
    else if (query.length >= 3 && name.includes(query)) best = Math.max(best, 1);
  }
  return best;
}

/** A point guaranteed to be inside the polygon, for labelling and search results. */
function representativePoint(geometry: MultiPolygonCoords, bbox: BBox): LngLat {
  const centre: LngLat = [(bbox.minLng + bbox.maxLng) / 2, (bbox.minLat + bbox.maxLat) / 2];
  if (pointInMultiPolygon(centre, geometry)) return centre;
  for (let n = 4; n <= 32; n *= 2) {
    for (let i = 1; i < n; i++) {
      for (let j = 1; j < n; j++) {
        const p: LngLat = [
          bbox.minLng + ((bbox.maxLng - bbox.minLng) * i) / n,
          bbox.minLat + ((bbox.maxLat - bbox.minLat) * j) / n,
        ];
        if (pointInMultiPolygon(p, geometry)) return p;
      }
    }
  }
  return geometry[0]![0]![0]!;
}

/**
 * In-memory index of the NCR registry, loaded from the database. NCR has a few dozen districts and
 * curated places, so linear scans with bbox prefiltering are fast; at PostGIS scale this becomes
 * spatial-index queries behind the same interface.
 */
export class GeoRegistry {
  private states = new Map<string, AreaRef>();
  private districts: DistrictEntry[] = [];
  private districtById = new Map<string, DistrictEntry>();
  private cities: CityEntry[] = [];
  private cityById = new Map<string, CityEntry>();
  private neighbourhoods: NeighbourhoodEntry[] = [];
  private neighbourhoodById = new Map<string, NeighbourhoodEntry>();
  private coverage = new Map<string, Coverage>();
  private boundaryCache = new Map<string, string>();
  dataset = { id: 'none', version: 'none' };

  constructor(private readonly db: Db) {
    try {
      this.reload();
    } catch {
      // Schema not migrated yet: stay empty so readiness reports geography as not loaded.
      this.districts = [];
    }
  }

  reload(): void {
    const db = this.db;
    const ds = db.prepare('SELECT id, version FROM boundary_datasets WHERE is_active = 1 LIMIT 1').get() as
      | { id: string; version: string }
      | undefined;
    this.dataset = ds ?? { id: 'none', version: 'none' };

    this.states = new Map(
      (db.prepare('SELECT id, name FROM states WHERE is_active = 1').all() as AreaRef[]).map((s) => [s.id, s]),
    );

    this.districts = (
      db
        .prepare(
          `SELECT id, name, state_id, aliases_json, area_km2, geometry_json, min_lat, min_lng, max_lat, max_lng
           FROM districts WHERE is_active = 1 ORDER BY id`,
        )
        .all() as {
        id: string;
        name: string;
        state_id: string;
        aliases_json: string;
        area_km2: number;
        geometry_json: string;
        min_lat: number;
        min_lng: number;
        max_lat: number;
        max_lng: number;
      }[]
    ).map((r) => {
      const geometry = JSON.parse(r.geometry_json) as MultiPolygonCoords;
      const bbox = { minLat: r.min_lat, minLng: r.min_lng, maxLat: r.max_lat, maxLng: r.max_lng };
      return {
        id: r.id,
        name: r.name,
        stateId: r.state_id,
        aliases: JSON.parse(r.aliases_json) as string[],
        areaKm2: r.area_km2,
        bbox,
        geometry,
        representativePoint: representativePoint(geometry, bbox),
      };
    });
    this.districtById = new Map(this.districts.map((d) => [d.id, d]));

    this.cities = (
      db
        .prepare(
          `SELECT id, name, state_id, aliases_json, kind, district_ids_json, center_lat, center_lng, radius_m
           FROM cities WHERE is_active = 1`,
        )
        .all() as {
        id: string;
        name: string;
        state_id: string;
        aliases_json: string;
        kind: 'districts' | 'circle';
        district_ids_json: string | null;
        center_lat: number | null;
        center_lng: number | null;
        radius_m: number | null;
      }[]
    ).map((r) => ({
      id: r.id,
      name: r.name,
      stateId: r.state_id,
      aliases: JSON.parse(r.aliases_json) as string[],
      kind: r.kind,
      districtIds: r.district_ids_json ? (JSON.parse(r.district_ids_json) as string[]) : [],
      center: r.center_lat !== null && r.center_lng !== null ? [r.center_lng, r.center_lat] : null,
      radiusM: r.radius_m,
    }));
    this.cityById = new Map(this.cities.map((c) => [c.id, c]));

    this.neighbourhoods = (
      db
        .prepare(
          `SELECT id, name, aliases_json, state_id, district_id, city_id, center_lat, center_lng, radius_m
           FROM neighbourhoods WHERE is_active = 1 ORDER BY name`,
        )
        .all() as {
        id: string;
        name: string;
        aliases_json: string;
        state_id: string;
        district_id: string;
        city_id: string | null;
        center_lat: number;
        center_lng: number;
        radius_m: number;
      }[]
    ).map((r) => ({
      id: r.id,
      name: r.name,
      aliases: JSON.parse(r.aliases_json) as string[],
      stateId: r.state_id,
      districtId: r.district_id,
      cityId: r.city_id,
      center: [r.center_lng, r.center_lat] as LngLat,
      radiusM: r.radius_m,
    }));
    this.neighbourhoodById = new Map(this.neighbourhoods.map((n) => [n.id, n]));

    this.coverage = new Map(
      (
        db.prepare('SELECT area_type, area_id, level, basis_json, source, assessed_at FROM coverage_assessments').all() as {
          area_type: string;
          area_id: string;
          level: Coverage['level'];
          basis_json: string;
          source: string;
          assessed_at: string;
        }[]
      ).map((r) => [
        `${r.area_type}:${r.area_id}`,
        {
          level: r.level,
          summary: (JSON.parse(r.basis_json) as { summary?: string }).summary ?? `Coverage: ${r.level}`,
          assessedAt: r.assessed_at,
          source: r.source,
        },
      ]),
    );
    this.boundaryCache.clear();
  }

  get isLoaded(): boolean {
    return this.districts.length > 0;
  }

  // ─── Lookups ───────────────────────────────────────────────────────────────

  state(id: string): AreaRef | null {
    return this.states.get(id) ?? null;
  }
  districtRef(id: string): AreaRef | null {
    const d = this.districtById.get(id);
    return d ? { id: d.id, name: d.name } : null;
  }
  cityRef(id: string | null): AreaRef | null {
    const c = id ? this.cityById.get(id) : undefined;
    return c ? { id: c.id, name: c.name } : null;
  }
  neighbourhoodEntry(id: string): NeighbourhoodEntry | null {
    return this.neighbourhoodById.get(id) ?? null;
  }
  districtStateId(id: string): string | null {
    return this.districtById.get(id)?.stateId ?? null;
  }

  /** Updates the in-memory copy after an assessment is stored (see coverageService). */
  setCoverage(areaType: 'district' | 'neighbourhood', id: string, coverage: Coverage): void {
    this.coverage.set(`${areaType}:${id}`, coverage);
  }

  coverageFor(areaType: 'district' | 'neighbourhood', id: string): Coverage {
    return this.coverage.get(`${areaType}:${id}`) ?? UNKNOWN_COVERAGE;
  }

  // ─── Point resolution ──────────────────────────────────────────────────────

  resolve(lat: number, lng: number): Resolution {
    const p: LngLat = [lng, lat];
    const candidates = this.districts.filter((d) => bboxContains(d.bbox, p, DEG_MARGIN));
    const inside = candidates.filter((d) => pointInMultiPolygon(p, d.geometry));

    let district: DistrictEntry | null = null;
    let uncertainty: Resolution['uncertainty'] = 'none';

    if (inside.length > 0) {
      district = inside[0]!;
      const edge = distanceToBoundaryMeters(p, district.geometry);
      if (inside.length > 1 || edge < BOUNDARY_UNCERTAINTY_M) uncertainty = 'near_district_boundary';
    } else {
      // Not inside any polygon: either outside NCR, or in a sliver gap right at a mapped edge.
      let nearest: { d: DistrictEntry; dist: number } | null = null;
      for (const d of candidates) {
        const dist = distanceToBoundaryMeters(p, d.geometry);
        if (dist < BOUNDARY_UNCERTAINTY_M && (!nearest || dist < nearest.dist)) nearest = { d, dist };
      }
      if (nearest) {
        district = nearest.d;
        uncertainty = 'near_ncr_boundary';
      }
    }

    if (!district) {
      return {
        inNcr: false,
        state: null,
        district: null,
        city: null,
        neighbourhood: null,
        uncertainty: 'none',
        needsManualConfirmation: false,
        coverage: UNKNOWN_COVERAGE,
        message: OUTSIDE_NCR_MESSAGE,
        dataset: this.dataset,
      };
    }

    const neighbourhood = this.nearestContainingNeighbourhood(p);
    const city = this.cityFor(p, district, neighbourhood);
    const coverage = neighbourhood
      ? this.coverageFor('neighbourhood', neighbourhood.id)
      : this.coverageFor('district', district.id);

    let message: string | null = null;
    if (uncertainty === 'near_ncr_boundary') {
      message = 'This point is at the edge of the mapped NCR boundary. Please confirm your area.';
    } else if (uncertainty === 'near_district_boundary') {
      message = 'This point is close to a district boundary. Please confirm the area is right.';
    } else if (!neighbourhood) {
      message = 'No neighbourhood is mapped here yet. You can still use mahilaSathi in this district.';
    }

    return {
      inNcr: true,
      state: this.states.get(district.stateId) ?? null,
      district: { id: district.id, name: district.name },
      city: city ? { id: city.id, name: city.name } : null,
      neighbourhood: neighbourhood ? { id: neighbourhood.id, name: neighbourhood.name } : null,
      uncertainty,
      needsManualConfirmation: uncertainty !== 'none',
      coverage,
      message,
      dataset: this.dataset,
    };
  }

  private nearestContainingNeighbourhood(p: LngLat): NeighbourhoodEntry | null {
    let best: { n: NeighbourhoodEntry; ratio: number } | null = null;
    for (const n of this.neighbourhoods) {
      if (Math.abs(n.center[1] - p[1]) > 0.1 || Math.abs(n.center[0] - p[0]) > 0.1) continue;
      const ratio = haversineMeters(p, n.center) / n.radiusM;
      if (ratio <= 1 && (!best || ratio < best.ratio)) best = { n, ratio };
    }
    return best?.n ?? null;
  }

  private cityFor(p: LngLat, district: DistrictEntry, neighbourhood: NeighbourhoodEntry | null): CityEntry | null {
    if (neighbourhood?.cityId) return this.cityById.get(neighbourhood.cityId) ?? null;
    const byDistrict = this.cities.find((c) => c.kind === 'districts' && c.districtIds.includes(district.id));
    if (byDistrict) return byDistrict;
    let best: { c: CityEntry; ratio: number } | null = null;
    for (const c of this.cities) {
      if (c.kind !== 'circle' || c.stateId !== district.stateId || !c.center || !c.radiusM) continue;
      const ratio = haversineMeters(p, c.center) / c.radiusM;
      if (ratio <= 1 && (!best || ratio < best.ratio)) best = { c, ratio };
    }
    return best?.c ?? null;
  }

  // ─── Search & listing ──────────────────────────────────────────────────────

  /** Name search over the local registry (neighbourhoods, cities, districts). */
  search(query: string, limit: number): GeoSearchResult[] {
    const q = normalize(query);
    if (q.length < 2) return [];
    const scored: { score: number; kindRank: number; result: GeoSearchResult }[] = [];

    for (const n of this.neighbourhoods) {
      const score = matchScore(q, [n.name, ...n.aliases]);
      if (!score) continue;
      const city = this.cityRef(n.cityId);
      const district = this.districtById.get(n.districtId)!;
      scored.push({
        score,
        kindRank: 0,
        result: {
          id: `registry:neighbourhood:${n.id}`,
          label: n.name,
          secondary: [city?.name ?? district.name, this.states.get(n.stateId)?.name].filter(Boolean).join(', '),
          lat: n.center[1],
          lng: n.center[0],
          kind: 'neighbourhood',
          source: 'registry',
          neighbourhoodId: n.id,
          districtId: n.districtId,
          stateName: this.states.get(n.stateId)?.name ?? null,
        },
      });
    }
    for (const c of this.cities) {
      const score = matchScore(q, [c.name, ...c.aliases]);
      if (!score) continue;
      const point = c.center;
      if (!point) continue;
      scored.push({
        score,
        kindRank: 1,
        result: {
          id: `registry:city:${c.id}`,
          label: c.name,
          secondary: this.states.get(c.stateId)?.name ?? null,
          lat: point[1],
          lng: point[0],
          kind: 'city',
          source: 'registry',
          neighbourhoodId: null,
          districtId: c.kind === 'circle' ? (this.resolve(point[1], point[0]).district?.id ?? null) : null,
          stateName: this.states.get(c.stateId)?.name ?? null,
        },
      });
    }
    for (const d of this.districts) {
      const score = matchScore(q, [d.name, ...d.aliases]);
      if (!score) continue;
      scored.push({
        score,
        kindRank: 2,
        result: {
          id: `registry:district:${d.id}`,
          label: `${d.name} district`,
          secondary: this.states.get(d.stateId)?.name ?? null,
          lat: d.representativePoint[1],
          lng: d.representativePoint[0],
          kind: 'district',
          source: 'registry',
          neighbourhoodId: null,
          districtId: d.id,
          stateName: this.states.get(d.stateId)?.name ?? null,
        },
      });
    }
    return scored
      .sort((a, b) => b.score - a.score || a.kindRank - b.kindRank || a.result.label.localeCompare(b.result.label))
      .slice(0, limit)
      .map((s) => s.result);
  }

  listNeighbourhoods(filter: {
    q?: string;
    districtId?: string;
    stateId?: string;
    near?: LngLat;
    limit: number;
  }): Neighbourhood[] {
    const q = filter.q ? normalize(filter.q) : '';
    let list = this.neighbourhoods.filter(
      (n) =>
        (!filter.districtId || n.districtId === filter.districtId) &&
        (!filter.stateId || n.stateId === filter.stateId) &&
        (!q || matchScore(q, [n.name, ...n.aliases]) > 0),
    );
    if (filter.near) {
      const near = filter.near;
      list = [...list].sort((a, b) => haversineMeters(near, a.center) - haversineMeters(near, b.center));
    }
    return list.slice(0, filter.limit).map((n) => this.toNeighbourhood(n));
  }

  toNeighbourhood(n: NeighbourhoodEntry): Neighbourhood {
    return {
      id: n.id,
      name: n.name,
      aliases: n.aliases,
      state: this.states.get(n.stateId)!,
      district: this.districtRef(n.districtId)!,
      city: this.cityRef(n.cityId),
      center: { lat: n.center[1], lng: n.center[0] },
      radiusM: n.radiusM,
      coverage: this.coverageFor('neighbourhood', n.id),
    };
  }

  listDistricts(): DistrictSummary[] {
    return this.districts.map((d) => ({
      id: d.id,
      name: d.name,
      state: this.states.get(d.stateId)!,
      aliases: d.aliases,
      areaKm2: d.areaKm2,
    }));
  }

  /** GeoJSON FeatureCollection, serialised once per level and cached. */
  boundariesGeoJson(level: 'district' | 'state' | 'ncr'): string {
    const cached = this.boundaryCache.get(level);
    if (cached) return cached;
    const groups = new Map<string, { props: Record<string, unknown>; coords: MultiPolygonCoords }>();
    for (const d of this.districts) {
      const key = level === 'district' ? d.id : level === 'state' ? d.stateId : 'ncr';
      const props =
        level === 'district'
          ? { id: d.id, name: d.name, stateId: d.stateId, stateName: this.states.get(d.stateId)?.name }
          : level === 'state'
            ? { id: d.stateId, name: this.states.get(d.stateId)?.name }
            : { id: 'ncr', name: 'National Capital Region' };
      const g = groups.get(key) ?? { props, coords: [] as MultiPolygonCoords };
      g.coords.push(...d.geometry);
      groups.set(key, g);
    }
    const json = JSON.stringify({
      type: 'FeatureCollection',
      dataset: this.dataset,
      features: [...groups.values()].map((g) => ({
        type: 'Feature',
        properties: g.props,
        geometry: { type: 'MultiPolygon', coordinates: g.coords },
      })),
    });
    this.boundaryCache.set(level, json);
    return json;
  }
}
