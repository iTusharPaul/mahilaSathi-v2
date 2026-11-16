import { Router } from 'express';
import { pushSubscriptionSchema, pushUnsubscribeSchema } from '@mahilasathi/shared';
import { currentAuth, requireAuth } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { parseBody } from '../middleware/validate.js';
import type { PushService } from '../services/push/pushService.js';
import { AppError } from '../utils/errors.js';

/** Web Push: the browser subscribes with the server's public key; the server sends encrypted notifications. */
export function pushRouter(deps: { push: PushService; testLimit: number }): Router {
  const { push } = deps;
  const router = Router();
  router.use('/push', requireAuth);
  const testLimiter = createRateLimiter({ windowMs: 10 * 60_000, limit: deps.testLimit, message: 'Too many test notifications. Try again in a few minutes.' });

  router.get('/push/config', (req, res) => {
    res.json(push.config(currentAuth(req).user.id));
  });
  router.post('/push/subscriptions', (req, res) => {
    if (!push.enabled) throw new AppError('NOT_FOUND', 'Push notifications are not set up on this server.');
    push.subscribe(currentAuth(req).user.id, parseBody(req, pushSubscriptionSchema), req.header('user-agent') ?? null);
    res.status(201).json(push.config(currentAuth(req).user.id));
  });
  router.delete('/push/subscriptions', (req, res) => {
    push.unsubscribe(currentAuth(req).user.id, parseBody(req, pushUnsubscribeSchema).endpoint);
    res.json(push.config(currentAuth(req).user.id));
  });
  router.post('/push/test', testLimiter, async (req, res) => {
    if (!push.enabled) throw new AppError('NOT_FOUND', 'Push notifications are not set up on this server.');
    res.json(await push.test(currentAuth(req).user.id));
  });
  return router;
}
