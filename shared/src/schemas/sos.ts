import { z } from 'zod';

// ─── State machine ────────────────────────────────────────────────────────────

export const SOS_STATUSES = ['ACTIVE', 'RESOLVED', 'CANCELLED'] as const;
export type SosStatus = (typeof SOS_STATUSES)[number];
/** An SOS ends once: RESOLVED ("I'm safe now") or CANCELLED ("false alarm"). It is never reopened; a new one is created. */
export const SOS_TRANSITIONS: Record<SosStatus, SosStatus[]> = { ACTIVE: ['RESOLVED', 'CANCELLED'], RESOLVED: [], CANCELLED: [] };
export const canTransitionSos = (from: SosStatus, to: SosStatus) => SOS_TRANSITIONS[from].includes(to);

// ─── Settings (escalation rules, configurable by the user) ───────────────────

export const SOS_LOCATION_DETAIL = ['precise', 'approximate', 'none'] as const;
export type SosLocationDetail = (typeof SOS_LOCATION_DETAIL)[number];
/** When emergency contacts (outside the app) are messaged. */
export const SOS_CONTACT_POLICIES = ['immediately', 'if_unacknowledged', 'never'] as const;
/** How the SOS shortcut (home-screen shortcut / ?activate link) behaves: open the hold button, or start a cancellable countdown. */
export const SOS_SHORTCUT_MODES = ['hold', 'countdown'] as const;

export const sosSettingsSchema = z.object({
  locationDetail: z.enum(SOS_LOCATION_DETAIL),
  emergencyContacts: z.enum(SOS_CONTACT_POLICIES),
  escalateAfterMinutes: z.number().int().min(1).max(15),
  shortcut: z.enum(SOS_SHORTCUT_MODES),
});
export type SosSettings = z.infer<typeof sosSettingsSchema>;
export const updateSosSettingsSchema = sosSettingsSchema
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

// ─── Requests ─────────────────────────────────────────────────────────────────

const pointSchema = z
  .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracyM: z.number().min(0).max(10_000).optional() })
  .strict();

export const activateSosSchema = z
  .object({
    /** Generated once per activation on the device. Retries with the same key return the same SOS. */
    idempotencyKey: z.string().uuid(),
    location: pointSchema.optional(),
    note: z.string().trim().max(200).optional(),
  })
  .strict();
export const sosLocationSchema = pointSchema;
export const sosLocationSharingSchema = z.object({ enabled: z.boolean() }).strict();
export const endSosSchema = z.object({ outcome: z.enum(['safe', 'false_alarm']) }).strict();
export const SOS_RESPONSES = ['seen', 'calling', 'on_my_way'] as const;
export const acknowledgeSosSchema = z.object({ response: z.enum(SOS_RESPONSES) }).strict();

// ─── Delivery ─────────────────────────────────────────────────────────────────

export const SOS_CHANNELS = ['in_app', 'circle_chat', 'sms'] as const;
/**
 * pending/sending: in progress · accepted: handed to the channel, delivery NOT confirmed ·
 * delivered: confirmed (in-app: the recipient's app loaded it) · failed: gave up after retries or a permanent error ·
 * unavailable: the channel is not set up on this server · skipped: no longer needed (SOS ended, or acknowledged in time).
 */
export const SOS_DELIVERY_STATUSES = ['pending', 'sending', 'accepted', 'delivered', 'failed', 'unavailable', 'skipped'] as const;
export type SosDeliveryStatus = (typeof SOS_DELIVERY_STATUSES)[number];

const deliverySchema = z.object({
  channel: z.enum(SOS_CHANNELS),
  purpose: z.enum(['alert', 'escalation', 'update', 'ended']),
  status: z.enum(SOS_DELIVERY_STATUSES),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  /** Safe, user-facing reason. Never contains provider secrets. */
  lastError: z.string().nullable(),
  nextAttemptAt: z.string().nullable(),
  /** True only for a development adapter: nothing real was sent. */
  devAdapter: z.boolean(),
  updatedAt: z.string(),
  confirmedAt: z.string().nullable(),
});
export type SosDelivery = z.infer<typeof deliverySchema>;

const locationViewSchema = z.object({
  areaName: z.string().nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  accuracyM: z.number().nullable(),
  recordedAt: z.string(),
  source: z.enum(['device', 'journey']),
});

/** The person who raised the SOS sees everything about it, including exactly what was (and wasn't) delivered. */
export const sosEventSchema = z.object({
  id: z.string(),
  /** Raised by a fictional demo account: every message it sends says DEMO, not a real emergency. */
  demo: z.boolean(),
  status: z.enum(SOS_STATUSES),
  activatedAt: z.string(),
  endedAt: z.string().nullable(),
  outcome: z.enum(['safe', 'false_alarm']).nullable(),
  tripId: z.string().nullable(),
  note: z.string().nullable(),
  locationDetail: z.enum(SOS_LOCATION_DETAIL),
  locationSharing: z.boolean(),
  location: locationViewSchema.nullable(),
  escalation: z.object({
    contactsPolicy: z.enum(SOS_CONTACT_POLICIES),
    stage: z.number().int(),
    nextAt: z.string().nullable(),
  }),
  circleChat: z.array(deliverySchema),
  recipients: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['guardian', 'emergency_contact']),
      name: z.string(),
      locationLevel: z.enum(SOS_LOCATION_DETAIL),
      deliveries: z.array(deliverySchema),
      acknowledgement: z.object({ response: z.enum(SOS_RESPONSES), at: z.string() }).nullable(),
    }),
  ),
  summary: z.object({
    recipients: z.number().int(),
    /** Recipients with at least one delivery confirmed by the channel. */
    confirmed: z.number().int(),
    acknowledged: z.number().int(),
    /** Recipients with no confirmed or accepted delivery and at least one failed or unavailable channel. */
    unreached: z.number().int(),
  }),
});
export type SosEvent = z.infer<typeof sosEventSchema>;

/** What a guardian who was alerted sees. Location detail follows the sender's setting. */
export const receivedSosSchema = z.object({
  id: z.string(),
  demo: z.boolean(),
  status: z.enum(SOS_STATUSES),
  travellerName: z.string(),
  activatedAt: z.string(),
  endedAt: z.string().nullable(),
  outcome: z.enum(['safe', 'false_alarm']).nullable(),
  note: z.string().nullable(),
  locationLevel: z.enum(SOS_LOCATION_DETAIL),
  location: locationViewSchema.nullable(),
  myResponse: z.enum(SOS_RESPONSES).nullable(),
  responses: z.array(z.object({ name: z.string(), response: z.enum(SOS_RESPONSES), at: z.string() })),
});
export type ReceivedSos = z.infer<typeof receivedSosSchema>;
