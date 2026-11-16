import { Router } from 'express';
import type { Clock } from '../utils/crypto.js';
import { AppError } from '../utils/errors.js';
import { verifyNexconnWebhook } from '../services/nexconn/nexconnServerApi.js';
import type { createNexconnWebhookHandler } from '../services/nexconn/webhookHandler.js';

/**
 * Server-to-server endpoint for Nexconn. Authenticated by Nexconn's signature headers, not by
 * cookies, so it is mounted before the session and origin middleware.
 */
export function webhooksRouter(deps: {
  appSecret: string | null;
  handler: ReturnType<typeof createNexconnWebhookHandler> | null;
  clock: Clock;
}): Router {
  const router = Router();
  router.post('/webhooks/nexconn', (req, res, next) => {
    if (!deps.appSecret || !deps.handler) return next(new AppError('NOT_FOUND', 'Not found'));
    const ok = verifyNexconnWebhook(
      deps.appSecret,
      {
        nonce: req.header('nonce') ?? undefined,
        timestamp: req.header('timestamp') ?? undefined,
        signature: req.header('signature') ?? undefined,
      },
      deps.clock().getTime(),
    );
    if (!ok) return next(new AppError('UNAUTHENTICATED', 'Invalid webhook signature'));
    res.json(deps.handler.handle(req.body));
  });
  return router;
}
