import { Router } from 'express';
import { z } from 'zod';
import { createJourneyRoomSchema, sendInfraUpdateSchema, sendTextSchema } from '@mahilasathi/shared';
import { currentAuth, requireAuth } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { parseBody, parseParams, parseQuery } from '../middleware/validate.js';
import type { CommunityService } from '../services/community/communityService.js';

const channelParams = z.object({ id: z.string().uuid() });
const neighbourhoodParams = z.object({ neighbourhoodId: z.string().max(80) });
const messagesQuery = z.object({
  after: z.coerce.number().int().nonnegative().optional(),
  before: z.coerce.number().int().positive().optional(),
});
const roomsQuery = z.object({ districtId: z.string().max(80).optional() });

export function communityRouter(deps: { community: CommunityService; sessionLimit: number }): Router {
  const { community } = deps;
  const router = Router();
  router.use('/community', requireAuth);
  const sessionLimiter = createRateLimiter({ windowMs: 15 * 60_000, limit: deps.sessionLimit, message: 'Too many chat sign-ins. Please wait a few minutes.' });

  /** Chat credentials for the browser: provider mode, public app key and a per-user token. Never the app secret. */
  router.get('/community/session', sessionLimiter, async (req, res) => {
    res.json(await community.session(currentAuth(req).user));
  });

  router.get('/community/channels', (req, res) => {
    res.json({ channels: community.myChannels(currentAuth(req).user) });
  });

  /** Creates a temporary journey room (the only user-created channel kind). */
  router.post('/community/channels', async (req, res) => {
    res.status(201).json(await community.createJourneyRoom(currentAuth(req).user, parseBody(req, createJourneyRoomSchema)));
  });

  router.get('/community/channels/:id', (req, res) => {
    res.json(community.channelSummary(currentAuth(req).user, parseParams(req, channelParams).id));
  });

  router.get('/community/channels/:id/members', (req, res) => {
    res.json({ members: community.members(currentAuth(req).user, parseParams(req, channelParams).id) });
  });

  router.post('/community/channels/:id/join', async (req, res) => {
    res.json(await community.joinJourneyRoom(currentAuth(req).user, parseParams(req, channelParams).id));
  });

  router.post('/community/channels/:id/leave', async (req, res) => {
    await community.leave(currentAuth(req).user, parseParams(req, channelParams).id);
    res.status(204).end();
  });

  router.get('/community/channels/:id/messages', (req, res) => {
    const { after, before } = parseQuery(req, messagesQuery);
    res.json(community.relayMessages(currentAuth(req).user, parseParams(req, channelParams).id, { afterSeq: after, beforeSeq: before }));
  });

  router.post('/community/channels/:id/messages', (req, res) => {
    const { text } = parseBody(req, sendTextSchema);
    res.status(201).json(community.sendRelayText(currentAuth(req).user, parseParams(req, channelParams).id, text));
  });

  router.post('/community/channels/:id/updates', async (req, res) => {
    res.status(201).json(await community.sendInfraUpdate(currentAuth(req).user, parseParams(req, channelParams).id, parseBody(req, sendInfraUpdateSchema)));
  });

  router.get('/community/journey-rooms', (req, res) => {
    res.json({ rooms: community.journeyRooms(currentAuth(req).user, parseQuery(req, roomsQuery).districtId) });
  });

  router.get('/community/neighbourhoods', (req, res) => {
    res.json(community.neighbourhoodOptions(currentAuth(req).user));
  });

  router.post('/community/neighbourhoods/:neighbourhoodId/join', async (req, res) => {
    res.json(await community.joinNeighbourhood(currentAuth(req).user, parseParams(req, neighbourhoodParams).neighbourhoodId));
  });

  return router;
}
