import { pushConfigSchema } from '@mahilasathi/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { apiRequest } from '@/services/apiClient';

const pushKey = ['push', 'config'] as const;

export const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

let registration: Promise<ServiceWorkerRegistration | null> | null = null;

/**
 * Registers the service worker once per page load and resolves when it is active, or null if this browser
 * can't run it (some embedded browsers refuse the script). Never hangs: `navigator.serviceWorker.ready`
 * would wait forever after a failed registration, so nothing here relies on it alone.
 */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return Promise.resolve(null);
  registration ??= navigator.serviceWorker
    .register('/sw.js')
    .then((reg) =>
      Promise.race([
        navigator.serviceWorker.ready.then(() => reg),
        new Promise<ServiceWorkerRegistration | null>((resolve) => setTimeout(() => resolve(reg.active ? reg : null), 10_000)),
      ]),
    )
    .catch(() => null);
  return registration;
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Push notifications for this device: server config, this browser's subscription, and on/off/test actions. */
export function usePush() {
  const qc = useQueryClient();
  const config = useQuery({ queryKey: pushKey, queryFn: () => apiRequest('/push/config', { schema: pushConfigSchema }) });
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [workerOk, setWorkerOk] = useState<boolean | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() => (pushSupported() ? Notification.permission : 'unsupported'));

  useEffect(() => {
    if (!pushSupported()) {
      setSubscribed(false);
      return;
    }
    let cancelled = false;
    void registerServiceWorker()
      .then(async (reg) => {
        if (cancelled) return;
        setWorkerOk(reg !== null);
        setSubscribed(reg ? (await reg.pushManager.getSubscription()) !== null : false);
      })
      .catch(() => {
        if (!cancelled) setSubscribed(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const enable = useMutation({
    mutationFn: async () => {
      if (!pushSupported()) throw new Error('This browser can’t receive push notifications.');
      const key = config.data?.publicKey;
      if (!config.data?.enabled || !key) throw new Error('Push notifications are not set up on this server.');
      const reg = await registerServiceWorker();
      if (!reg) throw new Error('This browser can’t run the notification service. Use Chrome, Edge or Firefox.');
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== 'granted') throw new Error(result === 'denied' ? 'Notifications are blocked for this site. Allow them in your browser’s site settings.' : 'Permission was not given.');
      let sub: PushSubscription;
      try {
        sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) }));
      } catch {
        throw new Error('This browser couldn’t register for push notifications (some embedded or private browsers don’t support it). Try Chrome, Edge or Firefox.');
      }
      const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
      await apiRequest('/push/subscriptions', { method: 'POST', body: { endpoint: json.endpoint, keys: json.keys }, schema: pushConfigSchema });
      setSubscribed(true);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: pushKey }),
  });

  const disable = useMutation({
    mutationFn: async () => {
      const reg = await registerServiceWorker();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        await apiRequest('/push/subscriptions', { method: 'DELETE', body: { endpoint: sub.endpoint }, schema: pushConfigSchema });
        await sub.unsubscribe();
      }
      setSubscribed(false);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: pushKey }),
  });

  const test = useMutation({ mutationFn: () => apiRequest('/push/test', { method: 'POST', schema: z.object({ sent: z.number(), failed: z.number(), removed: z.number() }) }) });

  // Unsupported if the APIs are missing, or the service worker couldn't start (e.g. some embedded browsers).
  return { config, subscribed, permission, supported: pushSupported() && workerOk !== false, enable, disable, test };
}
