import {
  communityReportViewSchema,
  pulseCellSchema,
  sharedTripSchema,
  tripSchema,
  walkMatchSchema,
  type COMMUNITY_REPORT_CATEGORIES,
  type ShareLevel,
} from '@mahilasathi/shared';
import { z } from 'zod';
import { apiRequest } from './apiClient';

const enc = encodeURIComponent;
const walkStatusSchema = z.object({
  request: z.object({ tripId: z.string(), windowStart: z.string(), windowEnd: z.string(), status: z.string() }).nullable(),
  matches: z.array(walkMatchSchema),
});

export const journeysApi = {
  create: (input: { routeId: string; originLabel?: string; destinationLabel?: string; shareLevel?: ShareLevel | null }) =>
    apiRequest('/trips', { method: 'POST', body: input, schema: tripSchema }),
  active: () => apiRequest('/trips/active', { schema: z.object({ trip: tripSchema.nullable() }) }),
  list: () => apiRequest('/trips', { schema: z.object({ trips: z.array(tripSchema) }) }),
  get: (id: string) => apiRequest(`/trips/${enc(id)}`, { schema: tripSchema }),
  setStatus: (id: string, status: 'ACTIVE' | 'ARRIVED' | 'CANCELLED' | 'ESCALATED', feedback?: 'comfortable' | 'uneasy') =>
    apiRequest(`/trips/${enc(id)}/status`, { method: 'PATCH', body: feedback ? { status, feedback } : { status }, schema: tripSchema }),
  checkin: (id: string, note?: string) => apiRequest(`/trips/${enc(id)}/checkin`, { method: 'POST', body: note ? { note } : {}, schema: tripSchema }),
  share: (id: string, level: ShareLevel) => apiRequest(`/trips/${enc(id)}/share`, { method: 'POST', body: { level }, schema: tripSchema }),
  unshare: (id: string) => apiRequest(`/trips/${enc(id)}/share`, { method: 'DELETE', schema: tripSchema }),
  setLocationSharing: (id: string, enabled: boolean) => apiRequest(`/trips/${enc(id)}/location-sharing`, { method: 'PUT', body: { enabled }, schema: tripSchema }),
  postLocation: (id: string, p: { lat: number; lng: number; accuracyM?: number }) =>
    apiRequest(`/trips/${enc(id)}/location`, { method: 'POST', body: p, schema: z.object({ stored: z.boolean() }) }),

  sharedWithMe: () => apiRequest('/trips/shared', { schema: z.object({ trips: z.array(sharedTripSchema) }) }),
  shared: (shareId: string) => apiRequest(`/trips/shared/${enc(shareId)}`, { schema: sharedTripSchema }),
  acknowledge: (shareId: string) => apiRequest(`/trips/shared/${enc(shareId)}/acknowledge`, { method: 'POST', schema: sharedTripSchema }),

  walkStatus: (tripId: string) => apiRequest(`/walk-together/trips/${enc(tripId)}`, { schema: walkStatusSchema }),
  walkRequest: (tripId: string, windowMinutes: number) =>
    apiRequest('/walk-together/request', { method: 'POST', body: { tripId, windowMinutes }, schema: walkStatusSchema.extend({ request: walkStatusSchema.shape.request.unwrap() }) }),
  walkWithdraw: (tripId: string) => apiRequest(`/walk-together/trips/${enc(tripId)}`, { method: 'DELETE' }),
  walkAct: (matchId: string, action: 'accept' | 'reject' | 'cancel', expect?: 'proposed' | 'accepted') =>
    apiRequest(`/walk-together/matches/${enc(matchId)}/${action}`, { method: 'POST', ...(expect ? { body: { expect } } : {}), schema: walkMatchSchema }),

  pulse: (lat: number, lng: number) => apiRequest(`/community/pulse?lat=${lat}&lng=${lng}`, { schema: z.object({ cells: z.array(pulseCellSchema) }) }),
  reportsNear: (lat: number, lng: number) => apiRequest(`/community/reports?lat=${lat}&lng=${lng}`, { schema: z.object({ reports: z.array(communityReportViewSchema) }) }),
  myReports: () => apiRequest('/community/reports/mine', { schema: z.object({ reports: z.array(communityReportViewSchema.extend({ status: z.string() })) }) }),
  report: (input: { category: (typeof COMMUNITY_REPORT_CATEGORIES)[number]; description: string; lat: number; lng: number }) =>
    apiRequest('/community/reports', { method: 'POST', body: input, schema: communityReportViewSchema }),
};
