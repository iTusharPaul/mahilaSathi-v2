import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Eye, MapPin, MessageCircle } from 'lucide-react';
import { Suspense, lazy } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Badge, Button, Card, ErrorState, Notice, Skeleton } from '@/components/ui';
import { SHARE_LEVEL_META, STATUS_META, clock } from '@/features/journeys/format';
import { usePublicConfig } from '@/hooks/useSystem';
import { journeysApi } from '@/services/journeysApi';
import { journeysKey } from './JourneysPage';

const RouteMap = lazy(() => import('@/features/routing/RouteMap').then((m) => ({ default: m.RouteMap })));

/** What a Guardian sees. The server decides the detail; this page only renders what it is given. */
export function SharedJourneyPage() {
  const { shareId = '' } = useParams();
  const qc = useQueryClient();
  const config = usePublicConfig();
  const key = [...journeysKey, 'shared', shareId];
  const trip = useQuery({ queryKey: key, queryFn: () => journeysApi.shared(shareId), refetchInterval: 20_000 });
  const ack = useMutation({ mutationFn: () => journeysApi.acknowledge(shareId), onSuccess: (t) => qc.setQueryData(key, t) });

  if (trip.isPending) return <Skeleton className="h-80 w-full" />;
  if (trip.isError) return <ErrorState title="This journey isn’t available" message="It may have ended more than 12 hours ago, or it’s no longer shared with you." />;
  const t = trip.data;
  const meta = STATUS_META[t.status];
  const ended = t.status === 'ARRIVED' || t.status === 'CANCELLED';
  const marker = t.lastLocation?.lat != null && t.lastLocation.lng != null ? ([t.lastLocation.lng, t.lastLocation.lat] as [number, number]) : null;

  return (
    <div className="space-y-4">
      <Link to="/journeys" className="inline-flex items-center gap-1 text-sm font-medium text-primary"><ArrowLeft className="h-4 w-4" aria-hidden />Journeys</Link>
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={meta.tone}>{meta.label}</Badge>
          <Badge icon={<Eye className="h-3 w-3" aria-hidden />}>{SHARE_LEVEL_META[t.level].label} sharing</Badge>
        </div>
        <h1 className="mt-2 text-2xl font-semibold">{t.travellerName}’s journey</h1>
        <p className="text-sm text-fg-muted">{t.destinationArea ? `Heading to ${t.destinationArea}` : 'Destination area not shared'} · {t.mode === 'walk' ? 'walking' : 'by cab / car'}</p>
      </header>

      {t.status === 'DELAYED' ? (
        <Notice tone="warning" title={`${t.travellerName} is running late`}>They were expected by {clock(t.expectedArrivalAt)}. Try reaching them in your circle chat or by phone.</Notice>
      ) : null}
      {t.status === 'ESCALATED' ? (
        <Notice tone="warning" title={`${t.travellerName} asked the circle for help`}>Contact them now. If you believe they are in danger, call <a href="tel:112" className="font-semibold underline">112</a>.</Notice>
      ) : null}

      <Card>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div><dt className="text-xs text-fg-muted">Started</dt><dd className="font-medium">{t.startedAt ? clock(t.startedAt) : 'Not yet'}</dd></div>
          {!ended ? <div><dt className="text-xs text-fg-muted">Expected by</dt><dd className="font-medium">{clock(t.expectedArrivalAt)}</dd></div> : null}
          <div><dt className="text-xs text-fg-muted">Last check-in</dt><dd className="font-medium">{clock(t.lastCheckinAt)}</dd></div>
          {t.arrivedAt ? <div><dt className="text-xs text-fg-muted">Arrived</dt><dd className="font-medium text-success">{clock(t.arrivedAt)}</dd></div> : null}
        </dl>

        {t.progressPct !== null ? (
          <div className="mt-4">
            <p className="text-xs text-fg-muted">About {t.progressPct}% of the way</p>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-border" role="progressbar" aria-valuenow={t.progressPct} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, t.progressPct)}%` }} />
            </div>
          </div>
        ) : null}

        {t.lastLocation ? (
          <p className="mt-3 flex items-center gap-1.5 text-sm"><MapPin className="h-4 w-4 text-primary" aria-hidden />{t.lastLocation.areaName ? `Near ${t.lastLocation.areaName}` : 'Location shared'} · {clock(t.lastLocation.recordedAt)}</p>
        ) : !ended && t.level !== 'status' ? (
          <p className="mt-3 text-sm text-fg-muted">Live location is off for this journey.</p>
        ) : null}
      </Card>

      {t.route ? (
        <Suspense fallback={<Skeleton className="h-72 w-full" />}>
          <RouteMap routes={[{ id: t.id, geometry: t.route.geometry, places: [] }]} selectedId={t.id} tiles={config.data?.providers.geoapify.mode === 'live'} marker={marker} label={`Map of ${t.travellerName}’s route and latest position`} />
        </Suspense>
      ) : null}

      {!ended ? (
        t.acknowledged ? (
          <p className="flex items-center gap-1.5 text-sm text-success"><CheckCircle2 className="h-4 w-4" aria-hidden />You told {t.travellerName} you’re keeping an eye on this journey.</p>
        ) : (
          <Button fullWidth loading={ack.isPending} onClick={() => ack.mutate()}>I’m keeping an eye on this</Button>
        )
      ) : null}
      {ack.isError ? <p role="alert" className="text-sm text-danger">{ack.error.message}</p> : null}

      <Link to="/circle" className="flex items-center gap-1.5 text-sm font-medium text-primary"><MessageCircle className="h-4 w-4" aria-hidden />Open your circle chat</Link>
    </div>
  );
}
