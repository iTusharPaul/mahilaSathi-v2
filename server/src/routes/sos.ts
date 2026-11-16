import { Router } from 'express';
import { z } from 'zod';
import { acknowledgeSosSchema, activateSosSchema, endSosSchema, sosLocationSchema, sosLocationSharingSchema, updateSosSettingsSchema } from '@mahilasathi/shared';
import { currentAuth, requireAuth } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { parseBody, parseParams } from '../middleware/validate.js';
import type { SosService } from '../services/sos/sosService.js';
import { AppError } from '../utils/errors.js';
import { requireAdmin } from './safety.js';

const idParams = z.object({ id: z.string().uuid() });

/**
 * SOS. Activation is deliberately not rate-limited beyond the global API limit: idempotency and the
 * one-active-SOS rule already stop duplicates, and an emergency must never be refused for "too many requests".
 */
export function sosRouter(deps: { sos: SosService; locationLimit: number; adminToken: string | null }): Router {
  const { sos } = deps;
  const router = Router();
  router.use(['/sos', '/users/me/sos-settings'], requireAuth);
  const locationLimiter = createRateLimiter({ windowMs: 60_000, limit: deps.locationLimit, message: 'Location updates are too frequent.' });

  router.get('/users/me/sos-settings', (req, res) => {
    res.json(sos.settings(currentAuth(req).user));
  });
  router.patch('/users/me/sos-settings', (req, res) => {
    res.json(sos.updateSettings(currentAuth(req).user, parseBody(req, updateSosSettingsSchema)));
  });

  router.post('/sos', (req, res) => {
    const { event, created } = sos.activate(currentAuth(req).user, parseBody(req, activateSosSchema));
    res.status(created ? 201 : 200).json(event);
  });
  router.get('/sos/active', (req, res) => {
    res.json({ sos: sos.active(currentAuth(req).user) });
  });
  router.get('/sos/history', (req, res) => {
    res.json({ events: sos.history(currentAuth(req).user) });
  });
  // Declared before /sos/:id so "received" is not taken for an id.
  router.get('/sos/received', (req, res) => {
    res.json({ alerts: sos.received(currentAuth(req).user) });
  });
  router.get('/sos/:id', (req, res) => {
    res.json(sos.get(currentAuth(req).user, parseParams(req, idParams).id));
  });
  router.post('/sos/:id/acknowledge', (req, res) => {
    res.json(sos.acknowledge(currentAuth(req).user, parseParams(req, idParams).id, parseBody(req, acknowledgeSosSchema).response));
  });
  router.post('/sos/:id/cancel', (req, res) => {
    res.json(sos.end(currentAuth(req).user, parseParams(req, idParams).id, parseBody(req, endSosSchema).outcome));
  });
  router.post('/sos/:id/location', locationLimiter, (req, res) => {
    res.json(sos.updateLocation(currentAuth(req).user, parseParams(req, idParams).id, parseBody(req, sosLocationSchema)));
  });
  router.put('/sos/:id/location-sharing', (req, res) => {
    res.json(sos.setLocationSharing(currentAuth(req).user, parseParams(req, idParams).id, parseBody(req, sosLocationSharingSchema).enabled));
  });

  // Moderators: the development SMS adapter's outbox (so a demo can show what emergency contacts would get).
  router.get('/moderation/dev-sms', requireAdmin(deps.adminToken), (_req, res) => {
    const outbox = sos.devOutbox();
    if (!outbox) throw new AppError('NOT_FOUND', 'The development SMS adapter is not in use on this server.');
    res.json({ messages: outbox });
  });

  return router;
}
