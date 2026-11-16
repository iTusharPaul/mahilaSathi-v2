import { FACTOR_LABELS, type FactorKey, type Ranking, type ScoredRoute } from '@mahilasathi/shared';
import {
  assistance,
  cameraCoverage,
  communityPulse,
  longestLowActivity,
  mainRoadCoverage,
  openEstablishments,
  placesOnRoute,
  publicTransport,
  routeSimplicity,
  type FactorValue,
} from './factors.js';
import { combine, type Preferences, type ScoreResult } from './nightActivityScore.js';
import { RouteLine } from './routeGeometry.js';
import type { RouteCandidate, ScoringContext } from './types.js';

export interface Evaluated {
  route: RouteCandidate;
  line: RouteLine;
  result: ScoreResult;
  metrics: ScoredRoute['metrics'];
  turns: number;
  markers: ScoredRoute['places'];
}

export function evaluateRoute(route: RouteCandidate, ctx: ScoringContext, prefs: Preferences): Evaluated {
  const line = new RouteLine(route.coordinates);
  const km = Math.max(line.length, route.distanceM) / 1000;
  const on = placesOnRoute(route, line, ctx);

  const oe = openEstablishments(on, km, ctx);
  const pt = publicTransport(on, km, ctx);
  const mr = mainRoadCoverage(route);
  const la = longestLowActivity(on, line, ctx);
  const rs = routeSimplicity(route);
  const as = assistance(on, km, ctx);
  const cc = cameraCoverage(line, km, ctx);
  const values: FactorValue[] = [oe, pt, mr, la, rs, as, cc, communityPulse(route, ctx)];

  return {
    route,
    line,
    result: combine(values, prefs),
    turns: rs.turns,
    metrics: {
      openEstablishments: oe.open,
      mappedEstablishments: oe.mapped,
      hoursKnown: oe.known,
      transitStops: pt.stops,
      longestLowActivityM: la.lengthM === null ? null : Math.round(la.lengthM),
      assistancePoints: as.points,
      mainRoadPct: mr.pct === null ? null : Math.round(mr.pct * 100),
      cameras: cc.cameras,
    },
    markers: on
      .filter((p) => p.offsetM <= 150)
      .slice(0, 300)
      .map((p) => ({ lat: p.place.lat, lng: p.place.lng, kind: p.place.kind, name: p.place.name, open: p.openAtPass })),
  };
}

const COMPARATIVE: Partial<Record<FactorKey, [better: string, worse: string]>> = {
  openEstablishments: ['More establishments open when you pass', 'Fewer establishments open when you pass'],
  mainRoadCoverage: ['More of the route on main roads', 'Less of the route on main roads'],
  longestLowActivity: ['Shorter stretches without mapped activity', 'Longer stretch without mapped activity'],
  publicTransport: ['More stops and stations nearby', 'Fewer stops and stations nearby'],
  assistance: ['More mapped police, hospitals or fuel stations nearby', 'Fewer mapped assistance points nearby'],
  routeSimplicity: ['Fewer turns', 'More turns'],
  cameraCoverage: ['More mapped cameras', 'Fewer mapped cameras'],
};

const minutes = (s: number) => Math.round(s / 60);

/** Reasons for each route's standing, relative to the alternatives, plus honest data caveats. */
export function explain(all: Evaluated[]): string[][] {
  const fastest = Math.min(...all.map((e) => e.route.durationS));
  return all.map((e) => {
    const reasons: { text: string; weight: number }[] = [];
    const others = all.filter((o) => o !== e);
    if (others.length > 0) {
      for (const f of e.result.factors) {
        const phrases = COMPARATIVE[f.key];
        if (!phrases || f.score === null) continue;
        const otherScores = others.map((o) => o.result.factors.find((x) => x.key === f.key)!.score).filter((s): s is number => s !== null);
        if (otherScores.length === 0) continue;
        const diff = f.score - otherScores.reduce((a, b) => a + b, 0) / otherScores.length;
        if (Math.abs(diff) >= 0.08) reasons.push({ text: diff > 0 ? phrases[0] : phrases[1], weight: Math.abs(diff) * f.baseWeight });
      }
      const extra = minutes(e.route.durationS - fastest);
      if (e.route.durationS === fastest) reasons.push({ text: `Fastest option (${minutes(e.route.durationS)} min)`, weight: 1 });
      else if (extra >= 1) reasons.push({ text: `${extra} min longer than the fastest option`, weight: 0.9 });
    }
    if (others.length === 0) {
      // No alternative to compare with: show the strongest known factors with their plain values.
      const known = e.result.factors.filter((f) => f.score !== null && f.key !== 'communityPulse');
      for (const f of [...known].sort((a, b) => b.score! * b.baseWeight - a.score! * a.baseWeight).slice(0, 3)) {
        reasons.push({ text: `${FACTOR_LABELS[f.key]}: ${f.raw}`, weight: f.score! * f.baseWeight });
      }
      reasons.push({ text: 'Only one distinct route was found for this journey', weight: 0 });
    }
    reasons.sort((a, b) => b.weight - a.weight);
    const out = reasons.slice(0, 4).map((r) => r.text);

    const m = e.metrics;
    if (m.mappedEstablishments && m.hoursKnown === 0) {
      out.push(`Opening hours aren’t mapped for any of the ${m.mappedEstablishments} places nearby`);
    } else if (m.mappedEstablishments && m.hoursKnown !== null && m.hoursKnown / m.mappedEstablishments < 0.25) {
      out.push(`Opening hours are known for only ${m.hoursKnown} of ${m.mappedEstablishments} mapped places`);
    }
    for (const key of e.result.missing) {
      if (key === 'communityPulse' || (key === 'openEstablishments' && m.mappedEstablishments)) continue;
      out.push(`${FACTOR_LABELS[key]}: no data, so not counted`);
    }
    if (e.result.score === null) out.unshift('Not enough information to score this route');
    return out;
  });
}

/** Route ids ordered by each ranking. Balanced = 70% score, 30% speed relative to the fastest route. */
export function rank(routes: { id: string; score: number | null; durationS: number }[]): Record<Ranking, string[]> {
  const fastest = Math.min(...routes.map((r) => r.durationS));
  const byScore = [...routes].sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.durationS - b.durationS);
  const byTime = [...routes].sort((a, b) => a.durationS - b.durationS);
  const balancedValue = (r: (typeof routes)[number]) => (r.score === null ? -1 : 0.7 * r.score + 0.3 * ((100 * fastest) / r.durationS));
  const byBalanced = [...routes].sort((a, b) => balancedValue(b) - balancedValue(a));
  return { score: byScore.map((r) => r.id), fastest: byTime.map((r) => r.id), balanced: byBalanced.map((r) => r.id) };
}
