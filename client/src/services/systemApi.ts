import { healthResponseSchema, publicConfigSchema, readyResponseSchema } from '@mahilasathi/shared';
import { apiRequest } from './apiClient';

export const systemApi = {
  health: () => apiRequest('/health', { schema: healthResponseSchema }),
  ready: () => apiRequest('/ready', { schema: readyResponseSchema, acceptStatuses: [503] }),
  config: () => apiRequest('/config', { schema: publicConfigSchema }),
};
