import { BellRing } from 'lucide-react';
import { Badge, Button, Card, CardHeader, Notice } from '@/components/ui';
import { usePush } from './usePush';

/** Turn push notifications on or off for this device, and send a test. */
export function NotificationsCard() {
  const { config, subscribed, permission, supported, enable, disable, test } = usePush();
  const serverOn = config.data?.enabled ?? false;
  const error = enable.error ?? disable.error ?? test.error;

  return (
    <Card>
      <CardHeader
        icon={<BellRing className="h-5 w-5" aria-hidden />}
        title="Notifications on this device"
        description="SOS alerts, journey updates and Walk Together matches, even when mahilaSathi is closed."
        action={subscribed ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}
      />
      <div className="space-y-3 text-sm">
        {!config.isPending && !serverOn ? (
          <Notice title="Not set up on this server">Push notifications need VAPID keys on the server (see the README). SOS alerts still appear in the app and the circle chat.</Notice>
        ) : !supported ? (
          <Notice title="Not supported in this browser">Use Chrome, Edge or Firefox, or install mahilaSathi to your home screen. SOS alerts still appear in the app while it’s open.</Notice>
        ) : subscribed ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" loading={test.isPending} onClick={() => test.mutate()}>Send a test notification</Button>
            <Button size="sm" variant="ghost" loading={disable.isPending} onClick={() => disable.mutate()}>Turn off on this device</Button>
          </div>
        ) : (
          <Button size="sm" loading={enable.isPending} disabled={permission === 'denied'} onClick={() => enable.mutate()}>Turn on notifications</Button>
        )}
        {permission === 'denied' ? <p className="text-xs text-fg-muted">Notifications are blocked for this site in your browser’s settings.</p> : null}
        {test.data ? <p role="status" className="text-success">{test.data.sent ? `Sent to ${test.data.sent} ${test.data.sent === 1 ? 'device' : 'devices'}.` : 'No device received it.'}</p> : null}
        {error ? <p role="alert" className="text-danger">{error.message}</p> : null}
        <p className="text-xs text-fg-muted">Which notifications you get follows the switches below. Notifications never include your exact location.</p>
      </div>
    </Card>
  );
}
