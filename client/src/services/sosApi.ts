import { receivedSosSchema, sosEventSchema, sosSettingsSchema, type SosSettings } from '@mahilasathi/shared';
import { z } from 'zod';
import { apiRequest } from './apiClient';

const enc = encodeURIComponent;
const sosViewSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('owner'), event: sosEventSchema }),
  z.object({ kind: z.literal('recipient'), event: receivedSosSchema }),
]);

export const sosApi = {
  settings: () => apiRequest('/users/me/sos-settings', { schema: sosSettingsSchema }),
  updateSettings: (patch: Partial<SosSettings>) => apiRequest('/users/me/sos-settings', { method: 'PATCH', body: patch, schema: sosSettingsSchema }),
  /** Same key on a retry returns the same SOS, so retrying after a network error is always safe. */
  activate: (input: { idempotencyKey: string; location?: { lat: number; lng: number; accuracyM?: number }; note?: string }) =>
    apiRequest('/sos', { method: 'POST', body: input, schema: sosEventSchema, timeoutMs: 20_000 }),
  active: () => apiRequest('/sos/active', { schema: z.object({ sos: sosEventSchema.nullable() }) }),
  get: (id: string) => apiRequest(`/sos/${enc(id)}`, { schema: sosViewSchema }),
  received: () => apiRequest('/sos/received', { schema: z.object({ alerts: z.array(receivedSosSchema) }) }),
  acknowledge: (id: string, response: 'seen' | 'calling' | 'on_my_way') =>
    apiRequest(`/sos/${enc(id)}/acknowledge`, { method: 'POST', body: { response }, schema: receivedSosSchema }),
  end: (id: string, outcome: 'safe' | 'false_alarm') => apiRequest(`/sos/${enc(id)}/cancel`, { method: 'POST', body: { outcome }, schema: sosEventSchema }),
  postLocation: (id: string, p: { lat: number; lng: number; accuracyM?: number }) =>
    apiRequest(`/sos/${enc(id)}/location`, { method: 'POST', body: p, schema: z.object({ stored: z.boolean() }) }),
  setLocationSharing: (id: string, enabled: boolean) =>
    apiRequest(`/sos/${enc(id)}/location-sharing`, { method: 'PUT', body: { enabled }, schema: sosEventSchema }),
};

export const privacyApi = {
  stopAllLocationSharing: () => apiRequest('/users/me/stop-location-sharing', { method: 'POST', schema: z.object({ journeys: z.number(), sos: z.number() }) }),
  clearJourneyHistory: () => apiRequest('/trips/history', { method: 'DELETE', schema: z.object({ deleted: z.number() }) }),
  exportData: () => apiRequest('/users/me/export', { timeoutMs: 30_000 }),
};
