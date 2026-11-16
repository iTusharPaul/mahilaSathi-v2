import crypto from 'node:crypto';
import webpush from 'web-push';
import type { Logger } from 'pino';
import type { PushPayload } from '@mahilasathi/shared';
import type { Db } from '../../db/connection.js';
import type { UserRepository } from '../../repositories/userRepository.js';
import type { Clock } from '../../utils/crypto.js';

export type PushCategory = 'sos' | 'journey' | 'community';

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** The seam to the browser push services. Tests replace it; production uses web-push with VAPID. */
export interface PushSender {
  send(target: PushTarget, payload: string, options: { ttlSeconds: number; urgency: 'high' | 'normal' }): Promise<{ statusCode: number }>;
}

export class PushGoneError extends Error {}

export function createWebPushSender(vapid: { publicKey: string; privateKey: string; subject: string }): PushSender {
  return {
    async send(target, payload, options) {
      try {
        const res = await webpush.sendNotification(target, payload, {
          TTL: options.ttlSeconds,
          urgency: options.urgency,
          timeout: 10_000,
          vapidDetails: vapid,
        });
        return { statusCode: res.statusCode };
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        // 404/410: the browser unsubscribed or the subscription expired.
        if (status === 404 || status === 410) throw new PushGoneError('subscription gone');
        throw new Error(`push service responded ${status ?? 'with a network error'}`);
      }
    },
  };
}

interface SubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Notifications to the people involved: SOS alerts to guardians, journey updates to the circle, and Walk
 * Together matches. Best effort and preference-aware; a push failure never breaks the action that caused it.
 * Payloads carry no coordinates and are encrypted end to end to the browser.
 */
export function createPushService(deps: { db: Db; users: UserRepository; sender: PushSender | null; publicKey: string | null; clock: Clock; logger: Logger }) {
  const { db, users, sender, publicKey, clock, logger } = deps;
  const iso = () => clock().toISOString();

  const forUsers = (ids: string[]) =>
    ids.length === 0
      ? []
      : (db.prepare('SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)) as SubscriptionRow[]);

  const wants = (userId: string, category: PushCategory): boolean => {
    const p = users.getPreferences(userId);
    return category === 'sos' ? p.notifySos : category === 'journey' ? p.notifyJourneyUpdates : p.notifyCommunity;
  };

  async function deliver(rows: SubscriptionRow[], payload: PushPayload): Promise<{ sent: number; failed: number; removed: number }> {
    const counts = { sent: 0, failed: 0, removed: 0 };
    if (!sender) return counts;
    const body = JSON.stringify(payload);
    await Promise.all(
      rows.map(async (s) => {
        try {
          await sender.send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { ttlSeconds: payload.urgent ? 3600 : 6 * 3600, urgency: payload.urgent ? 'high' : 'normal' });
          db.prepare('UPDATE push_subscriptions SET last_success_at = ?, failures = 0 WHERE id = ?').run(iso(), s.id);
          counts.sent++;
        } catch (err) {
          if (err instanceof PushGoneError) {
            db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
            counts.removed++;
          } else {
            db.prepare('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ?').run(s.id);
            counts.failed++;
            logger.warn({ reason: (err as Error).message }, 'push delivery failed');
          }
        }
      }),
    );
    return counts;
  }

  return {
    enabled: sender !== null && publicKey !== null,

    config(userId: string) {
      const n = (db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(userId) as { n: number }).n;
      return { enabled: sender !== null && publicKey !== null, publicKey, subscriptions: n };
    },

    subscribe(userId: string, sub: PushTarget, userAgent: string | null): void {
      // The same browser can re-subscribe; an endpoint belongs to whoever subscribed it last.
      db.prepare(
        `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent, failures = 0`,
      ).run(crypto.randomUUID(), userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, userAgent?.slice(0, 200) ?? null, iso());
    },

    unsubscribe: (userId: string, endpoint: string) => db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint).changes > 0,

    /** Sends to every device of each user who wants this category. Never throws. */
    async notify(userIds: string[], category: PushCategory, payload: PushPayload): Promise<{ sent: number; failed: number; removed: number; skipped: number }> {
      if (!sender) return { sent: 0, failed: 0, removed: 0, skipped: userIds.length };
      try {
        const wanted = [...new Set(userIds)].filter((id) => wants(id, category));
        const res = await deliver(forUsers(wanted), payload);
        return { ...res, skipped: userIds.length - wanted.length };
      } catch (err) {
        logger.warn({ reason: (err as Error).message }, 'push notify failed');
        return { sent: 0, failed: 0, removed: 0, skipped: userIds.length };
      }
    },

    test: (userId: string) =>
      deliver(forUsers([userId]), { title: 'mahilaSathi notifications are on', body: 'This device will get SOS alerts and journey updates.', url: '/profile', tag: 'test', urgent: false }),
  };
}

export type PushService = ReturnType<typeof createPushService>;
