import { z } from 'zod';

export const latSchema = z.coerce.number().min(-90).max(90);
export const lngSchema = z.coerce.number().min(-180).max(180);
export const pointQuerySchema = z.object({ lat: latSchema, lng: lngSchema });

const refSchema = z.object({ id: z.string(), name: z.string() });
export type AreaRef = z.infer<typeof refSchema>;

export const COVERAGE_LEVELS = ['high', 'medium', 'low', 'unknown'] as const;
export const coverageSchema = z.object({
  level: z.enum(COVERAGE_LEVELS),
  /** Human-readable reason, e.g. "Not assessed yet". Unknown is never presented as negative. */
  summary: z.string(),
  assessedAt: z.string().nullable(),
  source: z.string().nullable(),
});
export type Coverage = z.infer<typeof coverageSchema>;

export const resolutionSchema = z.object({
  inNcr: z.boolean(),
  state: refSchema.nullable(),
  district: refSchema.nullable(),
  city: refSchema.nullable(),
  neighbourhood: refSchema.nullable(),
  /**
   * none: confidently resolved.
   * near_district_boundary: within the uncertainty band of a district edge; the district may be wrong.
   * near_ncr_boundary: just outside the mapped NCR edge; may actually be inside.
   */
  uncertainty: z.enum(['none', 'near_district_boundary', 'near_ncr_boundary']),
  needsManualConfirmation: z.boolean(),
  coverage: coverageSchema,
  message: z.string().nullable(),
  dataset: z.object({ id: z.string(), version: z.string() }),
});
export type Resolution = z.infer<typeof resolutionSchema>;

export const geoSearchResultSchema = z.object({
  id: z.string(),
  label: z.string(),
  secondary: z.string().nullable(),
  lat: z.number(),
  lng: z.number(),
  kind: z.enum(['neighbourhood', 'city', 'district', 'address', 'place']),
  source: z.enum(['registry', 'geoapify']),
  /** Registry ids when the result is a registry entry. */
  neighbourhoodId: z.string().nullable(),
  districtId: z.string().nullable(),
  stateName: z.string().nullable(),
});
export type GeoSearchResult = z.infer<typeof geoSearchResultSchema>;

export const geoSearchQuerySchema = z.object({
  q: z.string().trim().min(2, 'Type at least 2 characters').max(100),
  limit: z.coerce.number().int().min(1).max(15).default(8),
});

export const geoSearchResponseSchema = z.object({
  results: z.array(geoSearchResultSchema),
  provider: z.object({ name: z.string(), mode: z.enum(['live', 'dev-adapter']) }),
  /** Provider results outside NCR that were removed. */
  outsideNcrHidden: z.number().int().nonnegative(),
  /** True when the live provider failed and only the local registry was searched. */
  degraded: z.boolean(),
});
export type GeoSearchResponse = z.infer<typeof geoSearchResponseSchema>;

export const reverseResponseSchema = z.object({
  label: z.string().nullable(),
  resolution: resolutionSchema,
  provider: z.object({ name: z.string(), mode: z.enum(['live', 'dev-adapter']) }),
  degraded: z.boolean(),
});
export type ReverseResponse = z.infer<typeof reverseResponseSchema>;

export const neighbourhoodSchema = z.object({
  id: z.string(),
  name: z.string(),
  aliases: z.array(z.string()),
  state: refSchema,
  district: refSchema,
  city: refSchema.nullable(),
  center: z.object({ lat: z.number(), lng: z.number() }),
  radiusM: z.number(),
  coverage: coverageSchema,
});
export type Neighbourhood = z.infer<typeof neighbourhoodSchema>;

export const neighbourhoodListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  districtId: z.string().max(60).optional(),
  stateId: z.string().max(60).optional(),
  near: z
    .string()
    .regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/, 'near must be "lat,lng"')
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const districtSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  state: refSchema,
  aliases: z.array(z.string()),
  areaKm2: z.number(),
});
export type DistrictSummary = z.infer<typeof districtSummarySchema>;

export const coverageQuerySchema = z.union([
  z.object({ areaType: z.enum(['district', 'neighbourhood']), areaId: z.string().max(80) }),
  pointQuerySchema,
]);
