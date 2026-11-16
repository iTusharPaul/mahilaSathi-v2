import { routePlanSchema, type PlanRouteRequest } from '@mahilasathi/shared';
import { apiRequest } from './apiClient';

export const routesApi = {
  // Planning fetches live place data for the whole corridor on first use, so allow longer than usual.
  plan: (input: PlanRouteRequest) => apiRequest('/routes/plan', { method: 'POST', body: input, schema: routePlanSchema, timeoutMs: 60_000 }),
};
