import crypto from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { messageReportSchema, moderationResolveSchema, userReportSchema } from '@mahilasathi/shared';
import { currentAuth, requireAuth } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { parseBody, parseParams } from '../middleware/validate.js';
import type { SafetyService } from '../services/moderation/safetyService.js';
import { AppError } from '../utils/errors.js';

const userParams = z.object({ id: z.string().min(1).max(80) });
const messageParams = z.object({ id: z.string().min(1).max(128) });
const reportParams = z.object({ id: z.string().uuid() });

/** Moderator endpoints require X-Admin-Token. Disabled entirely when ADMIN_TOKEN is not configured. */
export function requireAdmin(adminToken: string | null): RequestHandler {
  return (req, _res, next) => {
    const given = req.header('x-admin-token') ?? '';
    if (!adminToken) return next(new AppError('NOT_FOUND', 'Not found'));
    const a = Buffer.from(given);
    const b = Buffer.from(adminToken);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return next(new AppError('UNAUTHENTICATED', 'Admin token required'));
    next();
  };
}

export function safetyRouter(deps: { safety: SafetyService; adminToken: string | null; reportLimit: number }): Router {
  const { safety } = deps;
  const router = Router();
  const reportLimiter = createRateLimiter({ windowMs: 60 * 60_000, limit: deps.reportLimit, message: 'Too many reports in a short time. Please try again later.' });

  router.get('/users/me/blocks', requireAuth, (req, res) => {
    res.json({ blocked: safety.blocks(currentAuth(req).user) });
  });

  router.post('/users/:id/block', requireAuth, async (req, res) => {
    await safety.block(currentAuth(req).user, parseParams(req, userParams).id);
    res.status(204).end();
  });

  router.delete('/users/:id/block', requireAuth, (req, res) => {
    safety.unblock(currentAuth(req).user, parseParams(req, userParams).id);
    res.status(204).end();
  });

  router.post('/moderation/messages/:id/report', requireAuth, reportLimiter, (req, res) => {
    const result = safety.reportMessage(currentAuth(req).user, parseParams(req, messageParams).id, parseBody(req, messageReportSchema));
    res.status(result.duplicate ? 200 : 201).json({ id: result.id, status: 'submitted' });
  });

  router.post('/reports', requireAuth, reportLimiter, (req, res) => {
    res.status(201).json({ ...safety.reportUser(currentAuth(req).user, parseBody(req, userReportSchema)), status: 'submitted' });
  });

  // ─── Moderator review ──────────────────────────────────────────────────────
  const admin = requireAdmin(deps.adminToken);
  router.get('/moderation/queue', admin, (_req, res) => {
    res.json(safety.queue());
  });
  router.post('/moderation/reports/:id/resolve', admin, async (req, res) => {
    res.json(await safety.resolve(parseParams(req, reportParams).id, parseBody(req, moderationResolveSchema)));
  });

  return router;
}
