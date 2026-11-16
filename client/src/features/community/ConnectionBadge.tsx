import { FlaskConical, Wifi, WifiOff } from 'lucide-react';
import { Badge } from '@/components/ui';
import { useChat } from './chat/ChatContext';

const LABELS = {
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  offline: 'Offline',
  error: 'Not connected',
} as const;

/** Shows which chat backend is in use and its live state. The development relay is always labelled. */
export function ConnectionBadge() {
  const { state, transport } = useChat();
  const ok = state === 'connected';
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge tone={ok ? 'success' : state === 'error' || state === 'offline' ? 'danger' : 'neutral'} icon={ok ? <Wifi className="h-3 w-3" aria-hidden /> : <WifiOff className="h-3 w-3" aria-hidden />}>
        {LABELS[state]}
      </Badge>
      {transport?.mode === 'dev-relay' ? (
        <Badge tone="warning" icon={<FlaskConical className="h-3 w-3" aria-hidden />}>
          Development relay · not Nexconn
        </Badge>
      ) : transport?.mode === 'nexconn' ? (
        <Badge tone="primary">Nexconn</Badge>
      ) : null}
    </div>
  );
}
