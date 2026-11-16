import { Router } from 'express';
import { z } from 'zod';
import { acceptInviteSchema, createCircleSchema, createInviteSchema } from '@mahilasathi/shared';
import { currentAuth, requireAuth } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { parseBody, parseParams } from '../middleware/validate.js';
import type { CircleService } from '../services/circles/circleService.js';

const circleParams = z.object({ id: z.string().uuid() });
const memberParams = circleParams.extend({ userId: z.string().max(80) });
const inviteParams = circleParams.extend({ inviteId: z.string().uuid() });

export function circlesRouter(deps: { circles: CircleService; acceptLimit: number }): Router {
  const { circles } = deps;
  const router = Router();
  router.use('/circles', requireAuth);
  // Invite codes are 8 characters from a 31-symbol alphabet; this limit makes guessing impractical.
  const acceptLimiter = createRateLimiter({ windowMs: 15 * 60_000, limit: deps.acceptLimit, message: 'Too many invite attempts. Please wait.' });

  router.get('/circles', (req, res) => {
    res.json({ circles: circles.list(currentAuth(req).user) });
  });

  router.post('/circles', async (req, res) => {
    res.status(201).json(await circles.create(currentAuth(req).user, parseBody(req, createCircleSchema).name));
  });

  router.post('/circles/accept', acceptLimiter, async (req, res) => {
    res.json(await circles.accept(currentAuth(req).user, parseBody(req, acceptInviteSchema).code));
  });

  router.post('/circles/:id/invite', (req, res) => {
    const { phone } = parseBody(req, createInviteSchema);
    res.status(201).json(circles.createInvite(currentAuth(req).user, parseParams(req, circleParams).id, phone));
  });

  router.delete('/circles/:id/invites/:inviteId', (req, res) => {
    const { id, inviteId } = parseParams(req, inviteParams);
    circles.revokeInvite(currentAuth(req).user, id, inviteId);
    res.status(204).end();
  });

  router.post('/circles/:id/accept', acceptLimiter, async (req, res) => {
    const { id } = parseParams(req, circleParams);
    res.json(await circles.accept(currentAuth(req).user, parseBody(req, acceptInviteSchema).code, id));
  });

  router.delete('/circles/:id/members/:userId', async (req, res) => {
    const { id, userId } = parseParams(req, memberParams);
    await circles.removeMember(currentAuth(req).user, id, userId);
    res.status(204).end();
  });

  return router;
}
