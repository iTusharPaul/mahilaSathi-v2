import { Router } from 'express';
import { z } from 'zod';
import { currentAuth, requireAuth } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { parseQuery } from '../middleware/validate.js';
import type { AuditRepository } from '../repositories/auditRepository.js';
import type { PrivacyService } from '../services/privacy/privacyService.js';
import { requireAdmin } from './safety.js';

const auditQuery = z.object({
  action: z.string().max(60).regex(/^[a-z_.]+$/).optional(),
  actorId: z.string().max(80).optional(),
  targetType: z.string().max(40).regex(/^[a-z_]+$/).optional(),
  targetId: z.string().max(80).optional(),
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function privacyRouter(deps: { privacy: PrivacyService; audit: AuditRepository; adminToken: string | null; exportLimit: number }): Router {
  const { privacy, audit } = deps;
  const router = Router();
  const exportLimiter = createRateLimiter({ windowMs: 60 * 60_000, limit: deps.exportLimit, message: 'You can download your data a few times an hour.' });

  router.get('/users/me/export', requireAuth, exportLimiter, (req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="mahilasathi-my-data.json"');
    res.json(privacy.exportData(currentAuth(req).user));
  });
  router.post('/users/me/stop-location-sharing', requireAuth, (req, res) => {
    res.json(privacy.stopAllLocationSharing(currentAuth(req).user));
  });
  router.delete('/trips/history', requireAuth, (req, res) => {
    res.json(privacy.clearJourneyHistory(currentAuth(req).user));
  });

  // Moderators/administrators: the audit trail (identifiers and coarse metadata only, by design).
  router.get('/moderation/audit', requireAdmin(deps.adminToken), (req, res) => {
    const q = parseQuery(req, auditQuery);
    const rows = audit.search({ actionPrefix: q.action, actorId: q.actorId, targetType: q.targetType, targetId: q.targetId, before: q.before, limit: q.limit });
    res.json({
      events: rows.map((r) => ({
        id: r.id,
        occurredAt: r.occurred_at,
        actorType: r.actor_type,
        actorId: r.actor_id,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        requestId: r.request_id,
        metadata: JSON.parse(r.metadata_json) as unknown,
      })),
    });
  });

  return router;
}
