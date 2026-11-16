import { z } from 'zod';
import { TRAVEL_MODES } from './routes.js';

// ─── Journey state machine ────────────────────────────────────────────────────

export const TRIP_STATUSES = ['CREATED', 'ACTIVE', 'DELAYED', 'ARRIVED', 'CANCELLED', 'ESCALATED'] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];

/**
 * Allowed transitions (validated on the server). From the specification: CREATED→ACTIVE→ARRIVED,
 * ACTIVE→DELAYED/CANCELLED/ESCALATED, DELAYED→ACTIVE/ARRIVED. Added: a journey can be cancelled before
 * it starts or while delayed, and a delayed journey can be escalated.
 */
export const TRIP_TRANSITIONS: Record<TripStatus, TripStatus[]> = {
  CREATED: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['ARRIVED', 'DELAYED', 'CANCELLED', 'ESCALATED'],
  DELAYED: ['ACTIVE', 'ARRIVED', 'CANCELLED', 'ESCALATED'],
  ARRIVED: [],
  CANCELLED: [],
  ESCALATED: ['ARRIVED'],
};
export const TERMINAL_STATUSES: TripStatus[] = ['ARRIVED', 'CANCELLED'];
export const canTransition = (from: TripStatus, to: TripStatus) => TRIP_TRANSITIONS[from].includes(to);

// ─── Requests ─────────────────────────────────────────────────────────────────

export const SHARE_LEVELS = ['status', 'approximate', 'precise'] as const;
export type ShareLevel = (typeof SHARE_LEVELS)[number];

export const createTripSchema = z
  .object({
    /** A route from the caller's own plan (owner-checked on the server). */
    routeId: z.string().regex(/^[0-9a-f-]{36}\.\d{1,2}$/),
    originLabel: z.string().trim().max(120).optional(),
    destinationLabel: z.string().trim().max(120).optional(),
    /** Share with the caller's Guardian Circle at this level; omit to keep the journey private. */
    shareLevel: z.enum(SHARE_LEVELS).nullable().optional(),
  })
  .strict();

/** Users can start, finish, cancel or escalate. DELAYED is set by the server's schedule, never by clients. */
export const updateTripStatusSchema = z
  .object({
    status: z.enum(['ACTIVE', 'ARRIVED', 'CANCELLED', 'ESCALATED']),
    feedback: z.enum(['comfortable', 'uneasy']).optional(),
  })
  .strict();

export const checkinSchema = z.object({ note: z.string().trim().max(200).optional() }).strict();
export const locationUpdateSchema = z
  .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracyM: z.number().min(0).max(10_000).optional() })
  .strict();
export const shareRequestSchema = z.object({ level: z.enum(SHARE_LEVELS) }).strict();

// ─── Responses ────────────────────────────────────────────────────────────────

const routeSummarySchema = z.object({
  label: z.string(),
  distanceM: z.number(),
  durationS: z.number(),
  score: z.number().nullable(),
  confidence: z.string(),
  geometry: z.array(z.tuple([z.number(), z.number()])),
});

export const tripSchema = z.object({
  id: z.string(),
  status: z.enum(TRIP_STATUSES),
  mode: z.enum(TRAVEL_MODES),
  originLabel: z.string().nullable(),
  destinationLabel: z.string().nullable(),
  route: routeSummarySchema,
  departureTime: z.string(),
  startedAt: z.string().nullable(),
  expectedArrivalAt: z.string().nullable(),
  arrivedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  lastCheckinAt: z.string().nullable(),
  nextCheckinDueAt: z.string().nullable(),
  locationSharing: z.boolean(),
  allowedTransitions: z.array(z.enum(TRIP_STATUSES)),
  shares: z.array(z.object({ id: z.string(), circleName: z.string(), level: z.enum(SHARE_LEVELS), active: z.boolean(), acknowledgedBy: z.array(z.string()) })),
  createdAt: z.string(),
});
export type Trip = z.infer<typeof tripSchema>;

/** What a Guardian sees. Detail grows with the share level; nothing precise after the journey ends. */
export const sharedTripSchema = z.object({
  id: z.string(),
  shareId: z.string(),
  travellerName: z.string(),
  level: z.enum(SHARE_LEVELS),
  status: z.enum(TRIP_STATUSES),
  mode: z.enum(TRAVEL_MODES),
  destinationArea: z.string().nullable(),
  startedAt: z.string().nullable(),
  expectedArrivalAt: z.string().nullable(),
  arrivedAt: z.string().nullable(),
  lastCheckinAt: z.string().nullable(),
  /** approximate: area name only; precise: exact point. Null when not shared or the journey has ended. */
  lastLocation: z
    .object({ areaName: z.string().nullable(), lat: z.number().nullable(), lng: z.number().nullable(), recordedAt: z.string() })
    .nullable(),
  progressPct: z.number().nullable(),
  route: routeSummarySchema.nullable(),
  acknowledged: z.boolean(),
});
export type SharedTrip = z.infer<typeof sharedTripSchema>;

// ─── Walk Together ────────────────────────────────────────────────────────────

export const walkTogetherRequestSchema = z.object({ tripId: z.string().uuid(), windowMinutes: z.number().int().min(10).max(45).default(20) }).strict();

export const walkMatchSchema = z.object({
  id: z.string(),
  status: z.enum(['proposed', 'accepted', 'rejected', 'cancelled']),
  /** The other traveller's pseudonym. Never a name, phone or exact location. */
  otherHandle: z.string(),
  overlapPct: z.number().int(),
  sharedAreas: z.array(z.string()),
  theirWindow: z.object({ start: z.string(), end: z.string() }),
  myAccepted: z.boolean(),
  theyAccepted: z.boolean(),
  /** Set once both accept: a private two-person channel. */
  channelId: z.string().nullable(),
});
export type WalkMatch = z.infer<typeof walkMatchSchema>;

// ─── Community reports & Pulse ────────────────────────────────────────────────

export const COMMUNITY_REPORT_CATEGORIES = [
  'poor_lighting',
  'broken_streetlight',
  'harassment',
  'suspicious_activity',
  'road_obstruction',
  'closed_establishment',
  'transport_issue',
  'other',
] as const;
/** Allegations about people: never shown publicly unless a moderator verifies them. */
export const SENSITIVE_REPORT_CATEGORIES: readonly string[] = ['harassment', 'suspicious_activity'];

export const createCommunityReportSchema = z
  .object({
    category: z.enum(COMMUNITY_REPORT_CATEGORIES),
    description: z.string().trim().min(10, 'Add a few words about what you saw').max(500),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    occurredAt: z.string().datetime().optional(),
  })
  .strict();

export const communityReportViewSchema = z.object({
  id: z.string(),
  category: z.enum(COMMUNITY_REPORT_CATEGORIES),
  label: z.enum(['Community reported', 'Under review', 'Verified information']),
  description: z.string().nullable(),
  areaName: z.string().nullable(),
  occurredAt: z.string(),
  expiresAt: z.string(),
  mine: z.boolean(),
  /** Submitted by a fictional demo account: shown as a demo report and never counted in the Pulse. */
  demo: z.boolean(),
});
export type CommunityReportView = z.infer<typeof communityReportViewSchema>;

export const pulseCellSchema = z.object({
  cell: z.string(),
  level: z.enum(['insufficient', 'positive', 'neutral', 'cautionary']),
  value: z.number().min(0).max(1),
  /** Bucketed so individual contributors can't be inferred. */
  contributors: z.enum(['fewer than 3', '3–9', '10 or more']),
  updatedAt: z.string(),
});
export type PulseCell = z.infer<typeof pulseCellSchema>;

export const reviewCommunityReportSchema = z
  .object({ decision: z.enum(['verify', 'reject']), note: z.string().trim().min(3).max(300) })
  .strict();

export const pulseQuerySchema = z.object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180) });
