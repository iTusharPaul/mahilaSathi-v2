import { useQuery } from '@tanstack/react-query';
import { ChevronRight, ShieldAlert } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useMe } from '@/features/auth/useSession';
import { registerServiceWorker } from '@/features/notifications/usePush';
import { sosApi } from '@/services/sosApi';

/**
 * Shown on every screen while someone in a circle you belong to has an active SOS. Polls while signed in;
 * loading the alert is what confirms in-app delivery to the sender. Push notifications are not built yet.
 */
export function SosAlertBanner() {
  const me = useMe();
  const { pathname } = useLocation();
  const alerts = useQuery({ queryKey: ['sos', 'received'], queryFn: sosApi.received, enabled: Boolean(me.data), refetchInterval: 15_000, refetchIntervalInBackground: true });
  const active = (alerts.data?.alerts ?? []).filter((a) => a.status === 'ACTIVE' && !pathname.startsWith(`/sos/alerts/${a.id}`));
  // Local fallback for browsers without push: a system notification for a NEW alert while this tab is in the
  // background. Only when notifications were already allowed; never prompts from here.
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = (alerts.data?.alerts ?? []).filter((a) => a.status === 'ACTIVE').map((a) => a.id);
    if (seen.current === null) {
      seen.current = new Set(ids);
      return;
    }
    for (const a of alerts.data?.alerts ?? []) {
      if (a.status !== 'ACTIVE' || seen.current.has(a.id)) continue;
      seen.current.add(a.id);
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
        const title = `${a.demo ? 'DEMO (not real): ' : ''}SOS from ${a.travellerName}`;
        const body = 'Tap to see where they are and respond.';
        void registerServiceWorker()
          .then((reg) => {
            if (reg) return reg.showNotification(title, { body, tag: `sos-${a.id}`, data: { url: `/sos/alerts/${a.id}` }, requireInteraction: true });
            // No service worker (some embedded browsers): a plain page notification still works.
            const n = new Notification(title, { body, tag: `sos-${a.id}`, requireInteraction: true });
            n.onclick = () => {
              window.focus();
              window.location.assign(`/sos/alerts/${a.id}`);
            };
            return undefined;
          })
          .catch(() => undefined);
      }
    }
  }, [alerts.data]);
  if (active.length === 0) return null;
  return (
    <div className="space-y-2" role="alert">
      {active.map((a) => (
        <Link key={a.id} to={`/sos/alerts/${a.id}`} className="flex items-center gap-3 rounded-2xl bg-danger p-3.5 text-danger-fg shadow-raised">
          <ShieldAlert className="h-6 w-6 shrink-0 animate-pulse" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block font-semibold">{a.demo ? 'DEMO SOS (not real) from ' : 'SOS from '}{a.travellerName}</span>
            <span className="block text-sm opacity-90">{a.myResponse ? 'You responded. Tap for updates.' : 'Tap to see where and respond.'}</span>
          </span>
          <ChevronRight className="h-5 w-5" aria-hidden />
        </Link>
      ))}
    </div>
  );
}
