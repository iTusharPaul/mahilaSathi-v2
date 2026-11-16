import { z } from 'zod';

/**
 * Only real browser push services are accepted as endpoints: the server POSTs to this URL, so an arbitrary
 * one would let anyone make the server call internal addresses (SSRF).
 */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^[a-z0-9-]+\.notify\.windows\.com$/, /^web\.push\.apple\.com$/, /^[a-z0-9-]+\.push\.apple\.com$/];
export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

export const pushSubscriptionSchema = z
  .object({
    endpoint: z.string().max(1000).refine(isAllowedPushEndpoint, 'Not a supported push service'),
    keys: z.object({ p256dh: z.string().min(16).max(200), auth: z.string().min(8).max(100) }).strict(),
  })
  .strict();
export const pushUnsubscribeSchema = z.object({ endpoint: z.string().max(1000) }).strict();
export const pushConfigSchema = z.object({ enabled: z.boolean(), publicKey: z.string().nullable(), subscriptions: z.number().int() });
export type PushConfig = z.infer<typeof pushConfigSchema>;

/** What the service worker receives (encrypted end to end to the browser). Never coordinates. */
export const pushPayloadSchema = z.object({ title: z.string(), body: z.string(), url: z.string(), tag: z.string(), urgent: z.boolean() });
export type PushPayload = z.infer<typeof pushPayloadSchema>;
