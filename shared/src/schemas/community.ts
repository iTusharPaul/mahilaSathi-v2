import { z } from 'zod';
import { indianMobileSchema } from './auth.js';

// ─── Custom (MS:) message types ───────────────────────────────────────────────
// Every structured message is validated against these schemas by the server, both when the server
// sends it and when the Nexconn pre-messaging webhook sees one sent from a client.

export const INFRA_CATEGORIES = [
  'poor_lighting',
  'broken_streetlight',
  'closed_establishment',
  'road_obstruction',
  'transport_issue',
  'other',
] as const;

export const infraUpdatePayloadSchema = z
  .object({
    category: z.enum(INFRA_CATEGORIES),
    note: z.string().trim().min(3).max(280),
    /** Area name only (e.g. the neighbourhood), never coordinates. */
    areaLabel: z.string().trim().min(2).max(80),
  })
  .strict();
export type InfraUpdatePayload = z.infer<typeof infraUpdatePayloadSchema>;

export const systemNoticePayloadSchema = z
  .object({
    kind: z.enum(['member_joined', 'member_left', 'room_archived', 'moderation', 'safety_tip']),
    text: z.string().max(280),
  })
  .strict();

export const journeyStatusPayloadSchema = z
  .object({
    tripId: z.string().uuid(),
    status: z.enum(['CREATED', 'ACTIVE', 'DELAYED', 'ARRIVED', 'CANCELLED', 'ESCALATED']),
    text: z.string().max(280),
  })
  .strict();

/** SOS notice in a Guardian Circle chat. Never carries coordinates; guardians open the app for location. */
export const sosAlertPayloadSchema = z
  .object({
    sosId: z.string().uuid(),
    status: z.enum(['ACTIVE', 'RESOLVED', 'CANCELLED']),
    text: z.string().max(280),
  })
  .strict();

export const MS_MESSAGE_TYPES = {
  infraUpdate: 'MS:InfraUpdate',
  systemNotice: 'MS:SystemNotice',
  journeyStatus: 'MS:JourneyStatus',
  sosAlert: 'MS:SosAlert',
} as const;

/** Registered with the chat SDK before connecting. */
export const MS_MESSAGE_REGISTRATIONS = [
  { messageType: MS_MESSAGE_TYPES.infraUpdate, isPersisted: true, isCounted: true },
  { messageType: MS_MESSAGE_TYPES.systemNotice, isPersisted: true, isCounted: false },
  { messageType: MS_MESSAGE_TYPES.journeyStatus, isPersisted: true, isCounted: true },
  { messageType: MS_MESSAGE_TYPES.sosAlert, isPersisted: true, isCounted: true },
] as const;

/** Only the server may send these. */
export const SERVER_ONLY_MESSAGE_TYPES: readonly string[] = [MS_MESSAGE_TYPES.systemNotice, MS_MESSAGE_TYPES.journeyStatus, MS_MESSAGE_TYPES.sosAlert];

export const MS_PAYLOAD_SCHEMAS: Record<string, z.ZodTypeAny> = {
  [MS_MESSAGE_TYPES.infraUpdate]: infraUpdatePayloadSchema,
  [MS_MESSAGE_TYPES.systemNotice]: systemNoticePayloadSchema,
  [MS_MESSAGE_TYPES.journeyStatus]: journeyStatusPayloadSchema,
  [MS_MESSAGE_TYPES.sosAlert]: sosAlertPayloadSchema,
};

export const TEXT_MESSAGE_TYPE = 'RC:TxtMsg';
export const MAX_TEXT_LENGTH = 1000;

// ─── Chat session ─────────────────────────────────────────────────────────────

export const chatSessionSchema = z.object({
  mode: z.enum(['nexconn', 'dev-relay']),
  chatUserId: z.string(),
  nexconn: z
    .object({
      appKey: z.string(),
      areaCode: z.enum(['sg', 'na']),
      token: z.string(),
    })
    .nullable(),
  customMessageTypes: z.array(z.object({ messageType: z.string(), isPersisted: z.boolean(), isCounted: z.boolean() })),
});
export type ChatSession = z.infer<typeof chatSessionSchema>;

// ─── Channels ─────────────────────────────────────────────────────────────────

const areaRefSchema = z.object({ type: z.enum(['neighbourhood', 'district']), id: z.string(), name: z.string() });

export const channelSummarySchema = z.object({
  id: z.string(),
  kind: z.enum(['neighbourhood', 'journey_room', 'guardian_circle', 'walk_together']),
  name: z.string(),
  status: z.enum(['active', 'archived']),
  memberCount: z.number().int(),
  maxMembers: z.number().int(),
  isMember: z.boolean(),
  role: z.enum(['member', 'owner', 'moderator']).nullable(),
  /** Provider channel id: only given to members, who need it to connect. */
  providerChannelId: z.string().nullable(),
  neighbourhood: z.object({ id: z.string(), name: z.string(), districtName: z.string() }).nullable(),
  journey: z
    .object({
      from: areaRefSchema,
      to: areaRefSchema,
      windowStart: z.string(),
      windowEnd: z.string(),
      expiresAt: z.string(),
    })
    .nullable(),
  lastActivityAt: z.string(),
});
export type ChannelSummary = z.infer<typeof channelSummarySchema>;

export const channelMemberSchema = z.object({
  publicId: z.string(),
  handle: z.string(),
  /** Shown only inside a Guardian Circle, where members know each other. */
  displayName: z.string().nullable(),
  role: z.enum(['member', 'owner', 'moderator']),
  isMe: z.boolean(),
  /** A fictional demo account. */
  isDemo: z.boolean(),
});
export type ChannelMember = z.infer<typeof channelMemberSchema>;

export const relayMessageSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  senderPublicId: z.string().nullable(),
  messageType: z.string(),
  content: z.record(z.unknown()),
  sentAt: z.string(),
  seq: z.number().int(),
});
export type RelayMessage = z.infer<typeof relayMessageSchema>;

export const sendTextSchema = z.object({ text: z.string().trim().min(1, 'Message is empty').max(MAX_TEXT_LENGTH) }).strict();
export const sendInfraUpdateSchema = infraUpdatePayloadSchema.omit({ areaLabel: true });

const areaInputSchema = z.object({ type: z.enum(['neighbourhood', 'district']), id: z.string().max(80) });
export const createJourneyRoomSchema = z
  .object({
    from: areaInputSchema,
    to: areaInputSchema,
    windowStart: z.string().datetime(),
    windowMinutes: z.number().int().min(15).max(120),
  })
  .strict();
export type CreateJourneyRoom = z.infer<typeof createJourneyRoomSchema>;

// ─── Guardian Circle ──────────────────────────────────────────────────────────

export const createCircleSchema = z.object({ name: z.string().trim().min(1).max(40).default('My Guardian Circle') }).strict();
export const createInviteSchema = z.object({ phone: indianMobileSchema.optional() }).strict();
export const INVITE_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}$/;
export const acceptInviteSchema = z
  .object({ code: z.string().trim().toUpperCase().regex(INVITE_CODE_PATTERN, 'Enter the 8-character invite code') })
  .strict();

export const circleSchema = z.object({
  id: z.string(),
  name: z.string(),
  isOwner: z.boolean(),
  channelId: z.string(),
  owner: z.object({ publicId: z.string(), handle: z.string(), displayName: z.string().nullable() }),
  members: z.array(
    z.object({
      publicId: z.string(),
      handle: z.string(),
      displayName: z.string().nullable(),
      role: z.enum(['owner', 'guardian']),
      joinedAt: z.string(),
    }),
  ),
  pendingInvites: z.array(z.object({ id: z.string(), expiresAt: z.string(), boundToPhone: z.boolean() })),
});
export type Circle = z.infer<typeof circleSchema>;

export const inviteCreatedSchema = z.object({ id: z.string(), code: z.string(), expiresAt: z.string(), boundToPhone: z.boolean() });

// ─── Safety: reports & blocks ─────────────────────────────────────────────────

export const REPORT_REASONS = [
  'harassment',
  'threat',
  'spam',
  'sharing_personal_info',
  'inappropriate',
  'impersonation',
  'other',
] as const;

export const messageReportSchema = z
  .object({
    channelId: z.string().uuid(),
    reason: z.enum(REPORT_REASONS),
    details: z.string().trim().max(500).optional(),
    /** With Nexconn the server cannot read the message, so the reporter's copy is kept and labelled as such. */
    snapshot: z
      .object({ text: z.string().max(MAX_TEXT_LENGTH * 2), senderPublicId: z.string().max(80), sentAt: z.number().int() })
      .optional(),
  })
  .strict();

export const userReportSchema = z
  .object({
    reportedPublicId: z.string().max(80),
    reason: z.enum(REPORT_REASONS),
    details: z.string().trim().max(500).optional(),
    channelId: z.string().uuid().optional(),
  })
  .strict();

export const blockedUserSchema = z.object({ publicId: z.string(), handle: z.string(), blockedAt: z.string() });
export type BlockedUser = z.infer<typeof blockedUserSchema>;

export const moderationResolveSchema = z
  .object({
    action: z.enum(['dismiss', 'warn', 'remove_from_channel', 'suspend']),
    reason: z.string().trim().min(3).max(300),
    suspendHours: z.number().int().min(1).max(24 * 90).optional(),
  })
  .strict();
