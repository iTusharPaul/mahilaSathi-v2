import { Router } from 'express';
import type { UsageRepository } from '../repositories/usageRepository.js';
import type { Clock } from '../utils/crypto.js';
import { requireAdmin } from './safety.js';

/** GET /api/moderation/usage: aggregate counts for the moderator screen (admin token required). */
export function usageRouter(deps: { usage: UsageRepository; adminToken: string | null; clock: Clock }): Router {
  const router = Router();
  router.get('/moderation/usage', requireAdmin(deps.adminToken), (_req, res) => {
    res.set('Cache-Control', 'no-store').json(deps.usage.report(deps.clock()));
  });
  return router;
}
