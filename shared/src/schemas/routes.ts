import { z } from 'zod';
import { resolutionSchema } from './geo.js';

export const TRAVEL_MODES = ['walk', 'drive'] as const;
export type TravelMode = (typeof TRAVEL_MODES)[number];

export const FACTOR_KEYS = [
  'openEstablishments',
  'publicTransport',
  'mainRoadCoverage',
  'longestLowActivity',
  'routeSimplicity',
  'assistance',
  'cameraCoverage',
  'communityPulse',
] as const;
export type FactorKey = (typeof FACTOR_KEYS)[number];

/** Initial weights from the product specification. They sum to 1. */
export const BASE_WEIGHTS: Record<FactorKey, number> = {
  openEstablishments: 0.22,
  publicTransport: 0.1,
  mainRoadCoverage: 0.16,
  longestLowActivity: 0.2,
  routeSimplicity: 0.07,
  assistance: 0.1,
  cameraCoverage: 0.05,
  communityPulse: 0.1,
};

export const FACTOR_LABELS: Record<FactorKey, string> = {
  openEstablishments: 'Open establishments',
  publicTransport: 'Public transport',
  mainRoadCoverage: 'Main road coverage',
  longestLowActivity: 'Longest low-activity stretch',
  routeSimplicity: 'Route simplicity',
  assistance: 'Assistance infrastructure',
  cameraCoverage: 'Mapped cameras',
  communityPulse: 'Community Pulse',
};

const pointSchema = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), label: z.string().max(120).optional() });

export const planRouteRequestSchema = z
  .object({
    origin: pointSchema,
    destination: pointSchema,
    /** ISO time; defaults to now. Must be within the next 7 days. */
    departureTime: z.string().datetime().optional(),
    mode: z.enum(TRAVEL_MODES).default('drive'),
    preferences: z
      .object({ fewerIsolatedStretches: z.boolean().default(false), preferMainRoads: z.boolean().default(false) })
      .strict()
      .default({}),
  })
  .strict();
export type PlanRouteRequest = z.input<typeof planRouteRequestSchema>;

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export const factorResultSchema = z.object({
  key: z.enum(FACTOR_KEYS),
  /** 0–1, or null when unknown. Unknown factors are excluded from the score, never counted as zero. */
  score: z.number().min(0).max(1).nullable(),
  /** Human-readable raw value, e.g. "14 open of 41 mapped". */
  raw: z.string(),
  source: z.string(),
  /** When the underlying data was fetched (ISO), or null for computed-from-route factors. */
  dataTimestamp: z.string().nullable(),
  confidence: z.enum(CONFIDENCE_LEVELS),
  explanation: z.string(),
  baseWeight: z.number(),
  /** Weight actually applied after preferences and redistribution (0 when unknown). */
  appliedWeight: z.number(),
});
export type FactorResult = z.infer<typeof factorResultSchema>;

export const scoredRouteSchema = z.object({
  id: z.string(),
  label: z.string(),
  variant: z.string(),
  synthetic: z.boolean(),
  score: z.number().int().min(0).max(100).nullable(),
  confidence: z.enum(CONFIDENCE_LEVELS),
  confidenceValue: z.number().min(0).max(1),
  durationS: z.number(),
  distanceM: z.number(),
  turns: z.number().int(),
  metrics: z.object({
    openEstablishments: z.number().int().nullable(),
    mappedEstablishments: z.number().int().nullable(),
    hoursKnown: z.number().int().nullable(),
    transitStops: z.number().int().nullable(),
    longestLowActivityM: z.number().nullable(),
    assistancePoints: z.number().int().nullable(),
    mainRoadPct: z.number().nullable(),
    cameras: z.number().int().nullable(),
  }),
  factors: z.array(factorResultSchema),
  reasons: z.array(z.string()),
  /** States/districts the route passes through, in order (cross-city/state journeys are one route). */
  jurisdictions: z.array(z.object({ stateId: z.string(), stateName: z.string(), districtName: z.string() })),
  /** [lng, lat] pairs for drawing. */
  geometry: z.array(z.tuple([z.number(), z.number()])),
  /** Markers for the map: places that count towards the score. Names only, no personal data. */
  places: z.array(z.object({ lat: z.number(), lng: z.number(), kind: z.string(), name: z.string().nullable(), open: z.boolean().nullable() })),
});
export type ScoredRoute = z.infer<typeof scoredRouteSchema>;

export const RANKINGS = ['score', 'fastest', 'balanced'] as const;
export type Ranking = (typeof RANKINGS)[number];

export const routePlanSchema = z.object({
  planId: z.string(),
  createdAt: z.string(),
  departureTime: z.string(),
  mode: z.enum(TRAVEL_MODES),
  origin: z.object({ label: z.string().nullable(), resolution: resolutionSchema }),
  destination: z.object({ label: z.string().nullable(), resolution: resolutionSchema }),
  routes: z.array(scoredRouteSchema),
  rankings: z.object({ score: z.array(z.string()), fastest: z.array(z.string()), balanced: z.array(z.string()) }),
  providers: z.object({
    routing: z.object({ name: z.string(), mode: z.enum(['live', 'dev-adapter']) }),
    places: z.object({ name: z.string(), status: z.enum(['ok', 'partial', 'unavailable']), fetchedAt: z.string().nullable(), cached: z.boolean() }),
    cameras: z.object({ name: z.string(), status: z.enum(['ok', 'unavailable']), fetchedAt: z.string().nullable() }),
  }),
  notices: z.array(z.string()),
  disclaimer: z.string(),
});
export type RoutePlan = z.infer<typeof routePlanSchema>;

export const compareRequestSchema = z.object({ planId: z.string().uuid(), ranking: z.enum(RANKINGS) }).strict();
