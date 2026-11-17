import { z } from 'zod';
import { COMMUNITY_REPORT_CATEGORIES } from './journeys.js';

/** Moderator views. People appear by community pseudonym only: never phone numbers or internal ids. */

const personSchema = z.object({
  handle: z.string(),
  isDemo: z.boolean(),
  /** Set while a suspension (automatic or by a moderator) is in force. */
  suspendedUntil: z.string().nullable(),
  /** Open reports against this person, across message and user reports. */
  openReports: z.number().int(),
});

export const moderationReportSchema = z.object({
  id: z.string(),
  type: z.enum(['message', 'user']),
  reason: z.string(),
  details: z.string().nullable(),
  createdAt: z.string(),
  /** Message reports: the text, from our server (development relay) or the reporter's copy (Nexconn). */
  snapshotText: z.string().nullable(),
  snapshotSource: z.enum(['server', 'reporter']).nullable(),
  reported: personSchema.nullable(),
  reporterHandle: z.string(),
  channel: z.object({ name: z.string(), kind: z.string() }).nullable(),
});
export type ModerationReport = z.infer<typeof moderationReportSchema>;

export const moderationQueueSchema = z.object({ messages: z.array(moderationReportSchema), users: z.array(moderationReportSchema) });
export type ModerationQueue = z.infer<typeof moderationQueueSchema>;

export const communityReviewItemSchema = z.object({
  id: z.string(),
  category: z.enum(COMMUNITY_REPORT_CATEGORIES),
  description: z.string(),
  areaName: z.string().nullable(),
  status: z.enum(['submitted', 'under_review']),
  occurredAt: z.string(),
  createdAt: z.string(),
  demo: z.boolean(),
});
export type CommunityReviewItem = z.infer<typeof communityReviewItemSchema>;

export const devSmsSchema = z.object({ id: z.string(), to: z.string(), body: z.string(), recordedAt: z.string() });
export type DevSms = z.infer<typeof devSmsSchema>;

export const auditEventSchema = z.object({
  id: z.string(),
  occurredAt: z.string(),
  actorType: z.string(),
  actorId: z.string().nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  requestId: z.string().nullable(),
  metadata: z.unknown(),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

/** Aggregate usage for the moderator screen. Counts only; demo accounts are excluded. Days are in IST. */
export const usageReportSchema = z.object({
  generatedAt: z.string(),
  accounts: z.object({ total: z.number().int(), google: z.number().int(), phone: z.number().int(), deleted: z.number().int() }),
  signUpsByDay: z.array(z.object({ day: z.string(), count: z.number().int() })),
  activeUsers: z.object({ last24h: z.number().int(), last7d: z.number().int() }),
  returningUsers: z.number().int(),
  routeComparisonsLast24h: z.number().int(),
  journeys: z.object({ created: z.number().int(), started: z.number().int(), arrived: z.number().int() }),
  guardianCircles: z.number().int(),
  sosRaised: z.number().int(),
  usersWithNotifications: z.number().int(),
  usersInCommunityChannels: z.number().int(),
});
export type UsageReport = z.infer<typeof usageReportSchema>;
