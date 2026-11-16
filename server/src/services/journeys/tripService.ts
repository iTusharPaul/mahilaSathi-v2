import crypto from 'node:crypto';
import type { Logger } from 'pino';
import {
  MS_MESSAGE_TYPES,
  TERMINAL_STATUSES,
  TRIP_TRANSITIONS,
  canTransition,
  type LngLat,
  type ShareLevel,
  type SharedTrip,
  type Trip,
  type TripStatus,
} from '@mahilasathi/shared';
import type { AuditRepository } from '../../repositories/auditRepository.js';
import type { CircleRepository } from '../../repositories/circleRepository.js';
import type { ShareRow, TripRepository, TripRow } from '../../repositories/tripRepository.js';
import type { UserRepository, UserRow } from '../../repositories/userRepository.js';
import { AppError, notFound } from '../../utils/errors.js';
import type { Clock } from '../../utils/crypto.js';
import type { CommunityService } from '../community/communityService.js';
import type { GeoRegistry } from '../geography/geoRegistry.js';
import type { PulseService } from '../pulse/pulseService.js';
import type { RoutePlanningService } from '../routing/routePlanningService.js';
import { RouteLine } from '../scoring/routeGeometry.js';
import { PRIVACY_TRIM_M, corridorCells } from './corridor.js';
import type { PushService } from '../push/pushService.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

export const JOURNEY_TIMING = {
  /** Check-ins are due at most every 15 minutes, or halfway through a short journey (never under 2 min). */
  checkinMaxMs: 15 * MIN,
  checkinMinMs: 2 * MIN,
  /** A journey becomes DELAYED after its expected arrival plus max(10 min, 25% of the planned duration). */
  delayGraceMinMs: 10 * MIN,
  delayGraceFraction: 0.25,
  /** "I'm OK, still going" from DELAYED pushes the expected arrival back this much. */
  delayExtensionMs: 15 * MIN,
  /** A journey never started is cancelled this long after its departure time. */
  createdExpiryMs: 2 * HOUR,
  /** Guardians keep seeing an ended journey's final status for this long. */
  guardianAfterEndMs: 12 * HOUR,
  /** Retention: live points 24 h after the journey ends; exact endpoints and labels 30 days after. */
  locationRetentionMs: 24 * HOUR,
  coordinateRetentionMs: 30 * 24 * HOUR,
  /** Location updates closer together than this are ignored (the client posts at most every ~30 s). */
  locationMinIntervalMs: 10_000,
} as const;

const OPEN: TripStatus[] = ['CREATED', 'ACTIVE', 'DELAYED', 'ESCALATED'];
const UNDERWAY: TripStatus[] = ['ACTIVE', 'DELAYED', 'ESCALATED'];

const timeIst = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });

type EndListener = (trip: TripRow) => void | Promise<void>;

export function createTripService(deps: {
  trips: TripRepository;
  circles: CircleRepository;
  users: UserRepository;
  planning: RoutePlanningService;
  pulse: PulseService;
  community: CommunityService;
  registry: GeoRegistry;
  audit: AuditRepository;
  clock: Clock;
  logger: Logger;
  push?: PushService;
  /** Public demo server: prefix every journey update with [Demo]. */
  demoMode?: boolean;
}) {
  const { trips, circles, users, planning, pulse, community, registry, audit, clock, logger } = deps;
  const now = () => clock().getTime();
  const iso = (ms = now()) => new Date(ms).toISOString();
  const endListeners: EndListener[] = [];

  const nameOf = (u: Pick<UserRow, 'display_name' | 'community_handle'> | undefined) => u?.display_name ?? u?.community_handle ?? 'A member';
  const checkinInterval = (durationS: number) =>
    Math.max(JOURNEY_TIMING.checkinMinMs, Math.min(JOURNEY_TIMING.checkinMaxMs, (durationS * 1000) / 2));
  const delayGrace = (durationS: number) => Math.max(JOURNEY_TIMING.delayGraceMinMs, durationS * 1000 * JOURNEY_TIMING.delayGraceFraction);
  const areaAt = (lat: number, lng: number) => {
    const r = registry.resolve(lat, lng);
    return r.neighbourhood?.name ?? r.district?.name ?? null;
  };

  function ownTrip(user: UserRow, tripId: string): TripRow {
    const t = trips.trip(tripId);
    // Not found rather than forbidden: other people's journey ids are not confirmed to exist.
    if (!t || t.user_id !== user.id) throw notFound('Journey');
    return t;
  }

  function requireStatus(t: TripRow, allowed: TripStatus[], message: string): void {
    if (!allowed.includes(t.status)) throw new AppError('CONFLICT', message);
  }

  function routeSummary(tripId: string) {
    const r = trips.route(tripId)!;
    return { label: r.label, distanceM: r.distance_m, durationS: r.duration_s, score: r.score, confidence: r.confidence, geometry: JSON.parse(r.geometry_json) as LngLat[] };
  }

  function view(t: TripRow): Trip {
    return {
      id: t.id,
      status: t.status,
      mode: t.mode,
      originLabel: t.origin_label,
      destinationLabel: t.destination_label,
      route: routeSummary(t.id),
      departureTime: t.departure_time,
      startedAt: t.started_at,
      expectedArrivalAt: t.expected_arrival_at,
      arrivedAt: t.arrived_at,
      endedAt: t.ended_at,
      lastCheckinAt: t.last_checkin_at,
      nextCheckinDueAt: t.next_checkin_due_at,
      locationSharing: t.location_sharing === 1,
      allowedTransitions: TRIP_TRANSITIONS[t.status].filter((s) => s !== 'DELAYED'),
      shares: trips.sharesForTrip(t.id).map((s) => ({
        id: s.id,
        circleName: circles.byId(s.circle_id)?.name ?? 'Guardian Circle',
        level: s.level,
        active: s.revoked_at === null,
        acknowledgedBy: trips.acknowledgedBy(s.id),
      })),
      createdAt: t.created_at,
    };
  }

  /** Posts MS:JourneyStatus into every Guardian Circle the journey is actively shared with. */
  async function notifyCircles(t: TripRow, rawText: string): Promise<void> {
    const text = deps.demoMode || users.findById(t.user_id)?.is_demo === 1 ? `[Demo] ${rawText}` : rawText;
    for (const s of trips.sharesForTrip(t.id).filter((x) => x.revoked_at === null)) {
      const circle = circles.byId(s.circle_id);
      if (!circle) continue;
      await community.sendSystemMessage(
        circle.channel_id,
        MS_MESSAGE_TYPES.journeyStatus,
        { tripId: t.id, status: t.status, text: text.slice(0, 280) },
        'Journey update',
      );
      if (deps.push) {
        const guardians = circles.activeMembers(circle.id).filter((m) => m.role === 'guardian' && m.user_id !== t.user_id).map((m) => m.user_id);
        void deps.push.notify(guardians, 'journey', { title: 'Journey update', body: text.slice(0, 180), url: `/journeys/shared/${s.id}`, tag: `trip-${t.id}`, urgent: t.status === 'DELAYED' || t.status === 'ESCALATED' });
      }
    }
  }

  async function fireEnded(t: TripRow): Promise<void> {
    for (const fn of endListeners) {
      try {
        await fn(t);
      } catch (err) {
        logger.warn({ what: 'trip end listener', reason: (err as Error).message }, 'journey end hook failed');
      }
    }
  }

  function defaultShareLevel(user: UserRow): ShareLevel | null {
    const pref = users.getPreferences(user.id).locationSharingDefault;
    return pref === 'guardians_precise' ? 'precise' : pref === 'guardians_approximate' ? 'approximate' : null;
  }

  /** Applies a validated transition and its side effects. `actor` is null for scheduled (system) changes. */
  async function applyTransition(t: TripRow, to: TripStatus, actor: UserRow | null, opts: { feedback?: 'comfortable' | 'uneasy' } = {}): Promise<TripRow> {
    if (!canTransition(t.status, to)) throw new AppError('CONFLICT', `A journey that is ${t.status.toLowerCase()} cannot become ${to.toLowerCase()}.`);
    const at = now();
    const nowIso = iso(at);
    const fields: Partial<TripRow> & { status: TripStatus } = { status: to };
    const dur = t.expected_duration_s;
    if (to === 'ACTIVE' && t.status === 'CREATED') {
      Object.assign(fields, {
        started_at: nowIso,
        expected_arrival_at: iso(at + dur * 1000),
        last_checkin_at: nowIso,
        next_checkin_due_at: iso(at + checkinInterval(dur)),
      });
    } else if (to === 'ACTIVE') {
      // DELAYED → ACTIVE: the traveller confirmed they are fine and still on the way.
      const base = Math.max(at, Date.parse(t.expected_arrival_at ?? nowIso));
      Object.assign(fields, { expected_arrival_at: iso(base + JOURNEY_TIMING.delayExtensionMs), last_checkin_at: nowIso, next_checkin_due_at: iso(at + checkinInterval(dur)) });
    } else if (to === 'DELAYED') {
      fields.delayed_at = nowIso;
    } else if (to === 'ESCALATED') {
      fields.escalated_at = nowIso;
    } else {
      // ARRIVED / CANCELLED end the journey: live location stops immediately.
      Object.assign(fields, { ended_at: nowIso, next_checkin_due_at: null, location_sharing: 0 });
      if (to === 'ARRIVED') Object.assign(fields, { arrived_at: nowIso, feedback: opts.feedback ?? null, last_checkin_at: nowIso });
    }
    if (!trips.transition(t.id, t.status, fields, nowIso)) throw new AppError('CONFLICT', 'This journey was just updated. Please refresh.');
    if (to === 'ACTIVE' && t.status === 'CREATED') trips.insertCheckin(t.id, 'start', null, nowIso);
    if (to === 'ARRIVED') trips.insertCheckin(t.id, 'arrival', null, nowIso);
    audit.record({
      actorType: actor ? 'user' : 'system',
      ...(actor ? { actorId: actor.id } : {}),
      action: 'journey.status_changed',
      targetType: 'trip',
      targetId: t.id,
      metadata: { from: t.status, to },
    });

    const updated = trips.trip(t.id)!;
    const owner = actor ?? users.findById(t.user_id);
    const who = nameOf(owner);
    const dest = updated.destination_area ? ` to ${updated.destination_area}` : '';
    const texts: Partial<Record<TripStatus, string>> = {
      ACTIVE:
        t.status === 'CREATED'
          ? `${who} started a journey${dest}. Expected by ${timeIst(updated.expected_arrival_at!)}.`
          : `${who} says they are OK and still on the way. Now expected by ${timeIst(updated.expected_arrival_at!)}.`,
      DELAYED: `${who} has not arrived yet (expected by ${timeIst(t.expected_arrival_at!)}). Please try to reach them.`,
      ESCALATED: `${who} asked the circle for help during their journey${dest}. Please contact them now. If you believe they are in danger, call 112.`,
      ARRIVED: `${who} arrived safely.`,
      CANCELLED: `${who} cancelled their journey.`,
    };
    await notifyCircles(updated, texts[to] ?? `${who}'s journey is now ${to.toLowerCase()}.`);

    if (TERMINAL_STATUSES.includes(to)) {
      if (to === 'ARRIVED' && owner) pulse.journeyCompleted(owner as UserRow, t.id, trips.corridor(t.id), opts.feedback);
      await fireEnded(updated);
    }
    return updated;
  }

  function guardianAccess(viewer: UserRow, shareId: string): { share: ShareRow; trip: TripRow } {
    const share = trips.share(shareId);
    const trip = share ? trips.trip(share.trip_id) : undefined;
    const circle = share ? circles.byId(share.circle_id) : undefined;
    if (!share || !trip || !circle || share.revoked_at || circle.owner_id === viewer.id || trip.user_id === viewer.id || !circles.isActiveMember(circle.id, viewer.id)) {
      throw notFound('Shared journey');
    }
    if (trip.ended_at && now() - Date.parse(trip.ended_at) > JOURNEY_TIMING.guardianAfterEndMs) throw notFound('Shared journey');
    return { share, trip };
  }

  /** Guardian view: detail grows with the share level, and nothing location-related once the journey ends. */
  function guardianView(share: ShareRow, t: TripRow, viewer: UserRow): SharedTrip {
    const ended = t.ended_at !== null;
    const live = !ended && t.location_sharing === 1 && share.level !== 'status' ? trips.latestLocation(t.id) : undefined;
    const route = !ended && share.level === 'precise' ? routeSummary(t.id) : null;
    let progressPct: number | null = null;
    if (live && share.level !== 'status') {
      const line = new RouteLine(routeSummary(t.id).geometry);
      const p = line.project([live.lng, live.lat]);
      // Only meaningful while on (or near) the planned route.
      if (line.length > 0 && p.offsetM < 500) progressPct = Math.round((p.alongM / line.length) * 100);
    }
    return {
      id: t.id,
      shareId: share.id,
      travellerName: nameOf(users.findById(t.user_id)),
      level: share.level,
      status: t.status,
      mode: t.mode,
      destinationArea: t.destination_area,
      startedAt: t.started_at,
      expectedArrivalAt: t.expected_arrival_at,
      arrivedAt: t.arrived_at,
      lastCheckinAt: t.last_checkin_at,
      lastLocation: live
        ? {
            areaName: areaAt(live.lat, live.lng),
            lat: share.level === 'precise' ? live.lat : null,
            lng: share.level === 'precise' ? live.lng : null,
            recordedAt: live.recorded_at,
          }
        : null,
      progressPct,
      route,
      acknowledged: trips.isAcknowledged(share.id, viewer.id),
    };
  }

  return {
    onEnded(fn: EndListener): void {
      endListeners.push(fn);
    },

    async create(user: UserRow, input: { routeId: string; originLabel?: string | undefined; destinationLabel?: string | undefined; shareLevel?: ShareLevel | null | undefined }): Promise<Trip> {
      if (trips.openTripForUser(user.id)) throw new AppError('CONFLICT', 'You already have a journey in progress. Finish or cancel it first.');
      const { plan, route } = planning.planRoute(user, input.routeId);
      const level = input.shareLevel === undefined ? defaultShareLevel(user) : input.shareLevel;
      const circle = circles.byOwner(user.id);
      if (input.shareLevel && !circle) throw new AppError('VALIDATION_FAILED', 'Create a Guardian Circle before sharing a journey.');
      const geometry = route.geometry as LngLat[];
      const [oLng, oLat] = geometry[0]!;
      const [dLng, dLat] = geometry[geometry.length - 1]!;
      const created = iso();
      // Departure is never in the past, so a journey planned earlier is not expired the moment it is created.
      const departure = iso(Math.max(now(), Date.parse(plan.departureTime)));
      const row: TripRow = {
        id: crypto.randomUUID(),
        user_id: user.id,
        status: 'CREATED',
        mode: plan.mode,
        origin_lat: oLat,
        origin_lng: oLng,
        destination_lat: dLat,
        destination_lng: dLng,
        origin_label: input.originLabel ?? plan.origin.label,
        destination_label: input.destinationLabel ?? plan.destination.label,
        destination_area: areaAt(dLat, dLng),
        departure_time: departure,
        expected_duration_s: Math.round(route.durationS),
        started_at: null,
        expected_arrival_at: null,
        delayed_at: null,
        escalated_at: null,
        arrived_at: null,
        ended_at: null,
        last_checkin_at: null,
        next_checkin_due_at: null,
        location_sharing: 0,
        feedback: null,
        created_at: created,
        updated_at: created,
      };
      trips.insertTrip(
        row,
        { trip_id: row.id, plan_route_id: route.id, label: route.label, distance_m: route.distanceM, duration_s: route.durationS, score: route.score, confidence: route.confidence, geometry_json: JSON.stringify(geometry) },
        corridorCells(geometry, PRIVACY_TRIM_M),
      );
      audit.record({ actorType: 'user', actorId: user.id, action: 'journey.created', targetType: 'trip', targetId: row.id, metadata: { mode: row.mode } });
      if (level && circle) {
        trips.upsertShare(row.id, circle.id, level, created);
        audit.record({ actorType: 'user', actorId: user.id, action: 'journey.shared', targetType: 'trip', targetId: row.id, metadata: { level } });
        await notifyCircles(row, `${nameOf(user)} planned a journey${row.destination_area ? ` to ${row.destination_area}` : ''} and shared it with the circle.`);
      }
      return view(trips.trip(row.id)!);
    },

    get: (user: UserRow, tripId: string): Trip => view(ownTrip(user, tripId)),
    active(user: UserRow): Trip | null {
      const t = trips.openTripForUser(user.id);
      return t ? view(t) : null;
    },
    list: (user: UserRow): Trip[] => trips.recentTrips(user.id).map(view),

    async setStatus(user: UserRow, tripId: string, to: 'ACTIVE' | 'ARRIVED' | 'CANCELLED' | 'ESCALATED', feedback?: 'comfortable' | 'uneasy'): Promise<Trip> {
      const t = ownTrip(user, tripId);
      if (feedback && to !== 'ARRIVED') throw new AppError('VALIDATION_FAILED', 'Feedback can only be given on arrival.');
      if (to === 'ESCALATED' && trips.sharesForTrip(t.id).every((s) => s.revoked_at !== null)) {
        throw new AppError('VALIDATION_FAILED', 'Share this journey with your Guardian Circle so they can be alerted. In an emergency, call 112.');
      }
      return view(await applyTransition(t, to, user, feedback ? { feedback } : {}));
    },

    /** "I'm OK": refreshes the check-in timer. From DELAYED it also resumes the journey with more time. */
    async checkin(user: UserRow, tripId: string, note?: string): Promise<Trip> {
      const t = ownTrip(user, tripId);
      requireStatus(t, UNDERWAY, 'Check-ins are only possible during a journey.');
      if (t.status === 'DELAYED') {
        const updated = await applyTransition(t, 'ACTIVE', user);
        trips.insertCheckin(t.id, 'manual', note ?? null, iso());
        return view(updated);
      }
      const at = now();
      trips.update(t.id, { last_checkin_at: iso(at), next_checkin_due_at: iso(at + checkinInterval(t.expected_duration_s)) }, iso(at));
      trips.insertCheckin(t.id, 'manual', note ?? null, iso(at));
      await notifyCircles(t, `${nameOf(user)} checked in: OK.${note ? ` “${note}”` : ''}`);
      return view(trips.trip(t.id)!);
    },

    async share(user: UserRow, tripId: string, level: ShareLevel): Promise<Trip> {
      const t = ownTrip(user, tripId);
      requireStatus(t, OPEN, 'Only journeys that have not ended can be shared.');
      const circle = circles.byOwner(user.id);
      if (!circle) throw new AppError('VALIDATION_FAILED', 'Create a Guardian Circle before sharing a journey.');
      const wasShared = trips.sharesForTrip(t.id).some((s) => s.revoked_at === null);
      trips.upsertShare(t.id, circle.id, level, iso());
      // Lowering the level to status-only stops location sharing.
      if (level === 'status' && t.location_sharing === 1) {
        trips.update(t.id, { location_sharing: 0 }, iso());
        trips.deleteLocations(t.id);
      }
      audit.record({ actorType: 'user', actorId: user.id, action: 'journey.shared', targetType: 'trip', targetId: t.id, metadata: { level } });
      if (!wasShared) await notifyCircles(t, `${nameOf(user)} shared a journey${t.destination_area ? ` to ${t.destination_area}` : ''} with the circle.`);
      return view(trips.trip(t.id)!);
    },

    async unshare(user: UserRow, tripId: string): Promise<Trip> {
      const t = ownTrip(user, tripId);
      await notifyCircles(t, `${nameOf(user)} stopped sharing their journey.`);
      trips.revokeShares(t.id, iso());
      trips.update(t.id, { location_sharing: 0 }, iso());
      trips.deleteLocations(t.id);
      audit.record({ actorType: 'user', actorId: user.id, action: 'journey.unshared', targetType: 'trip', targetId: t.id });
      return view(trips.trip(t.id)!);
    },

    /** Live location is opt-in per journey, needs an approximate or precise share, and ends with the journey. */
    setLocationSharing(user: UserRow, tripId: string, enabled: boolean): Trip {
      const t = ownTrip(user, tripId);
      if (enabled) {
        requireStatus(t, OPEN, 'Location sharing is only possible before or during a journey.');
        if (!trips.sharesForTrip(t.id).some((s) => s.revoked_at === null && s.level !== 'status')) {
          throw new AppError('VALIDATION_FAILED', 'Share this journey with your Guardian Circle at approximate or precise level first.');
        }
      }
      trips.update(t.id, { location_sharing: enabled ? 1 : 0 }, iso());
      if (!enabled) trips.deleteLocations(t.id);
      audit.record({ actorType: 'user', actorId: user.id, action: enabled ? 'journey.location_sharing_on' : 'journey.location_sharing_off', targetType: 'trip', targetId: t.id });
      return view(trips.trip(t.id)!);
    },

    recordLocation(user: UserRow, tripId: string, p: { lat: number; lng: number; accuracyM?: number | undefined }): { stored: boolean } {
      const t = ownTrip(user, tripId);
      requireStatus(t, UNDERWAY, 'Location can only be shared during a journey.');
      if (t.location_sharing !== 1) throw new AppError('CONFLICT', 'Location sharing is off for this journey.');
      const last = trips.latestLocation(t.id);
      if (last && now() - Date.parse(last.recorded_at) < JOURNEY_TIMING.locationMinIntervalMs) return { stored: false };
      trips.insertLocation(t.id, p.lat, p.lng, p.accuracyM ?? null, iso());
      return { stored: true };
    },

    // ─── Guardians ────────────────────────────────────────────────────────────

    sharedWithMe(viewer: UserRow): SharedTrip[] {
      const out: SharedTrip[] = [];
      for (const share of trips.sharesForGuardian(viewer.id)) {
        const t = trips.trip(share.trip_id);
        if (!t || (t.ended_at && now() - Date.parse(t.ended_at) > JOURNEY_TIMING.guardianAfterEndMs)) continue;
        out.push(guardianView(share, t, viewer));
      }
      return out;
    },

    sharedTrip(viewer: UserRow, shareId: string): SharedTrip {
      const { share, trip } = guardianAccess(viewer, shareId);
      return guardianView(share, trip, viewer);
    },

    async acknowledge(viewer: UserRow, shareId: string): Promise<SharedTrip> {
      const { share, trip } = guardianAccess(viewer, shareId);
      if (!trips.isAcknowledged(share.id, viewer.id)) {
        trips.acknowledge(share.id, viewer.id, iso());
        audit.record({ actorType: 'user', actorId: viewer.id, action: 'journey.acknowledged', targetType: 'trip', targetId: trip.id });
        await notifyCircles(trip, `${nameOf(viewer)} is keeping an eye on this journey.`);
      }
      return guardianView(share, trips.trip(trip.id)!, viewer);
    },

    // ─── Schedule ─────────────────────────────────────────────────────────────

    /** Every minute: mark overdue journeys DELAYED (and alert the circle); cancel journeys never started. */
    async tick(): Promise<{ delayed: number; expired: number }> {
      let delayed = 0;
      let expired = 0;
      for (const t of trips.overdueActive(iso())) {
        if (now() <= Date.parse(t.expected_arrival_at!) + delayGrace(t.expected_duration_s)) continue;
        try {
          await applyTransition(t, 'DELAYED', null);
          delayed++;
        } catch (err) {
          if (!(err instanceof AppError)) throw err;
        }
      }
      for (const t of trips.staleCreated(iso(now() - JOURNEY_TIMING.createdExpiryMs))) {
        try {
          await applyTransition(t, 'CANCELLED', null);
          expired++;
        } catch (err) {
          if (!(err instanceof AppError)) throw err;
        }
      }
      return { delayed, expired };
    },

    purge(): { tripLocations: number; tripCoordinates: number } {
      const r = trips.purge(iso(now() - JOURNEY_TIMING.locationRetentionMs), iso(now() - JOURNEY_TIMING.coordinateRetentionMs));
      return { tripLocations: r.locations, tripCoordinates: r.coordinates };
    },
  };
}

export type TripService = ReturnType<typeof createTripService>;
