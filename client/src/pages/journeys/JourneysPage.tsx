import type { SharedTrip, Trip } from '@mahilasathi/shared';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Compass, Eye, History, Map } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { STATUS_META, clock, dayClock } from '@/features/journeys/format';
import { journeysApi } from '@/services/journeysApi';

export const journeysKey = ['journeys'] as const;

export function JourneysPage() {
  const active = useQuery({ queryKey: [...journeysKey, 'active'], queryFn: journeysApi.active, refetchInterval: 30_000 });
  const shared = useQuery({ queryKey: [...journeysKey, 'shared'], queryFn: journeysApi.sharedWithMe, refetchInterval: 20_000 });
  const history = useQuery({ queryKey: [...journeysKey, 'list'], queryFn: journeysApi.list });
  const past = (history.data?.trips ?? []).filter((t) => t.id !== active.data?.trip?.id).slice(0, 10);

  return (
    <div className="space-y-5">
      <PageHeader title="Journeys" description="Your trips, and the ones your Guardian Circle shared with you." />

      <section aria-labelledby="active-heading" className="space-y-2">
        <h2 id="active-heading" className="sr-only">Current journey</h2>
        {active.isPending ? <Skeleton className="h-28 w-full" /> : null}
        {active.isError ? <ErrorState message={active.error.message} onRetry={() => void active.refetch()} /> : null}
        {active.data?.trip ? <ActiveCard trip={active.data.trip} /> : null}
        {active.data && !active.data.trip ? (
          <Card>
            <EmptyState
              icon={<Compass className="h-7 w-7" aria-hidden />}
              title="No journey in progress"
              description="Plan a route, then start it to share progress with your Guardian Circle and check in along the way."
              action={<Link to="/plan"><Button icon={<Map className="h-4 w-4" aria-hidden />}>Plan a journey</Button></Link>}
            />
          </Card>
        ) : null}
      </section>

      <Card>
        <CardHeader icon={<Eye className="h-5 w-5" aria-hidden />} title="Shared with me" description="Journeys that people in your Guardian Circles are sharing with you." />
        {shared.isPending ? <Skeleton className="h-16 w-full" /> : null}
        {shared.isError ? <ErrorState message={shared.error.message} onRetry={() => void shared.refetch()} /> : null}
        {shared.data?.trips.length === 0 ? <p className="text-sm text-fg-muted">Nothing shared with you right now.</p> : null}
        <ul className="divide-y divide-border/60">
          {shared.data?.trips.map((t) => <SharedRow key={t.shareId} trip={t} />)}
        </ul>
      </Card>

      {past.length ? (
        <Card>
          <CardHeader icon={<History className="h-5 w-5" aria-hidden />} title="Recent journeys" />
          <ul className="divide-y divide-border/60">
            {past.map((t) => (
              <li key={t.id}>
                <Link to={`/journeys/${t.id}`} className="flex items-center gap-3 py-2.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{t.destinationLabel ?? t.route.label}</p>
                    <p className="text-xs text-fg-muted">{dayClock(t.createdAt)} · {t.mode === 'walk' ? 'Walk' : 'Cab / drive'}</p>
                  </div>
                  <Badge tone={STATUS_META[t.status].tone}>{STATUS_META[t.status].label}</Badge>
                  <ChevronRight className="h-4 w-4 text-fg-muted" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

function ActiveCard({ trip }: { trip: Trip }) {
  const meta = STATUS_META[trip.status];
  return (
    <Link to={`/journeys/${trip.id}`} className="block rounded-2xl border border-primary/40 bg-surface p-4 shadow-card ring-1 ring-primary/20">
      <div className="flex items-center justify-between gap-2">
        <Badge tone={meta.tone}>{meta.label}</Badge>
        {trip.locationSharing ? <Badge tone="primary" icon={<span className="h-2 w-2 animate-pulse rounded-full bg-primary" aria-hidden />}>Sharing location</Badge> : null}
      </div>
      <p className="mt-2 text-lg font-semibold">{trip.destinationLabel ?? 'Your journey'}</p>
      <p className="text-sm text-fg-muted">
        {trip.status === 'CREATED' ? `Planned for ${clock(trip.departureTime)}` : `Expected by ${clock(trip.expectedArrivalAt)}`}
        {trip.shares.some((s) => s.active) ? ' · shared with your circle' : ' · private'}
      </p>
      <p className="mt-3 flex items-center gap-1 text-sm font-medium text-primary">Open journey <ChevronRight className="h-4 w-4" aria-hidden /></p>
    </Link>
  );
}

function SharedRow({ trip }: { trip: SharedTrip }) {
  const meta = STATUS_META[trip.status];
  return (
    <li>
      <Link to={`/journeys/shared/${trip.shareId}`} className="flex items-center gap-3 py-2.5 text-sm">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{trip.travellerName}{trip.destinationArea ? ` → ${trip.destinationArea}` : ''}</p>
          <p className="text-xs text-fg-muted">
            {trip.arrivedAt ? `Arrived ${clock(trip.arrivedAt)}` : trip.expectedArrivalAt ? `Expected by ${clock(trip.expectedArrivalAt)}` : 'Not started yet'}
          </p>
        </div>
        <Badge tone={meta.tone}>{meta.label}</Badge>
        <ChevronRight className="h-4 w-4 text-fg-muted" aria-hidden />
      </Link>
    </li>
  );
}
