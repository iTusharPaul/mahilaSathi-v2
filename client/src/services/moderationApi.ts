import { auditEventSchema, communityReviewItemSchema, devSmsSchema, moderationQueueSchema, usageReportSchema } from '@mahilasathi/shared';
import { z } from 'zod';
import { apiRequest } from './apiClient';

const enc = encodeURIComponent;

/** Moderator tools. Every call carries the admin token; it is never stored by this module. */
export function moderationApi(token: string) {
  const headers = { 'X-Admin-Token': token };
  return {
    queue: () => apiRequest('/moderation/queue', { headers, schema: moderationQueueSchema }),
    resolve: (id: string, body: { action: 'dismiss' | 'warn' | 'remove_from_channel' | 'suspend'; reason: string; suspendHours?: number }) =>
      apiRequest(`/moderation/reports/${enc(id)}/resolve`, { method: 'POST', headers, body, schema: z.object({ status: z.string() }) }),
    communityReports: () => apiRequest('/moderation/community-reports', { headers, schema: z.object({ reports: z.array(communityReviewItemSchema) }) }),
    review: (id: string, decision: 'verify' | 'reject', note: string) =>
      apiRequest(`/moderation/community-reports/${enc(id)}/review`, { method: 'POST', headers, body: { decision, note }, schema: z.object({ status: z.string() }) }),
    usage: () => apiRequest('/moderation/usage', { headers, schema: usageReportSchema }),
    devSms: () => apiRequest('/moderation/dev-sms', { headers, schema: z.object({ messages: z.array(devSmsSchema) }) }),
    audit: (q: { action?: string; before?: string; limit?: number }) => {
      const params = new URLSearchParams();
      if (q.action) params.set('action', q.action);
      if (q.before) params.set('before', q.before);
      params.set('limit', String(q.limit ?? 50));
      return apiRequest(`/moderation/audit?${params}`, { headers, schema: z.object({ events: z.array(auditEventSchema) }) });
    },
  };
}
export type ModerationApi = ReturnType<typeof moderationApi>;
