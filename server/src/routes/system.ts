import { Router } from 'express';
import type { SystemService } from '../services/system/systemService.js';

export function systemRouter(system: SystemService): Router {
  const router = Router();

  // Liveness: the process is up and serving requests.
  router.get('/health', (_req, res) => {
    res.set('Cache-Control', 'no-store').json(system.health());
  });

  // Readiness: dependencies are usable and the schema is current.
  router.get('/ready', (_req, res) => {
    const ready = system.ready();
    res.set('Cache-Control', 'no-store').status(ready.status === 'ready' ? 200 : 503).json(ready);
  });

  // Non-secret runtime configuration for the browser.
  router.get('/config', (_req, res) => {
    res.set('Cache-Control', 'no-store').json(system.publicConfig());
  });

  return router;
}
