import crypto from 'node:crypto';
import type { Logger } from 'pino';
import { MS_MESSAGE_TYPES, type ReceivedSos, type SosDelivery, type SosEvent, type SosSettings } from '@mahilasathi/shared';
import type { AuditRepository } from '../../repositories/auditRepository.js';
import type { CircleRepository } from '../../repositories/circleRepository.js';
import type { EmergencyContactRepository } from '../../repositories/emergencyContactRepository.js';
import type { DeliveryRow, SosEventRow, SosRecipientRow, SosRepository } from '../../repositories/sosRepository.js';
import type { TripRepository } from '../../repositories/tripRepository.js';
import type { UserRepository, UserRow } from '../../repositories/userRepository.js';
import { AppError, notFound } from '../../utils/errors.js';
import type { Clock } from '../../utils/crypto.js';
import { ChannelUnavailableError, type CommunityService } from '../community/communityService.js';
import type { GeoRegistry } from '../geography/geoRegistry.js';
import { SmsPermanentError, type SmsProvider } from './smsProvider.js';
import type { PushService } from '../push/pushService.js';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

export const SOS_POLICY = {
  /** Tries per delivery before it is marked failed. */
  maxAttempts: 5,
  /** Wait before try 2, 3, 4, 5. */
  backoffMs: [10 * SEC, 30 * SEC, 90 * SEC, 270 * SEC],
  /** A claimed job not finished within this is considered abandoned (crash) and retried. */
  leaseMs: 60 * SEC,
  /** Live location updates closer together than this are ignored. */
  locationMinIntervalMs: 10 * SEC,
  /** Guardians keep seeing an ended SOS (with its outcome) for this long. */
  guardianViewAfterEndMs: 12 * HOUR,
  coordinateRetentionMs: 30 * 24 * HOUR,
  devSmsRetentionMs: 7 * 24 * HOUR,
} as const;

/** A delivery error that retrying cannot fix. */
class PermanentDeliveryError extends Error {}

const RESPONSE_TEXT = { seen: 'has seen the SOS', calling: 'is calling them', on_my_way: 'is on the way' } as const;
const timeIst = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });

/**
 * Durable SOS. The database is the source of truth: an SOS, its recipients and every delivery job are
 * written in one transaction before anything is sent. A worker (not the browser) sends due jobs, retries
 * transient failures with backoff, and recovers jobs abandoned by a crash. Statuses only claim what a
 * channel actually confirmed: "accepted" means handed over, "delivered" means confirmed.
 */
export function createSosService(deps: {
  repo: SosRepository;
  trips: TripRepository;
  circles: CircleRepository;
  contacts: EmergencyContactRepository;
  users: UserRepository;
  community: CommunityService;
  sms: SmsProvider;
  registry: GeoRegistry;
  audit: AuditRepository;
  clock: Clock;
  logger: Logger;
  /** Optional push notifications to guardians (best effort; never part of delivery status). */
  push?: PushService;
  /**
   * Public demo server: label every SOS from a phone-code account as a demo (anyone can sign in with any number
   * there), so nobody mistakes a test for a real emergency. Google accounts are real people: never labelled.
   */
  demoMode?: boolean;
}) {
  const { repo, trips, circles, contacts, users, community, sms, registry, audit, clock, logger } = deps;
  /** Push to guardians of an SOS. Not tracked as a delivery: a push service can't confirm the person saw it. */
  const pushGuardians = (e: SosEventRow, userIds: string[], title: string, body: string, urgent: boolean) => {
    if (!deps.push || userIds.length === 0) return;
    void deps.push.notify(userIds, 'sos', { title: e.is_demo === 1 ? `DEMO (not real): ${title}` : title, body, url: `/sos/alerts/${e.id}`, tag: `sos-${e.id}`, urgent });
  };
  const guardianIds = (sosId: string) => repo.recipients(sosId).filter((r) => r.kind === 'guardian' && r.user_id).map((r) => r.user_id!);
  const now = () => clock().getTime();
  const iso = (ms = now()) => new Date(ms).toISOString();
  const nameOf = (u: Pick<UserRow, 'display_name' | 'community_handle'> | undefined) => u?.display_name ?? u?.community_handle ?? 'A member';
  const areaAt = (lat: number, lng: number) => {
    const r = registry.resolve(lat, lng);
    return r.neighbourhood?.name ?? r.district?.name ?? null;
  };
  let dispatching: Promise<{ sent: number; failed: number; retried: number }> | null = null;

  // ─── Views ──────────────────────────────────────────────────────────────────

  function deliveryView(d: DeliveryRow): SosDelivery {
    return {
      channel: d.channel,
      purpose: d.purpose,
      status: d.status,
      attempts: d.attempts,
      maxAttempts: d.max_attempts,
      lastError: d.last_error,
      nextAttemptAt: d.status === 'pending' ? d.next_attempt_at : null,
      devAdapter: d.dev_adapter === 1,
      updatedAt: d.updated_at,
      confirmedAt: d.delivered_at,
    };
  }

  function locationFor(e: SosEventRow, level: SosSettings['locationDetail'] | 'owner'): SosEvent['location'] {
    if (e.location_sharing !== 1 || !e.location_recorded_at || level === 'none') return null;
    const exact = level === 'owner' || level === 'precise';
    return {
      areaName: e.area_name,
      lat: exact ? e.lat : null,
      lng: exact ? e.lng : null,
      accuracyM: exact ? e.accuracy_m : null,
      recordedAt: e.location_recorded_at,
      source: e.location_source ?? 'device',
    };
  }

  function ownerView(e: SosEventRow): SosEvent {
    const deliveries = repo.deliveries(e.id);
    const acks = new Map(repo.acknowledgements(e.id).map((a) => [a.recipient_id, a]));
    const recipients = repo.recipients(e.id).map((r) => {
      const ds = deliveries.filter((d) => d.recipient_id === r.id && d.channel !== 'circle_chat');
      const ack = acks.get(r.id);
      return {
        id: r.id,
        kind: r.kind,
        name: r.name,
        locationLevel: r.location_level,
        deliveries: ds.map(deliveryView),
        acknowledgement: ack ? { response: ack.response, at: ack.acknowledged_at } : null,
      };
    });
    const reached = (ds: SosDelivery[]) => ds.some((d) => ['accepted', 'delivered', 'pending', 'sending'].includes(d.status));
    return {
      id: e.id,
      demo: e.is_demo === 1,
      status: e.status,
      activatedAt: e.activated_at,
      endedAt: e.ended_at,
      outcome: e.outcome,
      tripId: e.trip_id,
      note: e.note,
      locationDetail: e.location_detail,
      locationSharing: e.location_sharing === 1,
      location: locationFor(e, 'owner'),
      escalation: { contactsPolicy: e.contacts_policy, stage: e.escalation_stage, nextAt: e.next_escalation_at },
      circleChat: deliveries.filter((d) => d.channel === 'circle_chat').map(deliveryView),
      recipients,
      summary: {
        recipients: recipients.length,
        confirmed: recipients.filter((r) => r.deliveries.some((d) => d.status === 'delivered')).length,
        acknowledged: recipients.filter((r) => r.acknowledgement).length,
        unreached: recipients.filter((r) => !reached(r.deliveries) && r.deliveries.some((d) => d.status === 'failed' || d.status === 'unavailable')).length,
      },
    };
  }

  function receivedView(e: SosEventRow, me: SosRecipientRow): ReceivedSos {
    const byId = new Map(repo.recipients(e.id).map((r) => [r.id, r]));
    const acks = repo.acknowledgements(e.id);
    return {
      id: e.id,
      demo: e.is_demo === 1,
      status: e.status,
      travellerName: nameOf(users.findById(e.user_id)),
      activatedAt: e.activated_at,
      endedAt: e.ended_at,
      outcome: e.outcome,
      note: e.note,
      locationLevel: me.location_level,
      // Nothing location-related once the SOS has ended.
      location: e.status === 'ACTIVE' ? locationFor(e, me.location_level) : null,
      myResponse: acks.find((a) => a.recipient_id === me.id)?.response ?? null,
      responses: acks
        .filter((a) => byId.get(a.recipient_id)?.kind === 'guardian')
        .map((a) => ({ name: byId.get(a.recipient_id)!.name, response: a.response, at: a.acknowledged_at })),
    };
  }

  function ownEvent(user: UserRow, id: string): SosEventRow {
    const e = repo.event(id);
    if (!e || e.user_id !== user.id) throw notFound('SOS');
    return e;
  }

  // ─── Delivery ───────────────────────────────────────────────────────────────

  /** Builds the message for a delivery from the event's state at send time (so it carries the latest location). */
  function messageFor(d: DeliveryRow, e: SosEventRow, r: SosRecipientRow | undefined): { text: string; status: SosEventRow['status'] } {
    const who = nameOf(users.findById(e.user_id));
    const since = timeIst(e.activated_at);
    const level = r?.location_level ?? e.location_detail;
    const area = e.location_sharing === 1 && level !== 'none' && e.area_name ? ` Last known area: ${e.area_name}.` : '';
    if (d.purpose === 'ended') {
      // SMS recipients are outside the app, so say where the message comes from.
      const from = d.channel === 'sms' ? 'mahilaSathi: ' : '';
      return { text: `${from}${who} ended the SOS: ${e.outcome === 'false_alarm' ? 'it was a false alarm' : 'they are safe now'}.`, status: e.status };
    }
    if (d.purpose === 'update' && r) {
      const ack = repo.acknowledgements(e.id).find((a) => a.recipient_id === r.id);
      return { text: `${r.name} ${RESPONSE_TEXT[ack?.response ?? 'seen']} (SOS from ${who}).`, status: e.status };
    }
    if (d.channel === 'sms') {
      // Only the location detail the sender allowed. A map link is included at "precise" only.
      const link =
        e.location_sharing === 1 && level === 'precise' && e.lat !== null && e.lng !== null
          ? ` Location: https://www.openstreetmap.org/?mlat=${e.lat.toFixed(5)}&mlon=${e.lng.toFixed(5)}#map=17/${e.lat.toFixed(5)}/${e.lng.toFixed(5)}`
          : '';
      const prefix = d.purpose === 'escalation' ? 'mahilaSathi SOS (no response yet)' : 'mahilaSathi SOS';
      return { text: `${prefix}: ${who} needs help, since ${since} IST.${area}${link} Please call them now. In an emergency, call 112.`, status: e.status };
    }
    if (d.purpose === 'escalation') {
      return { text: `No one has responded yet to ${who}'s SOS (since ${since}).${area} Please open mahilaSathi and respond. If you think they are in immediate danger, call 112.`, status: e.status };
    }
    // Circle chat alert: never coordinates. Guardians open the app for location.
    return { text: `SOS from ${who} at ${since}.${area} Open mahilaSathi to see details and respond. If you think they are in immediate danger, call 112.`, status: e.status };
  }

  async function send(d: DeliveryRow, e: SosEventRow, r: SosRecipientRow | undefined): Promise<{ providerMessageId: string; devAdapter: boolean }> {
    const built = messageFor(d, e, r);
    // Demo SOS events must never be mistaken for a real emergency.
    const text = e.is_demo === 1 ? `DEMO, not a real emergency. ${built.text}` : built.text;
    const status = built.status;
    if (d.channel === 'circle_chat') {
      const circle = circles.byOwner(e.user_id);
      if (!circle) throw new PermanentDeliveryError('There is no Guardian Circle to post to');
      try {
        const id = await community.postSystemMessage(circle.channel_id, MS_MESSAGE_TYPES.sosAlert, { sosId: e.id, status, text: text.slice(0, 280) }, status === 'ACTIVE' ? 'SOS alert' : 'SOS update');
        return { providerMessageId: id, devAdapter: false };
      } catch (err) {
        if (err instanceof ChannelUnavailableError) throw new PermanentDeliveryError('The circle chat is no longer available');
        throw new Error('The chat service did not accept the message');
      }
    }
    if (d.channel === 'sms') {
      if (!r?.phone_e164) throw new PermanentDeliveryError('No phone number for this contact');
      try {
        const res = await sms.send(r.phone_e164, text);
        return { providerMessageId: res.providerMessageId, devAdapter: sms.mode === 'dev-adapter' };
      } catch (err) {
        if (err instanceof SmsPermanentError) throw new PermanentDeliveryError(err.message);
        throw new Error('The SMS provider did not accept the message');
      }
    }
    throw new PermanentDeliveryError('In-app alerts are not sent by the worker');
  }

  async function runDelivery(d: DeliveryRow): Promise<'sent' | 'failed' | 'retried' | 'skipped' | 'lost'> {
    const e = repo.event(d.sos_id);
    const at = now();
    if (!e) return 'lost';
    if (e.status !== 'ACTIVE' && d.purpose !== 'ended') {
      repo.finishDelivery(d.id, { status: 'skipped', next_attempt_at: null, last_error: 'The SOS ended before this was sent' }, iso(at));
      return 'skipped';
    }
    if (!repo.claim(d, iso(at), iso(at + SOS_POLICY.leaseMs))) return 'lost';
    const attemptNo = d.attempts + 1;
    const attemptId = repo.startAttempt(d.id, attemptNo, iso(at));
    const r = d.recipient_id ? repo.recipient(d.recipient_id) : undefined;
    try {
      const res = await send(d, e, r);
      const done = iso();
      repo.finishDelivery(d.id, { status: 'accepted', accepted_at: done, provider_message_id: res.providerMessageId, dev_adapter: res.devAdapter ? 1 : 0, last_error: null, next_attempt_at: null }, done);
      repo.finishAttempt(attemptId, 'accepted', null, done);
      return 'sent';
    } catch (err) {
      const done = iso();
      const permanent = err instanceof PermanentDeliveryError;
      const message = err instanceof Error ? err.message : 'Unknown error';
      if (permanent || attemptNo >= d.max_attempts) {
        repo.finishDelivery(d.id, { status: 'failed', last_error: permanent ? message : `${message} (gave up after ${attemptNo} tries)`, next_attempt_at: null }, done);
        repo.finishAttempt(attemptId, permanent ? 'permanent_error' : 'retryable_error', message, done);
        audit.record({ actorType: 'system', action: 'sos.delivery_failed', targetType: 'sos', targetId: e.id, metadata: { channel: d.channel, purpose: d.purpose, attempts: attemptNo, permanent } });
        logger.warn({ sosId: e.id, channel: d.channel, attempts: attemptNo }, 'SOS delivery failed');
        return 'failed';
      }
      const wait = SOS_POLICY.backoffMs[Math.min(attemptNo - 1, SOS_POLICY.backoffMs.length - 1)]!;
      repo.finishDelivery(d.id, { status: 'pending', last_error: message, next_attempt_at: iso(now() + wait) }, done);
      repo.finishAttempt(attemptId, 'retryable_error', message, done);
      return 'retried';
    }
  }

  async function dispatchOnce(): Promise<{ sent: number; failed: number; retried: number }> {
    const counts = { sent: 0, failed: 0, retried: 0 };
    for (const d of repo.dueDeliveries(iso())) {
      const out = await runDelivery(d);
      if (out === 'sent' || out === 'failed' || out === 'retried') counts[out]++;
    }
    return counts;
  }

  /** Runs due jobs. Concurrent calls share one run, so a kick after activation never double-sends. */
  function dispatchDue(): Promise<{ sent: number; failed: number; retried: number }> {
    dispatching ??= dispatchOnce().finally(() => {
      dispatching = null;
    });
    return dispatching;
  }

  const kick = () => {
    void dispatchDue().catch((err: unknown) => logger.error({ err }, 'SOS dispatch failed'));
  };

  /** A queued SMS, or an "unavailable" record when SMS is not set up (never a pretend send). */
  function smsDelivery(sosId: string, recipientId: string, purpose: DeliveryRow['purpose'], created: string) {
    const disabled = sms.mode === 'disabled';
    return {
      sos_id: sosId,
      recipient_id: recipientId,
      channel: 'sms' as const,
      purpose,
      status: disabled ? ('unavailable' as const) : ('pending' as const),
      max_attempts: SOS_POLICY.maxAttempts,
      next_attempt_at: disabled ? null : created,
      dev_adapter: sms.mode === 'dev-adapter' ? 1 : 0,
      accepted_at: null,
      created_at: created,
    };
  }

  function insertSms(sosId: string, recipientId: string, purpose: DeliveryRow['purpose'], created: string): void {
    const id = repo.insertDelivery(smsDelivery(sosId, recipientId, purpose, created));
    if (sms.mode === 'disabled') repo.finishDelivery(id, { last_error: 'SMS is not set up on this server, so nothing was sent' }, created);
  }

  return {
    smsMode: sms.mode,
    settings: (user: UserRow) => repo.settings(user.id),
    updateSettings(user: UserRow, patch: Partial<SosSettings>): SosSettings {
      const next = { ...repo.settings(user.id), ...patch };
      repo.saveSettings(user.id, next, iso());
      audit.record({ actorType: 'user', actorId: user.id, action: 'sos.settings_updated', targetType: 'user', targetId: user.id, metadata: next });
      return next;
    },

    /**
     * Raises an SOS. Idempotent twice over: the same idempotency key returns the same SOS, and while one is
     * active any new activation returns it instead of creating a duplicate incident.
     */
    activate(user: UserRow, input: { idempotencyKey: string; location?: { lat: number; lng: number; accuracyM?: number | undefined } | undefined; note?: string | undefined }): { event: SosEvent; created: boolean } {
      const existing = repo.byIdempotencyKey(user.id, input.idempotencyKey) ?? repo.activeFor(user.id);
      if (existing) {
        audit.record({ actorType: 'user', actorId: user.id, action: 'sos.duplicate_activation', targetType: 'sos', targetId: existing.id });
        return { event: ownerView(existing), created: false };
      }
      const settings = repo.settings(user.id);
      const at = now();
      const created = iso(at);
      const trip = trips.openTripForUser(user.id);
      const underway = trip && ['ACTIVE', 'DELAYED', 'ESCALATED'].includes(trip.status) ? trip : undefined;

      // Location: only what the user's SOS setting allows. Device point first, else the journey's latest shared point.
      let loc: { lat: number; lng: number; accuracy: number | null; at: string; source: 'device' | 'journey' } | null = null;
      if (settings.locationDetail !== 'none') {
        if (input.location) loc = { lat: input.location.lat, lng: input.location.lng, accuracy: input.location.accuracyM ?? null, at: created, source: 'device' };
        else if (underway?.location_sharing === 1) {
          const last = trips.latestLocation(underway.id);
          if (last) loc = { lat: last.lat, lng: last.lng, accuracy: last.accuracy_m, at: last.recorded_at, source: 'journey' };
        }
      }

      const sosId = crypto.randomUUID();
      const circle = circles.byOwner(user.id);
      const guardians = circle ? circles.activeMembers(circle.id).filter((m) => m.role === 'guardian') : [];
      const contactList = settings.emergencyContacts === 'never' ? [] : contacts.list(user.id);
      const recipients: SosRecipientRow[] = [
        ...guardians.map((g) => ({ id: crypto.randomUUID(), sos_id: sosId, kind: 'guardian' as const, user_id: g.user_id, contact_id: null, name: g.display_name ?? g.community_handle, phone_e164: null, location_level: settings.locationDetail, created_at: created })),
        ...contactList.map((c) => ({ id: crypto.randomUUID(), sos_id: sosId, kind: 'emergency_contact' as const, user_id: null, contact_id: c.id, name: c.name, phone_e164: c.phone, location_level: settings.locationDetail, created_at: created })),
      ];
      // Contacts are messaged now if the user chose "immediately", or if no guardian exists who could respond.
      const contactsNow = settings.emergencyContacts === 'immediately' || (settings.emergencyContacts === 'if_unacknowledged' && guardians.length === 0);
      const event: SosEventRow = {
        id: sosId,
        user_id: user.id,
        idempotency_key: input.idempotencyKey,
        trip_id: underway?.id ?? null,
        status: 'ACTIVE',
        outcome: null,
        note: input.note ?? null,
        location_detail: settings.locationDetail,
        contacts_policy: settings.emergencyContacts,
        escalate_after_minutes: settings.escalateAfterMinutes,
        location_sharing: settings.locationDetail === 'none' ? 0 : 1,
        lat: loc?.lat ?? null,
        lng: loc?.lng ?? null,
        accuracy_m: loc?.accuracy ?? null,
        location_recorded_at: loc?.at ?? null,
        location_source: loc?.source ?? null,
        area_name: loc ? areaAt(loc.lat, loc.lng) : null,
        escalation_stage: 0,
        next_escalation_at: guardians.length > 0 ? iso(at + settings.escalateAfterMinutes * MIN) : null,
        activated_at: created,
        ended_at: null,
        updated_at: created,
        is_demo: user.is_demo === 1 || (deps.demoMode && !user.google_sub) ? 1 : 0,
      };
      const deliveries = [
        // In-app: available at once; "delivered" only when the guardian's app loads it.
        ...recipients
          .filter((r) => r.kind === 'guardian')
          .map((r) => ({ sos_id: sosId, recipient_id: r.id, channel: 'in_app' as const, purpose: 'alert' as const, status: 'accepted' as const, max_attempts: 1, next_attempt_at: null, dev_adapter: 0, accepted_at: created, created_at: created })),
        ...(guardians.length > 0
          ? [{ sos_id: sosId, recipient_id: null, channel: 'circle_chat' as const, purpose: 'alert' as const, status: 'pending' as const, max_attempts: SOS_POLICY.maxAttempts, next_attempt_at: created, dev_adapter: 0, accepted_at: null, created_at: created }]
          : []),
        ...(contactsNow ? recipients.filter((r) => r.kind === 'emergency_contact').map((r) => smsDelivery(sosId, r.id, 'alert', created)) : []),
      ];
      try {
        repo.createEvent(event, recipients, deliveries);
      } catch (err) {
        // A concurrent activation won the race (unique key / one-active index): return that one.
        const winner = repo.byIdempotencyKey(user.id, input.idempotencyKey) ?? repo.activeFor(user.id);
        if (winner) return { event: ownerView(winner), created: false };
        throw err;
      }
      if (sms.mode === 'disabled') {
        for (const d of repo.deliveries(sosId).filter((x) => x.status === 'unavailable')) repo.finishDelivery(d.id, { last_error: 'SMS is not set up on this server, so nothing was sent' }, created);
      }
      audit.record({
        actorType: 'user',
        actorId: user.id,
        action: 'sos.activated',
        targetType: 'sos',
        targetId: sosId,
        metadata: { guardians: guardians.length, emergencyContacts: contactList.length, contactsNow, locationDetail: settings.locationDetail, hasLocation: loc !== null, duringJourney: Boolean(underway) },
      });
      logger.warn({ sosId }, 'SOS activated');
      pushGuardians(repo.event(sosId)!, guardianIds(sosId), `SOS from ${nameOf(user)}`, 'Tap to see where they are and respond. If they are in immediate danger, call 112.', true);
      kick();
      return { event: ownerView(repo.event(sosId)!), created: true };
    },

    get(user: UserRow, id: string): { kind: 'owner'; event: SosEvent } | { kind: 'recipient'; event: ReceivedSos } {
      const e = repo.event(id);
      if (e && e.user_id === user.id) return { kind: 'owner', event: ownerView(e) };
      const me = e ? repo.recipientForUser(e.id, user.id) : undefined;
      if (!e || !me || (e.ended_at && now() - Date.parse(e.ended_at) > SOS_POLICY.guardianViewAfterEndMs)) throw notFound('SOS');
      repo.markInAppDelivered(e.id, me.id, iso());
      return { kind: 'recipient', event: receivedView(e, me) };
    },
    active(user: UserRow): SosEvent | null {
      const e = repo.activeFor(user.id);
      return e ? ownerView(e) : null;
    },
    history: (user: UserRow): SosEvent[] => repo.historyFor(user.id, 10).map(ownerView),

    /** SOS alerts this user received as a guardian. Loading them is what confirms in-app delivery. */
    received(user: UserRow): ReceivedSos[] {
      const out: ReceivedSos[] = [];
      for (const e of repo.receivedBy(user.id, iso(now() - SOS_POLICY.guardianViewAfterEndMs))) {
        const me = repo.recipientForUser(e.id, user.id);
        if (!me) continue;
        if (e.status === 'ACTIVE') repo.markInAppDelivered(e.id, me.id, iso());
        out.push(receivedView(e, me));
      }
      return out;
    },

    acknowledge(user: UserRow, id: string, response: 'seen' | 'calling' | 'on_my_way'): ReceivedSos {
      const e = repo.event(id);
      const me = e ? repo.recipientForUser(e.id, user.id) : undefined;
      if (!e || !me) throw notFound('SOS');
      if (e.status !== 'ACTIVE') throw new AppError('CONFLICT', 'This SOS has already ended.');
      const first = !repo.acknowledgements(e.id).some((a) => a.recipient_id === me.id);
      repo.acknowledge(e.id, me.id, response, iso());
      repo.markInAppDelivered(e.id, me.id, iso());
      if (first) {
        // Let the rest of the circle know someone is responding.
        repo.insertDelivery({ sos_id: e.id, recipient_id: me.id, channel: 'circle_chat', purpose: 'update', status: 'pending', max_attempts: SOS_POLICY.maxAttempts, next_attempt_at: iso(), dev_adapter: 0, accepted_at: null, created_at: iso() });
        kick();
      }
      audit.record({ actorType: 'user', actorId: user.id, action: 'sos.acknowledged', targetType: 'sos', targetId: e.id, metadata: { response } });
      return receivedView(repo.event(e.id)!, me);
    },

    /** Ends the SOS ("I'm safe now" or "false alarm") and tells everyone who was reached. */
    end(user: UserRow, id: string, outcome: 'safe' | 'false_alarm'): SosEvent {
      const e = ownEvent(user, id);
      if (!repo.end(e.id, outcome === 'safe' ? 'RESOLVED' : 'CANCELLED', outcome, iso())) throw new AppError('CONFLICT', 'This SOS has already ended.');
      repo.skipPending(e.id, iso());
      const reached = repo.deliveries(e.id).filter((d) => (d.status === 'accepted' || d.status === 'delivered') && (d.purpose === 'alert' || d.purpose === 'escalation'));
      const created = iso();
      if (reached.some((d) => d.channel === 'circle_chat')) {
        repo.insertDelivery({ sos_id: e.id, recipient_id: null, channel: 'circle_chat', purpose: 'ended', status: 'pending', max_attempts: SOS_POLICY.maxAttempts, next_attempt_at: created, dev_adapter: 0, accepted_at: null, created_at: created });
      }
      for (const rid of new Set(reached.filter((d) => d.channel === 'sms').map((d) => d.recipient_id!))) insertSms(e.id, rid, 'ended', created);
      audit.record({ actorType: 'user', actorId: user.id, action: 'sos.ended', targetType: 'sos', targetId: e.id, metadata: { outcome } });
      pushGuardians(e, guardianIds(e.id), `${nameOf(user)} ended the SOS`, outcome === 'safe' ? 'They are safe now.' : 'It was a false alarm.', false);
      kick();
      return ownerView(repo.event(e.id)!);
    },

    updateLocation(user: UserRow, id: string, p: { lat: number; lng: number; accuracyM?: number | undefined }): { stored: boolean } {
      const e = ownEvent(user, id);
      if (e.status !== 'ACTIVE') throw new AppError('CONFLICT', 'This SOS has already ended.');
      if (e.location_detail === 'none' || e.location_sharing !== 1) throw new AppError('CONFLICT', 'Location sharing is off for this SOS.');
      if (e.location_recorded_at && e.location_source === 'device' && now() - Date.parse(e.location_recorded_at) < SOS_POLICY.locationMinIntervalMs) return { stored: false };
      repo.update(e.id, { lat: p.lat, lng: p.lng, accuracy_m: p.accuracyM ?? null, location_recorded_at: iso(), location_source: 'device', area_name: areaAt(p.lat, p.lng) }, iso());
      return { stored: true };
    },

    /** Immediate stop: clears the stored point at once. Can be turned back on while the SOS is active. */
    setLocationSharing(user: UserRow, id: string, enabled: boolean): SosEvent {
      const e = ownEvent(user, id);
      if (e.status !== 'ACTIVE') throw new AppError('CONFLICT', 'This SOS has already ended.');
      if (enabled && e.location_detail === 'none') throw new AppError('VALIDATION_FAILED', 'Your SOS settings share no location. Change them in Profile first.');
      repo.update(e.id, enabled ? { location_sharing: 1 } : { location_sharing: 0, lat: null, lng: null, accuracy_m: null, location_recorded_at: null, location_source: null, area_name: null }, iso());
      audit.record({ actorType: 'user', actorId: user.id, action: enabled ? 'sos.location_sharing_on' : 'sos.location_sharing_off', targetType: 'sos', targetId: e.id });
      return ownerView(repo.event(e.id)!);
    },

    /** Stops location on the active SOS, if any (used by the global "stop sharing my location" control). */
    stopLocation(userId: string): number {
      const e = repo.activeFor(userId);
      if (!e || e.location_sharing !== 1) return 0;
      repo.update(e.id, { location_sharing: 0, lat: null, lng: null, accuracy_m: null, location_recorded_at: null, location_source: null, area_name: null }, iso());
      audit.record({ actorType: 'user', actorId: userId, action: 'sos.location_sharing_off', targetType: 'sos', targetId: e.id });
      return 1;
    },

    // ─── Worker ───────────────────────────────────────────────────────────────

    dispatchDue,

    /**
     * Escalation rule: if no guardian has responded within the user's chosen minutes, remind the circle
     * and (with "if_unacknowledged") message emergency contacts. Driven by the database, not a browser timer.
     */
    async escalateDue(): Promise<{ escalated: number; notNeeded: number }> {
      let escalated = 0;
      let notNeeded = 0;
      for (const e of repo.dueEscalations(iso())) {
        if (!repo.markEscalated(e.id, iso())) continue;
        if (repo.ackCount(e.id) > 0) {
          notNeeded++;
          audit.record({ actorType: 'system', action: 'sos.escalation_not_needed', targetType: 'sos', targetId: e.id });
          continue;
        }
        const created = iso();
        repo.insertDelivery({ sos_id: e.id, recipient_id: null, channel: 'circle_chat', purpose: 'escalation', status: 'pending', max_attempts: SOS_POLICY.maxAttempts, next_attempt_at: created, dev_adapter: 0, accepted_at: null, created_at: created });
        if (e.contacts_policy === 'if_unacknowledged') {
          for (const r of repo.recipients(e.id).filter((x) => x.kind === 'emergency_contact')) insertSms(e.id, r.id, 'escalation', created);
        }
        escalated++;
        const acked = new Set(repo.acknowledgements(e.id).map((a) => a.recipient_id));
        const waiting = repo.recipients(e.id).filter((r) => r.kind === 'guardian' && r.user_id && !acked.has(r.id)).map((r) => r.user_id!);
        pushGuardians(e, waiting, `No one has responded to ${nameOf(users.findById(e.user_id))}'s SOS`, 'Please open mahilaSathi and respond now.', true);
        audit.record({ actorType: 'system', action: 'sos.escalated', targetType: 'sos', targetId: e.id, metadata: { contactsPolicy: e.contacts_policy } });
      }
      if (escalated > 0) await dispatchDue();
      return { escalated, notNeeded };
    },

    purge(): { sosCoordinates: number; devSms: number } {
      return repo.purge(iso(now() - SOS_POLICY.coordinateRetentionMs), iso(now() - SOS_POLICY.devSmsRetentionMs));
    },

    attemptLog: (deliveryId: string) => repo.attemptLog(deliveryId),

    /** Only meaningful with the development SMS adapter, which records instead of sending. */
    devOutbox: () => (sms.mode === 'dev-adapter' ? repo.devOutbox(50).map((r) => ({ id: r.id, to: r.to_e164, body: r.body, recordedAt: r.created_at })) : null),
  };
}

export type SosService = ReturnType<typeof createSosService>;
