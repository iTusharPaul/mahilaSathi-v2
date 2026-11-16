import { BASE_WEIGHTS, FACTOR_KEYS, type ConfidenceLevel, type FactorKey, type FactorResult } from '@mahilasathi/shared';
import type { FactorValue } from './factors.js';

export interface Preferences {
  fewerIsolatedStretches: boolean;
  preferMainRoads: boolean;
}

const CONFIDENCE_VALUE: Record<ConfidenceLevel, number> = { high: 1, medium: 0.7, low: 0.4 };
/** Below this share of (non-cold-start) weight with known data, no score is shown at all. */
export const MIN_KNOWN_WEIGHT = 0.4;

/** Preferences boost one factor ×1.5, then all weights are renormalised to sum to 1. */
export function effectiveWeights(prefs: Preferences): Record<FactorKey, number> {
  const w = { ...BASE_WEIGHTS };
  if (prefs.fewerIsolatedStretches) w.longestLowActivity *= 1.5;
  if (prefs.preferMainRoads) w.mainRoadCoverage *= 1.5;
  const total = FACTOR_KEYS.reduce((s, k) => s + w[k], 0);
  for (const k of FACTOR_KEYS) w[k] = w[k] / total;
  return w;
}

export interface ScoreResult {
  score: number | null;
  confidence: ConfidenceLevel;
  confidenceValue: number;
  factors: FactorResult[];
  missing: FactorKey[];
}

/**
 * Night Activity Score (0–100). Unknown factors are excluded and the remaining weights are scaled up
 * proportionally; confidence falls with every excluded factor and every low-confidence one. If too
 * little is known, the score is withheld rather than guessed.
 */
export function combine(values: FactorValue[], prefs: Preferences): ScoreResult {
  const weights = effectiveWeights(prefs);
  const byKey = new Map(values.map((v) => [v.key, v]));
  const known = FACTOR_KEYS.filter((k) => byKey.get(k)?.score !== null && byKey.get(k) !== undefined);
  const knownWeight = known.reduce((s, k) => s + weights[k], 0);
  const informativeWeight = known.filter((k) => k !== 'communityPulse').reduce((s, k) => s + weights[k], 0);

  const factors: FactorResult[] = FACTOR_KEYS.map((key) => {
    const v = byKey.get(key)!;
    const isKnown = v.score !== null;
    return {
      ...v,
      baseWeight: weights[key],
      appliedWeight: isKnown && knownWeight > 0 ? weights[key] / knownWeight : 0,
    };
  });

  const confidenceValue = known.reduce((s, k) => s + weights[k] * CONFIDENCE_VALUE[byKey.get(k)!.confidence], 0);
  const confidence: ConfidenceLevel = confidenceValue >= 0.7 ? 'high' : confidenceValue >= 0.45 ? 'medium' : 'low';

  const score =
    informativeWeight < MIN_KNOWN_WEIGHT
      ? null
      : Math.round((100 * known.reduce((s, k) => s + weights[k] * byKey.get(k)!.score!, 0)) / knownWeight);

  return {
    score,
    confidence,
    confidenceValue: Math.round(confidenceValue * 100) / 100,
    factors,
    missing: FACTOR_KEYS.filter((k) => !known.includes(k)),
  };
}
