/**
 * Community Pulse maths. Pure functions so the decay, caps and thresholds are unit-testable.
 *
 *   value = 0.5 + 0.5 · (P − N) / (P + N + K)
 *
 * P and N are decayed, trust-weighted, per-contributor-capped positive and negative weights. K shrinks
 * small samples towards neutral. Cells with fewer than MIN_CONTRIBUTORS distinct contributors are
 * "insufficient" and treated as neutral by every consumer.
 */
export type SignalKind = 'journey_completed' | 'route_feedback' | 'infra_report' | 'incident_verified';

export const PULSE = {
  minContributors: 3,
  shrinkage: 2,
  /** No contributor can move a cell by more than this much weight. */
  perContributorCap: 1,
  halfLifeDays: { journey_completed: 14, route_feedback: 14, infra_report: 7, incident_verified: 14 } satisfies Record<SignalKind, number>,
  ttlDays: { journey_completed: 30, route_feedback: 30, infra_report: 14, incident_verified: 30 } satisfies Record<SignalKind, number>,
} as const;

export interface Signal {
  kind: SignalKind;
  polarity: 1 | -1;
  weight: number;
  contributorId: string;
  createdAt: string;
  expiresAt: string;
}

export const decay = (ageMs: number, halfLifeDays: number) => 0.5 ** (Math.max(0, ageMs) / (halfLifeDays * 86_400_000));

export interface CellAggregate {
  positive: number;
  negative: number;
  contributors: number;
  value: number;
}

export function aggregate(signals: Signal[], now: number): CellAggregate {
  const perContributor = new Map<string, { pos: number; neg: number }>();
  for (const s of signals) {
    if (Date.parse(s.expiresAt) <= now) continue;
    const w = s.weight * decay(now - Date.parse(s.createdAt), PULSE.halfLifeDays[s.kind]);
    const c = perContributor.get(s.contributorId) ?? { pos: 0, neg: 0 };
    if (s.polarity > 0) c.pos += w;
    else c.neg += w;
    perContributor.set(s.contributorId, c);
  }
  let positive = 0;
  let negative = 0;
  for (const { pos, neg } of perContributor.values()) {
    const total = pos + neg;
    // Scale a contributor's combined influence down to the cap, keeping their positive/negative mix.
    const scale = total > PULSE.perContributorCap ? PULSE.perContributorCap / total : 1;
    positive += pos * scale;
    negative += neg * scale;
  }
  const contributors = perContributor.size;
  const value = 0.5 + (0.5 * (positive - negative)) / (positive + negative + PULSE.shrinkage);
  return { positive, negative, contributors, value: Math.min(1, Math.max(0, value)) };
}

export function pulseLevel(a: { contributors: number; value: number }): 'insufficient' | 'positive' | 'neutral' | 'cautionary' {
  if (a.contributors < PULSE.minContributors) return 'insufficient';
  if (a.value >= 0.6) return 'positive';
  if (a.value <= 0.4) return 'cautionary';
  return 'neutral';
}

export const contributorBucket = (n: number) => (n < 3 ? 'fewer than 3' : n < 10 ? '3–9' : '10 or more') as 'fewer than 3' | '3–9' | '10 or more';
