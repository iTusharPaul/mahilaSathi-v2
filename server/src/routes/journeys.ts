import { Router } from 'express';
import { z } from 'zod';
import {
  checkinSchema,
  createCommunityReportSchema,
  createTripSchema,
  locationUpdateSchema,
  pulseQuerySchema,
  reviewCommunityReportSchema,
  shareRequestSchema,
  updateTripStatusSchema,
  walkTogetherRequestSchema,
} from '@mahilasathi/shared';
import { currentAuth, requireAuth } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { parseBody, parseParams, parseQuery } from '../middleware/validate.js';
import type { TripService } from '../services/journeys/tripService.js';
import type { WalkTogetherService } from '../services/journeys/walkTogetherService.js';
import type { PulseService } from '../services/pulse/pulseService.js';
import { requireAdmin } from './safety.js';

const idParams = z.object({ id: z.string().uuid() });
const sharingBody = z.object({ enabled: z.boolean() }).strict();
const cancelBody = z.object({ expect: z.enum(['proposed', 'accepted']).optional() }).strict().default({});

/** Journeys, Guardian views and Walk Together. Everything is owner- or membership-scoped on the server. */
export function journeysRouter(deps: { trips: TripService; walk: WalkTogetherService; locationLimit: number }): Router {
  const { trips, walk } = deps;
  const router = Router();
  router.use(['/trips', '/walk-together'], requireAuth);
  // Clients post at most every ~30 s; this leaves room for retries without allowing a firehose.
  const locationLimiter = createRateLimiter({ windowMs: 60_000, limit: deps.locationLimit, message: 'Location updates are too frequent.' });

  router.post('/trips', async (req, res) => {
    res.status(201).json(await trips.create(currentAuth(req).user, parseBody(req, createTripSchema)));
  });
  router.get('/trips', (req, res) => {
    res.json({ trips: trips.list(currentAuth(req).user) });
  });
  router.get('/trips/active', (req, res) => {
    res.json({ trip: trips.active(currentAuth(req).user) });
  });
  // Guardian views. Declared before /trips/:id so "shared" is not taken for an id.
  router.get('/trips/shared', (req, res) => {
    res.json({ trips: trips.sharedWithMe(currentAuth(req).user) });
  });
  router.get('/trips/shared/:id', (req, res) => {
    res.json(trips.sharedTrip(currentAuth(req).user, parseParams(req, idParams).id));
  });
  router.post('/trips/shared/:id/acknowledge', async (req, res) => {
    res.json(await trips.acknowledge(currentAuth(req).user, parseParams(req, idParams).id));
  });

  router.get('/trips/:id', (req, res) => {
    res.json(trips.get(currentAuth(req).user, parseParams(req, idParams).id));
  });
  router.patch('/trips/:id/status', async (req, res) => {
    const { status, feedback } = parseBody(req, updateTripStatusSchema);
    res.json(await trips.setStatus(currentAuth(req).user, parseParams(req, idParams).id, status, feedback));
  });
  router.post('/trips/:id/checkin', async (req, res) => {
    res.json(await trips.checkin(currentAuth(req).user, parseParams(req, idParams).id, parseBody(req, checkinSchema).note));
  });
  router.post('/trips/:id/share', async (req, res) => {
    res.json(await trips.share(currentAuth(req).user, parseParams(req, idParams).id, parseBody(req, shareRequestSchema).level));
  });
  router.delete('/trips/:id/share', async (req, res) => {
    res.json(await trips.unshare(currentAuth(req).user, parseParams(req, idParams).id));
  });
  router.put('/trips/:id/location-sharing', (req, res) => {
    res.json(trips.setLocationSharing(currentAuth(req).user, parseParams(req, idParams).id, parseBody(req, sharingBody).enabled));
  });
  router.post('/trips/:id/location', locationLimiter, (req, res) => {
    res.json(trips.recordLocation(currentAuth(req).user, parseParams(req, idParams).id, parseBody(req, locationUpdateSchema)));
  });

  // ─── Walk Together ──────────────────────────────────────────────────────────
  router.post('/walk-together/request', (req, res) => {
    const { tripId, windowMinutes } = parseBody(req, walkTogetherRequestSchema);
    res.json(walk.request(currentAuth(req).user, tripId, windowMinutes));
  });
  router.get('/walk-together/trips/:id', (req, res) => {
    res.json(walk.status(currentAuth(req).user, parseParams(req, idParams).id));
  });
  router.delete('/walk-together/trips/:id', (req, res) => {
    walk.withdraw(currentAuth(req).user, parseParams(req, idParams).id);
    res.status(204).end();
  });
  router.get('/walk-together/matches', (req, res) => {
    res.json({ matches: walk.matches(currentAuth(req).user) });
  });
  router.post('/walk-together/matches/:id/accept', async (req, res) => {
    res.json(await walk.accept(currentAuth(req).user, parseParams(req, idParams).id));
  });
  router.post('/walk-together/matches/:id/reject', (req, res) => {
    res.json(walk.reject(currentAuth(req).user, parseParams(req, idParams).id));
  });
  router.post('/walk-together/matches/:id/cancel', async (req, res) => {
    res.json(await walk.cancel(currentAuth(req).user, parseParams(req, idParams).id, parseBody(req, cancelBody).expect));
  });

  return router;
}

/** Community Pulse (aggregated only) and incident reports, plus their moderation queue. */
export function pulseRouter(deps: { pulse: PulseService; adminToken: string | null; reportLimit: number }): Router {
  const { pulse } = deps;
  const router = Router();
  router.use(['/community/pulse', '/community/reports'], requireAuth);
  const reportLimiter = createRateLimiter({ windowMs: 60 * 60_000, limit: deps.reportLimit, message: 'Too many reports. Please wait a while.' });

  router.get('/community/pulse', (req, res) => {
    const { lat, lng } = parseQuery(req, pulseQuerySchema);
    res.json({ cells: pulse.around(lat, lng) });
  });
  router.post('/community/reports', reportLimiter, (req, res) => {
    res.status(201).json(pulse.createReport(currentAuth(req).user, parseBody(req, createCommunityReportSchema)));
  });
  router.get('/community/reports', (req, res) => {
    const { lat, lng } = parseQuery(req, pulseQuerySchema);
    res.json({ reports: pulse.reportsNear(currentAuth(req).user, lat, lng) });
  });
  router.get('/community/reports/mine', (req, res) => {
    res.json({ reports: pulse.myReports(currentAuth(req).user) });
  });

  const admin = requireAdmin(deps.adminToken);
  router.get('/moderation/community-reports', admin, (_req, res) => {
    res.json({ reports: pulse.reviewQueue() });
  });
  router.post('/moderation/community-reports/:id/review', admin, (req, res) => {
    const { decision, note } = parseBody(req, reviewCommunityReportSchema);
    res.json(pulse.review(parseParams(req, idParams).id, decision, note));
  });

  return router;
}
