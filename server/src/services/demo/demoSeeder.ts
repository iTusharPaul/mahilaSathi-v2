import { DEMO_ACCOUNTS, normalizeIndianMobile, type LngLat } from '@mahilasathi/shared';
import type { AppConfig } from '../../config/index.js';
import type { UserRepository, UserRow } from '../../repositories/userRepository.js';
import type { CircleService } from '../circles/circleService.js';
import type { CommunityService } from '../community/communityService.js';
import type { TripService } from '../journeys/tripService.js';
import type { WalkTogetherService } from '../journeys/walkTogetherService.js';
import type { RoutePlanningService } from '../routing/routePlanningService.js';
import type { SosService } from '../sos/sosService.js';
import type { CoverageService } from '../geography/coverageService.js';
import type { createUserService } from '../users/userService.js';

/** Green Park → Saket (South Delhi). Matches a walk planned from Green Park Market to Select Citywalk. */
export const DEFAULT_COMPANION_ROUTE: { from: LngLat; to: LngLat } = { from: [77.203, 28.555], to: [77.219, 28.5285] };

export class DemoModeRequiredError extends Error {
  constructor() {
    super('Demo data can only be created with DEMO_MODE=true. It must never be mixed into a real deployment.');
  }
}

/**
 * Creates the fictional demo accounts and their relationships, using the same services as real users
 * (so channels, circles and invites go through the configured chat provider). Idempotent.
 */
export function createDemoSeeder(deps: {
  config: AppConfig;
  users: UserRepository;
  userService: ReturnType<typeof createUserService>;
  circles: CircleService;
  community: CommunityService;
  planning: RoutePlanningService;
  trips: TripService;
  walk: WalkTogetherService;
  sos: SosService;
  coverage: CoverageService;
}) {
  const { config, users, userService, circles, community, planning, trips, walk, sos, coverage } = deps;
  const guard = () => {
    if (!config.demoMode) throw new DemoModeRequiredError();
  };

  function account(i: number): { user: UserRow; created: boolean } {
    const a = DEMO_ACCOUNTS[i]!;
    const phone = normalizeIndianMobile(a.phone)!;
    let user = users.findByPhone(phone);
    const created = !user;
    if (!user) user = users.create(phone, a.handle, new Date().toISOString());
    users.markDemo(user.id);
    userService.updateMe(users.findById(user.id)!, { displayName: a.displayName, homeNeighbourhoodId: a.homeNeighbourhoodId, onboardingCompleted: true });
    return { user: users.findById(user.id)!, created };
  }

  return {
    async seed(): Promise<{ accounts: { handle: string; phone: string; created: boolean }[]; circle: string; notes: string[] }> {
      guard();
      const [lotus, jasmine, neem] = [account(0), account(1), account(2)];
      const notes: string[] = [];

      if (userService.listContacts(lotus.user.id).length === 0) {
        userService.addContact(lotus.user, { name: 'Demo contact (fictional)', phone: '9000000099', relationship: 'Demo' });
        notes.push('Added a fictional emergency contact for Lotus-42.');
      }
      sos.updateSettings(lotus.user, { emergencyContacts: 'if_unacknowledged', escalateAfterMinutes: 2, locationDetail: 'precise' });

      // Lotus's Guardian Circle with Jasmine as guardian.
      let circle = circles.list(lotus.user).find((c) => c.isOwner);
      if (!circle) {
        circle = await circles.create(lotus.user, 'Lotus’s circle');
        notes.push('Created Lotus-42’s Guardian Circle.');
      }
      if (!circle.members.some((m) => m.displayName === DEMO_ACCOUNTS[1].displayName)) {
        const invite = circles.createInvite(lotus.user, circle.id);
        await circles.accept(jasmine.user, invite.code);
        notes.push('Jasmine-17 joined the circle as guardian.');
      }

      // Neighbourhood channels (home areas), and one labelled demo update in Saket.
      await community.joinNeighbourhood(lotus.user, DEMO_ACCOUNTS[0].homeNeighbourhoodId);
      const saket = await community.joinNeighbourhood(jasmine.user, DEMO_ACCOUNTS[1].homeNeighbourhoodId);
      await community.joinNeighbourhood(neem.user, DEMO_ACCOUNTS[2].homeNeighbourhoodId);
      if (neem.created) {
        await community.sendInfraUpdate(neem.user, saket.id, { category: 'poor_lighting', note: '[Demo] Two streetlights are out on the lane behind the market.' });
        notes.push('Posted one labelled demo update in the Saket channel.');
      }
      // Data coverage for the demo home areas, from live place data (skipped without a place provider).
      for (const id of new Set(DEMO_ACCOUNTS.map((a) => a.homeNeighbourhoodId))) {
        const c = await coverage.assessNeighbourhood(id).catch(() => null);
        if (c) notes.push(`Data coverage for ${id}: ${c.level}.`);
      }
      return {
        accounts: [lotus, jasmine, neem].map((x, i) => ({ handle: x.user.community_handle, phone: DEMO_ACCOUNTS[i]!.phone, created: x.created })),
        circle: circle.name,
        notes,
      };
    },

    /**
     * Starts a walk for Neem-08 and asks for Walk Together, so Lotus-42 has someone to match with during a
     * live demo. Ends any journey Neem already has open.
     */
    async startCompanion(route = DEFAULT_COMPANION_ROUTE, windowMinutes = 45): Promise<{ tripId: string; matches: number; window: { start: string; end: string } }> {
      guard();
      const neem = account(2).user;
      const open = trips.active(neem);
      if (open) await trips.setStatus(neem, open.id, open.status === 'CREATED' || open.status === 'ACTIVE' || open.status === 'DELAYED' ? 'CANCELLED' : 'ARRIVED');
      const plan = await planning.plan(neem, {
        origin: { lng: route.from[0], lat: route.from[1] },
        destination: { lng: route.to[0], lat: route.to[1] },
        mode: 'walk',
        preferences: { fewerIsolatedStretches: false, preferMainRoads: false },
      });
      const trip = await trips.create(neem, { routeId: plan.routes[0]!.id, shareLevel: null });
      await trips.setStatus(neem, trip.id, 'ACTIVE');
      const res = walk.request(neem, trip.id, windowMinutes);
      return { tripId: trip.id, matches: res.matches.length, window: { start: res.request.windowStart, end: res.request.windowEnd } };
    },
  };
}

export type DemoSeeder = ReturnType<typeof createDemoSeeder>;
