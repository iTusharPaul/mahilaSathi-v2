import { MS_MESSAGE_TYPES, type WalkMatch } from '@mahilasathi/shared';
import type { AuditRepository } from '../../repositories/auditRepository.js';
import type { SafetyRepository } from '../../repositories/safetyRepository.js';
import type { TripRepository } from '../../repositories/tripRepository.js';
import type { UserRepository, UserRow } from '../../repositories/userRepository.js';
import type { WalkMatchRow, WalkRequestRow, WalkTogetherRepository } from '../../repositories/walkTogetherRepository.js';
import { AppError, notFound } from '../../utils/errors.js';
import type { Clock } from '../../utils/crypto.js';
import type { CommunityService } from '../community/communityService.js';
import { corridorOverlap } from './corridor.js';
import type { PushService } from '../push/pushService.js';

const MIN = 60_000;

export const WALK_TOGETHER = {
  /** Share of the shorter (privacy-trimmed) corridor two journeys must have in common. */
  minOverlapPct: 40,
  /** A corridor needs at least this many cells after trimming to be matched at all. */
  minCorridorCells: 2,
  maxSharedAreas: 3,
  /** The private pair channel closes this long after both windows end. */
  channelGraceMs: 60 * MIN,
} as const;

/**
 * Walk Together: people walking the same corridor in the same direction at overlapping times are
 * proposed to each other by pseudonym only. Nothing is shared until both accept; then, and only then,
 * a private two-person channel opens. Exact start/end points are never compared or shown: matching
 * uses H3 cells with 300 m trimmed from each end of the route.
 */
export function createWalkTogetherService(deps: {
  repo: WalkTogetherRepository;
  trips: TripRepository;
  users: UserRepository;
  safety: SafetyRepository;
  community: CommunityService;
  areaName: (cell: string) => string | null;
  audit: AuditRepository;
  clock: Clock;
  push?: PushService;
}) {
  const { repo, trips, users, safety, community, areaName, audit, clock } = deps;
  const now = () => clock().getTime();
  const iso = (ms = now()) => new Date(ms).toISOString();

  const suspended = (userId: string) => {
    const until = safety.suspendedUntil(userId);
    return until !== null && until !== undefined && Date.parse(until) > now();
  };

  function view(m: WalkMatchRow, me: string): WalkMatch {
    const mine = m.user_a === me ? 'a' : 'b';
    const otherId = mine === 'a' ? m.user_b : m.user_a;
    const theirs = repo.request(mine === 'a' ? m.request_b : m.request_a);
    return {
      id: m.id,
      status: m.status,
      otherHandle: users.findById(otherId)?.community_handle ?? 'member',
      overlapPct: m.overlap_pct,
      sharedAreas: JSON.parse(m.shared_areas_json) as string[],
      theirWindow: { start: theirs?.window_start ?? m.created_at, end: theirs?.window_end ?? m.created_at },
      myAccepted: (mine === 'a' ? m.a_accepted_at : m.b_accepted_at) !== null,
      theyAccepted: (mine === 'a' ? m.b_accepted_at : m.a_accepted_at) !== null,
      channelId: m.status === 'accepted' ? m.channel_id : null,
    };
  }

  function partyMatch(user: UserRow, matchId: string): WalkMatchRow {
    const m = repo.match(matchId);
    if (!m || (m.user_a !== user.id && m.user_b !== user.id)) throw notFound('Match');
    return m;
  }

  function findMatches(req: WalkRequestRow, corridor: string[]): number {
    let created = 0;
    for (const other of repo.candidates(req.user_id, req.mode, req.window_start, req.window_end)) {
      if (safety.eitherBlocked(req.user_id, other.user_id) || suspended(other.user_id)) continue;
      const otherTrip = trips.trip(other.trip_id);
      if (!otherTrip || otherTrip.ended_at) continue;
      const o = corridorOverlap(corridor, trips.corridor(other.trip_id));
      if (o.overlapPct < WALK_TOGETHER.minOverlapPct || !o.sameDirection) continue;
      const areas = [...new Set(o.shared.map(areaName).filter((a): a is string => a !== null))].slice(0, WALK_TOGETHER.maxSharedAreas);
      const [a, b] = req.id < other.id ? [req, other] : [other, req];
      if (repo.insertMatch({ request_a: a.id, request_b: b.id, user_a: a.user_id, user_b: b.user_id, overlap_pct: o.overlapPct, shared_areas_json: JSON.stringify(areas), created_at: iso() })) {
        created++;
        // The person who asked earlier learns someone is walking their way. Nothing else is shared yet.
        void deps.push?.notify([other.user_id], 'community', { title: 'Someone is walking your way', body: 'A Walk Together match is waiting. Nothing is shared unless you both accept.', url: `/journeys/${other.trip_id}`, tag: `walk-${other.trip_id}`, urgent: false });
      }
    }
    return created;
  }

  const listMatches = (user: UserRow): WalkMatch[] =>
    repo
      .matchesForUser(user.id)
      .filter((m) => !safety.eitherBlocked(m.user_a, m.user_b))
      .map((m) => view(m, user.id));

  return {
    /** Opens (or reopens) a request for one of the caller's walking journeys and looks for matches. */
    request(user: UserRow, tripId: string, windowMinutes: number): { request: { tripId: string; windowStart: string; windowEnd: string; status: string }; matches: WalkMatch[] } {
      const trip = trips.trip(tripId);
      if (!trip || trip.user_id !== user.id) throw notFound('Journey');
      if (trip.status !== 'CREATED' && trip.status !== 'ACTIVE') throw new AppError('CONFLICT', 'Walk Together is available before or during an ongoing journey.');
      if (trip.mode !== 'walk') throw new AppError('VALIDATION_FAILED', 'Walk Together is for walking journeys.');
      if (suspended(user.id)) throw new AppError('FORBIDDEN', 'Your community access is paused while reports are reviewed.');
      const corridor = trips.corridor(trip.id);
      if (corridor.length < WALK_TOGETHER.minCorridorCells) {
        throw new AppError('VALIDATION_FAILED', 'This route is too short to match without revealing where it starts or ends.');
      }
      const start = Math.max(now(), Date.parse(trip.started_at ?? trip.departure_time));
      const req = repo.upsertRequest({ trip_id: trip.id, user_id: user.id, mode: trip.mode, window_start: iso(start), window_end: iso(start + windowMinutes * MIN), created_at: iso() });
      const found = findMatches(req, corridor);
      audit.record({ actorType: 'user', actorId: user.id, action: 'walk_together.requested', targetType: 'trip', targetId: trip.id, metadata: { windowMinutes, newMatches: found } });
      return { request: { tripId: trip.id, windowStart: req.window_start, windowEnd: req.window_end, status: req.status }, matches: listMatches(user) };
    },

    status(user: UserRow, tripId: string): { request: { tripId: string; windowStart: string; windowEnd: string; status: string } | null; matches: WalkMatch[] } {
      const trip = trips.trip(tripId);
      if (!trip || trip.user_id !== user.id) throw notFound('Journey');
      const req = repo.requestForTrip(trip.id);
      const mine = req ? repo.matchesForUser(user.id).filter((m) => m.request_a === req.id || m.request_b === req.id) : [];
      return {
        request: req ? { tripId: trip.id, windowStart: req.window_start, windowEnd: req.window_end, status: req.status } : null,
        matches: mine.map((m) => view(m, user.id)),
      };
    },

    matches: (user: UserRow): WalkMatch[] => listMatches(user),

    /** Mutual consent: the pair channel opens only when both people have accepted. */
    async accept(user: UserRow, matchId: string): Promise<WalkMatch> {
      const m = partyMatch(user, matchId);
      if (m.status !== 'proposed') throw new AppError('CONFLICT', 'This match is no longer open.');
      if (safety.eitherBlocked(m.user_a, m.user_b) || suspended(m.user_a) || suspended(m.user_b)) throw new AppError('CONFLICT', 'This match is no longer available.');
      const ra = repo.request(m.request_a);
      const rb = repo.request(m.request_b);
      if (ra?.status !== 'open' || rb?.status !== 'open') throw new AppError('CONFLICT', 'One of these journeys is no longer looking for company.');
      const side = m.user_a === user.id ? 'a' : 'b';
      repo.setAccepted(m.id, side, iso());
      audit.record({ actorType: 'user', actorId: user.id, action: 'walk_together.accepted', targetType: 'walk_match', targetId: m.id });
      const updated = repo.match(m.id)!;
      if (!updated.a_accepted_at || !updated.b_accepted_at) return view(updated, user.id);

      // Both said yes: open a private two-person channel.
      const userA = users.findById(m.user_a)!;
      const userB = users.findById(m.user_b)!;
      const areas = JSON.parse(m.shared_areas_json) as string[];
      const windowEnd = Math.max(Date.parse(ra.window_end), Date.parse(rb.window_end));
      const channel = await community.createChannel(
        {
          kind: 'walk_together',
          name: `Walk Together${areas[0] ? ` · ${areas[0]}` : ''}`.slice(0, 64),
          neighbourhood_id: null,
          from_area_type: null,
          from_area_id: null,
          to_area_type: null,
          to_area_id: null,
          window_start: [ra.window_start, rb.window_start].sort()[0]!,
          window_end: iso(windowEnd),
          expires_at: iso(windowEnd + WALK_TOGETHER.channelGraceMs),
          max_members: 2,
          created_by: null,
        },
        { chatUserId: community.chatUserId(userA.id) },
      );
      await community.addMember(channel, userA, 'member');
      await community.addMember(channel, userB, 'member');
      if (!repo.setStatus(m.id, 'proposed', 'accepted', iso(), channel.id)) {
        await community.archiveChannel(channel.id, 'match_closed');
        throw new AppError('CONFLICT', 'This match changed while you were accepting it. Please refresh.');
      }
      repo.addMembers(m.id, [userA.id, userB.id], iso());
      repo.cancelOtherProposals([m.request_a, m.request_b], m.id, iso());
      await community.sendSystemMessage(channel.id, MS_MESSAGE_TYPES.systemNotice, {
        kind: 'safety_tip',
        text: 'You both chose to walk together. Agree on a busy, well-lit public place to meet. Do not share your home address. You can leave or block at any time.',
      });
      audit.record({ actorType: 'system', action: 'walk_together.paired', targetType: 'walk_match', targetId: m.id });
      void deps.push?.notify([m.user_a, m.user_b], 'community', { title: 'You both chose to walk together', body: 'Your private two-person chat is open. Meet somewhere busy and well-lit.', url: `/community/${channel.id}`, tag: `walk-pair-${m.id}`, urgent: false });
      return view(repo.match(m.id)!, user.id);
    },

    reject(user: UserRow, matchId: string): WalkMatch {
      const m = partyMatch(user, matchId);
      if (!repo.setStatus(m.id, 'proposed', 'rejected', iso())) throw new AppError('CONFLICT', 'This match is no longer open.');
      audit.record({ actorType: 'user', actorId: user.id, action: 'walk_together.rejected', targetType: 'walk_match', targetId: m.id });
      return view(repo.match(m.id)!, user.id);
    },

    /** Leaves a pair (accepted) or withdraws from a proposal. The channel closes for both. */
    async cancel(user: UserRow, matchId: string, expect?: 'proposed' | 'accepted'): Promise<WalkMatch> {
      const m = partyMatch(user, matchId);
      // A client acting on a stale view (e.g. "withdraw" just after the other person accepted) must not
      // silently break up a pair that has just formed.
      if (expect && m.status !== expect) throw new AppError('CONFLICT', 'This match just changed. Please check again.');
      if (!repo.setStatus(m.id, m.status === 'accepted' ? 'accepted' : 'proposed', 'cancelled', iso())) throw new AppError('CONFLICT', 'This match is no longer open.');
      if (m.channel_id) await community.archiveChannel(m.channel_id, 'match_cancelled');
      audit.record({ actorType: 'user', actorId: user.id, action: 'walk_together.cancelled', targetType: 'walk_match', targetId: m.id });
      return view(repo.match(m.id)!, user.id);
    },

    withdraw(user: UserRow, tripId: string): void {
      const trip = trips.trip(tripId);
      if (!trip || trip.user_id !== user.id) throw notFound('Journey');
      const req = repo.requestForTrip(trip.id);
      if (req) repo.closeRequest(req.id, 'cancelled', iso());
    },

    /** Called when a journey ends: its request closes and pending proposals are withdrawn. */
    tripEnded(tripId: string): void {
      const req = repo.requestForTrip(tripId);
      if (req) repo.closeRequest(req.id, 'cancelled', iso());
    },

    /** Every minute: requests whose window has passed expire (pair channels expire with journey rooms). */
    expire(): number {
      const ended = repo.endedOpenRequests(iso());
      for (const r of ended) repo.closeRequest(r.id, 'expired', iso());
      return ended.length;
    },

    forgetUser: (userId: string) => repo.cancelAllForUser(userId, iso()),
  };
}

export type WalkTogetherService = ReturnType<typeof createWalkTogetherService>;
