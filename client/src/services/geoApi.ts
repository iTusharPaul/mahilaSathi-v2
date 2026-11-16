import {
  districtSummarySchema,
  geoSearchResponseSchema,
  neighbourhoodSchema,
  resolutionSchema,
} from '@mahilasathi/shared';
import { z } from 'zod';
import { apiRequest } from './apiClient';

export const geoApi = {
  search: (q: string, signal?: AbortSignal) =>
    apiRequest(`/geo/search?${new URLSearchParams({ q, limit: '8' })}`, {
      schema: geoSearchResponseSchema,
      ...(signal ? { signal } : {}),
    }),
  resolve: (lat: number, lng: number) =>
    apiRequest(`/geo/resolve?${new URLSearchParams({ lat: String(lat), lng: String(lng) })}`, { schema: resolutionSchema }),
  neighbourhoods: (params: { districtId?: string; near?: { lat: number; lng: number }; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params.districtId) qs.set('districtId', params.districtId);
    if (params.near) qs.set('near', `${params.near.lat},${params.near.lng}`);
    qs.set('limit', String(params.limit ?? 50));
    return apiRequest(`/geo/neighbourhoods?${qs}`, { schema: z.object({ neighbourhoods: z.array(neighbourhoodSchema) }) });
  },
  districts: () =>
    apiRequest('/geo/districts', {
      schema: z.object({ districts: z.array(districtSummarySchema), dataset: z.object({ id: z.string(), version: z.string() }) }),
    }),
};
