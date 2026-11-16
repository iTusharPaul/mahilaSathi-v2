import type { Logger } from 'pino';
import type { SosService } from '../services/sos/sosService.js';

const DISPATCH_MS = 3_000;
const ESCALATE_MS = 10_000;

/**
 * Sends due SOS deliveries every 3 s and applies escalation rules every 10 s. Runs both immediately at
 * startup, which is what recovers work left pending (or mid-send) when the server last stopped.
 * Everything it does is driven by database state, so restarts and overlapping ticks are safe.
 */
export function startSosWorker(deps: { sos: SosService; logger: Logger }): () => void {
  const { sos, logger } = deps;
  const run = (name: string, fn: () => Promise<Record<string, number>>) => async () => {
    try {
      const result = await fn();
      if (Object.values(result).some((n) => n > 0)) logger.info({ job: name, result }, 'SOS worker ran');
    } catch (err) {
      logger.error({ err, job: name }, 'SOS worker failed');
    }
  };
  const dispatch = run('sos-dispatch', () => sos.dispatchDue());
  const escalate = run('sos-escalate', () => sos.escalateDue());
  void escalate().then(dispatch);
  const t1 = setInterval(() => void dispatch(), DISPATCH_MS);
  const t2 = setInterval(() => void escalate(), ESCALATE_MS);
  t1.unref();
  t2.unref();
  return () => {
    clearInterval(t1);
    clearInterval(t2);
  };
}
