import type { ProviderStatus } from '@mahilasathi/shared';
import { Activity } from 'lucide-react';
import { Badge, Card, CardHeader, ErrorState, Skeleton, type BadgeTone } from '@/components/ui';
import { useHealth, usePublicConfig, useReadiness } from '@/hooks/useSystem';

const providerLabels = {
  geoapify: 'Place search (Geoapify)',
  nexconn: 'Community chat (Nexconn)',
  otp: 'Phone verification (SMS)',
  push: 'Push notifications',
} as const;

const modeBadge: Record<ProviderStatus['mode'], { tone: BadgeTone; label: string }> = {
  live: { tone: 'success', label: 'Live' },
  'dev-adapter': { tone: 'warning', label: 'Development adapter' },
  disabled: { tone: 'neutral', label: 'Off' },
};

/** Live API, database and integration status. Development adapters are always labelled as such. */
export function SystemStatusCard() {
  const health = useHealth();
  const ready = useReadiness();
  const config = usePublicConfig();
  const pending = health.isPending || ready.isPending || config.isPending;
  const error = health.error ?? ready.error ?? config.error;

  return (
    <Card>
      <CardHeader icon={<Activity className="h-5 w-5" aria-hidden />} title="App status" description="Live checks against the mahilaSathi server" />
      {pending ? (
        <Skeleton className="h-28 w-full" />
      ) : error ? (
        <ErrorState title="Can't reach the server" message={error.message} onRetry={() => void Promise.all([health.refetch(), ready.refetch(), config.refetch()])} />
      ) : (
        <ul className="divide-y divide-border/60 text-sm">
          <Row label={`Server v${health.data!.version}`} badge={{ tone: 'success', label: 'OK' }} />
          <Row label="Database & schema" badge={ready.data!.checks.database.ok && ready.data!.checks.migrations.ok ? { tone: 'success', label: 'OK' } : { tone: 'danger', label: 'Problem' }} />
          <Row
            label={`NCR map data ${ready.data!.checks.geography.datasetVersion ? `(${ready.data!.checks.geography.datasetVersion})` : ''}`}
            badge={ready.data!.checks.geography.ok ? { tone: 'success', label: 'Loaded' } : { tone: 'danger', label: 'Missing' }}
          />
          {(Object.keys(providerLabels) as (keyof typeof providerLabels)[]).map((key) => (
            <Row key={key} label={providerLabels[key]} badge={modeBadge[config.data!.providers[key].mode]} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function Row({ label, badge }: { label: string; badge: { tone: BadgeTone; label: string } }) {
  return (
    <li className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
      <span>{label}</span>
      <Badge tone={badge.tone}>{badge.label}</Badge>
    </li>
  );
}
