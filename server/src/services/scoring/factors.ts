import type { ConfidenceLevel, FactorKey } from '@mahilasathi/shared';
import { isOpenAt } from './openingHours.js';
import { RouteLine, longestGap } from './routeGeometry.js';
import { ESTABLISHMENT_KINDS, type PlaceRecord, type RouteCandidate, type ScoringContext } from './types.js';

/** A factor before weighting. score null = unknown: excluded from the score, never treated as zero. */
export interface FactorValue {
  key: FactorKey;
  score: number | null;
  raw: string;
  source: string;
  dataTimestamp: string | null;
  confidence: ConfidenceLevel;
  explanation: string;
}

/** Distances (metres) within which a place counts towards a factor. */
export const CORRIDOR = { establishment: 80, transit: 150, assistance: 300, camera: 50, activity: 100 } as const;
/** Main roads for "main road coverage" (Geoapify/OSM road_class values). */
export const MAIN_ROAD_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary']);
/** Longest-gap distance at which the stretch score halves, per mode. */
export const GAP_HALF_SCORE_M = { walk: 500, drive: 2000 } as const;
const TURN_TYPE = /^(Left|Right|SlightLeft|SlightRight|SharpLeft|SharpRight|TurnAround|UTurn|Roundabout|Exit)/;

const saturate = (x: number, k: number) => 1 - Math.exp(-x / k);
const PLACES_SOURCE = 'Geoapify Places (OpenStreetMap data)';

export interface PlaceOnRoute {
  place: PlaceRecord;
  offsetM: number;
  alongM: number;
  /** Open at the estimated time the traveller passes it; null when hours are unknown. */
  openAtPass: boolean | null;
}

/** Projects places onto the route once and evaluates opening hours at the estimated pass-by time. */
export function placesOnRoute(route: RouteCandidate, line: RouteLine, ctx: ScoringContext): PlaceOnRoute[] {
  if (!ctx.places) return [];
  const maxCorridor = Math.max(...Object.values(CORRIDOR));
  const out: PlaceOnRoute[] = [];
  for (const place of ctx.places) {
    const { offsetM, alongM } = line.project([place.lng, place.lat]);
    if (offsetM > maxCorridor) continue;
    const passAt = new Date(ctx.departure.getTime() + (line.length > 0 ? (alongM / line.length) * route.durationS * 1000 : 0));
    out.push({ place, offsetM, alongM, openAtPass: isOpenAt(place.openingHours, passAt) });
  }
  return out;
}

const unknown = (key: FactorKey, source: string, explanation: string, raw = 'Unknown'): FactorValue => ({
  key,
  score: null,
  raw,
  source,
  dataTimestamp: null,
  confidence: 'low',
  explanation,
});

export function openEstablishments(on: PlaceOnRoute[], km: number, ctx: ScoringContext): FactorValue & { open: number | null; mapped: number | null; known: number | null } {
  if (!ctx.places) return { ...unknown('openEstablishments', PLACES_SOURCE, 'Place data was unavailable for this route.'), open: null, mapped: null, known: null };
  const mapped = on.filter((p) => ESTABLISHMENT_KINDS.includes(p.place.kind) && p.offsetM <= CORRIDOR.establishment);
  const known = mapped.filter((p) => p.openAtPass !== null);
  const open = known.filter((p) => p.openAtPass === true).length;
  if (mapped.length === 0) {
    return { ...unknown('openEstablishments', PLACES_SOURCE, `No establishments are mapped within ${CORRIDOR.establishment} m of this route, so whether anything is open can't be assessed.`, '0 mapped'), open: 0, mapped: 0, known: 0 };
  }
  if (known.length === 0) {
    return {
      ...unknown('openEstablishments', PLACES_SOURCE, `${mapped.length} establishments are mapped, but none has opening hours, so none is counted as open.`, `0 known of ${mapped.length} mapped`),
      open: 0,
      mapped: mapped.length,
      known: 0,
    };
  }
  const ratio = known.length / mapped.length;
  const confidence: ConfidenceLevel = ratio >= 0.5 && known.length >= 8 ? 'high' : ratio >= 0.25 && known.length >= 3 ? 'medium' : 'low';
  return {
    key: 'openEstablishments',
    score: saturate(open / Math.max(km, 0.3), 2.5),
    raw: `${open} open of ${known.length} with known hours (${mapped.length} mapped)`,
    source: PLACES_SOURCE,
    dataTimestamp: ctx.placesFetchedAt,
    confidence,
    explanation: `Places within ${CORRIDOR.establishment} m whose mapped opening hours say they are open when you pass. Places without hours (${mapped.length - known.length}) are not assumed open.`,
    open,
    mapped: mapped.length,
    known: known.length,
  };
}

export function publicTransport(on: PlaceOnRoute[], km: number, ctx: ScoringContext): FactorValue & { stops: number | null } {
  if (!ctx.places) return { ...unknown('publicTransport', PLACES_SOURCE, 'Transit data was unavailable for this route.'), stops: null };
  const stops = on.filter((p) => (p.place.kind === 'metro' || p.place.kind === 'bus') && p.offsetM <= CORRIDOR.transit);
  const metro = stops.filter((p) => p.place.kind === 'metro').length;
  const weighted = metro * 2 + (stops.length - metro);
  return {
    key: 'publicTransport',
    score: saturate(weighted / Math.max(km, 0.3), 1.5),
    raw: `${metro} metro, ${stops.length - metro} bus stops within ${CORRIDOR.transit} m`,
    source: PLACES_SOURCE,
    dataTimestamp: ctx.placesFetchedAt,
    // No verified schedules: presence of stops is known, night service is not.
    confidence: 'low',
    explanation: 'Mapped stops and stations near the route. Night service times are not verified, so stops may be closed late at night.',
    stops: stops.length,
  };
}

export function mainRoadCoverage(route: RouteCandidate): FactorValue & { pct: number | null } {
  const source = route.synthetic ? 'Synthetic route' : 'Geoapify Routing (OpenStreetMap road classes)';
  const known = route.steps.filter((s) => s.roadClass);
  const knownM = known.reduce((s, x) => s + x.distanceM, 0);
  const totalM = route.steps.reduce((s, x) => s + x.distanceM, 0) || route.distanceM;
  if (totalM === 0 || knownM / totalM < 0.5) {
    return { ...unknown('mainRoadCoverage', source, 'Road types are not known for most of this route.'), pct: null };
  }
  const mainM = known.filter((s) => MAIN_ROAD_CLASSES.has(s.roadClass!)).reduce((s, x) => s + x.distanceM, 0);
  const pct = mainM / knownM;
  return {
    key: 'mainRoadCoverage',
    score: pct,
    raw: `${Math.round(pct * 100)}% on main roads`,
    source,
    dataTimestamp: null,
    confidence: knownM / totalM >= 0.9 ? 'high' : 'medium',
    explanation: 'Share of the route on motorways, trunk, primary and secondary roads, which usually stay busier at night. Lighting is not mapped reliably, so it is not assumed.',
    pct,
  };
}

export function longestLowActivity(on: PlaceOnRoute[], line: RouteLine, ctx: ScoringContext): FactorValue & { lengthM: number | null } {
  if (!ctx.places) return { ...unknown('longestLowActivity', PLACES_SOURCE, 'Place data was unavailable, so stretches without activity cannot be measured.'), lengthM: null };
  const points = on.filter((p) => p.offsetM <= CORRIDOR.activity).map((p) => p.alongM);
  const gap = longestGap(points, line.length);
  const half = GAP_HALF_SCORE_M[ctx.mode];
  return {
    key: 'longestLowActivity',
    score: 1 / (1 + (gap.lengthM / half) ** 2),
    raw: gap.lengthM >= 1000 ? `${(gap.lengthM / 1000).toFixed(1)} km` : `${Math.round(gap.lengthM)} m`,
    source: PLACES_SOURCE,
    dataTimestamp: ctx.placesFetchedAt,
    confidence: 'medium',
    explanation: `Longest continuous stretch with no mapped establishment, stop or public facility within ${CORRIDOR.activity} m. Sparse map data can make a stretch look emptier than it is. The score halves at ${half >= 1000 ? `${half / 1000} km` : `${half} m`}.`,
    lengthM: gap.lengthM,
  };
}

export function routeSimplicity(route: RouteCandidate): FactorValue & { turns: number } {
  const typed = route.steps.filter((s) => s.instructionType !== null);
  const turns = typed.filter((s) => TURN_TYPE.test(s.instructionType!)).length;
  if (typed.length === 0) return { ...unknown('routeSimplicity', 'Synthetic route', 'Turn-by-turn instructions are not available.'), turns: 0 };
  const perKm = turns / Math.max(route.distanceM / 1000, 0.3);
  return {
    key: 'routeSimplicity',
    score: 1 / (1 + (perKm / 3) ** 2),
    raw: `${turns} turns (${perKm.toFixed(1)}/km)`,
    source: 'Geoapify Routing instructions',
    dataTimestamp: null,
    confidence: 'high',
    explanation: 'Fewer turns per kilometre make a route easier to follow at night.',
    turns,
  };
}

export function assistance(on: PlaceOnRoute[], km: number, ctx: ScoringContext): FactorValue & { points: number | null } {
  if (!ctx.places) return { ...unknown('assistance', PLACES_SOURCE, 'Place data was unavailable for this route.'), points: null };
  const near = on.filter((p) => ['police', 'hospital', 'fuel'].includes(p.place.kind) && p.offsetM <= CORRIDOR.assistance);
  const weighted = near.reduce((s, p) => s + (p.place.kind === 'fuel' ? 0.5 : 1), 0);
  const police = near.filter((p) => p.place.kind === 'police').length;
  const hospitals = near.filter((p) => p.place.kind === 'hospital').length;
  return {
    key: 'assistance',
    score: saturate(weighted / Math.max(km, 0.3), 0.6),
    raw: `${police} police, ${hospitals} hospitals, ${near.length - police - hospitals} fuel stations within ${CORRIDOR.assistance} m`,
    source: PLACES_SOURCE,
    dataTimestamp: ctx.placesFetchedAt,
    confidence: 'medium',
    explanation: 'Mapped police stations, hospitals and fuel stations. Whether they are open or staffed at night is not verified.',
    points: near.length,
  };
}

export function cameraCoverage(line: RouteLine, km: number, ctx: ScoringContext): FactorValue & { cameras: number | null } {
  const source = 'OpenStreetMap via Overpass (man_made=surveillance)';
  if (!ctx.cameras) return { ...unknown('cameraCoverage', source, 'Camera data could not be fetched right now (Overpass did not respond).'), cameras: null };
  const count = ctx.cameras.filter((c) => line.project([c.lng, c.lat]).offsetM <= CORRIDOR.camera).length;
  return {
    key: 'cameraCoverage',
    score: saturate(count / Math.max(km, 0.3), 2),
    raw: `${count} mapped within ${CORRIDOR.camera} m`,
    source,
    dataTimestamp: ctx.camerasFetchedAt,
    confidence: 'low',
    explanation: 'Cameras mapped by volunteers. Whether any camera works or is monitored is unknown.',
    cameras: count,
  };
}

/**
 * Community Pulse along the route: mean pulse of route cells that have enough distinct contributors.
 * Cold start (spec §10): with no such cells, a neutral 0.5 at low confidence, labelled as insufficient.
 */
export function communityPulse(route?: RouteCandidate, ctx?: ScoringContext): FactorValue {
  const source = 'mahilaSathi Community Pulse (aggregated, time-decayed)';
  const cells = route && ctx?.pulse ? ctx.pulse.cellsFor(route.coordinates) : [];
  const known = cells.filter((c) => ctx!.pulse!.sufficient.has(c));
  if (known.length === 0) {
    return {
      key: 'communityPulse',
      score: 0.5,
      raw: 'Insufficient community data',
      source,
      dataTimestamp: null,
      confidence: 'low',
      explanation: 'Not enough recent community signals along this route, so a neutral value is used. It does not imply positive or negative community activity.',
    };
  }
  const mean = known.reduce((s, c) => s + ctx!.pulse!.sufficient.get(c)!, 0) / known.length;
  const coverage = known.length / cells.length;
  return {
    key: 'communityPulse',
    score: mean,
    raw: `Signals for ${Math.round(coverage * 100)}% of the route`,
    source,
    dataTimestamp: ctx!.pulse!.updatedAt,
    confidence: coverage >= 0.3 ? 'medium' : 'low',
    explanation: 'Recent completed journeys, route feedback and community reports, aggregated per area with older signals counting less. Areas with fewer than 3 contributors are not used.',
  };
}
