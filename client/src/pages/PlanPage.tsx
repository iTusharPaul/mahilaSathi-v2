import { RANKINGS, type Ranking, type RoutePlan, type TravelMode } from '@mahilasathi/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowUpDown, Car, Compass, Footprints, Info } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { Suspense, lazy, useMemo, useState, type FormEvent } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge, Button, ErrorState, Notice, Skeleton, cn } from '@/components/ui';
import { LocationInput, type PickedPoint } from '@/features/routing/LocationInput';
import { RouteCard } from '@/features/routing/RouteCard';
import { usePublicConfig } from '@/hooks/useSystem';
import { ApiRequestError } from '@/services/apiClient';
import { journeysApi } from '@/services/journeysApi';
import { routesApi } from '@/services/routesApi';

// MapLibre is large: load it only when there are routes to show.
const RouteMap = lazy(() => import('@/features/routing/RouteMap').then((m) => ({ default: m.RouteMap })));

const RANKING_LABELS: Record<Ranking, string> = { score: 'Highest score', fastest: 'Fastest', balanced: 'Balanced' };

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function PlanPage() {
  const config = usePublicConfig();
  const [origin, setOrigin] = useState<PickedPoint | null>(null);
  const [destination, setDestination] = useState<PickedPoint | null>(null);
  const [departure, setDeparture] = useState(() => toLocalInput(new Date()));
  const [mode, setMode] = useState<TravelMode>('drive');
  const [fewerIsolatedStretches, setFewerIsolated] = useState(false);
  const [preferMainRoads, setPreferMainRoads] = useState(false);
  const [ranking, setRanking] = useState<Ranking>('score');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const plan = useMutation({
    mutationFn: () =>
      routesApi.plan({
        origin: origin!,
        destination: destination!,
        departureTime: new Date(departure).toISOString(),
        mode,
        preferences: { fewerIsolatedStretches, preferMainRoads },
      }),
    onSuccess: (p) => {
      setSelectedId(p.rankings.score[0] ?? null);
      setRanking('score');
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (origin && destination) plan.mutate();
  };

  return (
    <div className="space-y-5">
      <PageHeader title="Plan a journey" description="Compare routes by how active they are likely to be when you travel." />

      <form onSubmit={submit} className="space-y-3.5 rounded-2xl border border-border/70 bg-surface p-4 shadow-card">
        <LocationInput label="From" value={origin} onChange={setOrigin} allowCurrentLocation />
        <LocationInput label="To" value={destination} onChange={setDestination} />
        <div className="grid grid-cols-2 gap-2.5">
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium">Leaving at</span>
            <input type="datetime-local" className="h-12 w-full rounded-xl border border-border bg-surface px-3" value={departure} onChange={(e) => setDeparture(e.target.value)} required />
          </label>
          <fieldset className="text-sm">
            <legend className="mb-1.5 font-medium">Travelling by</legend>
            <div className="grid h-12 grid-cols-2 gap-1 rounded-xl bg-surface-muted p-1">
              {([['drive', 'Cab', Car], ['walk', 'Walk', Footprints]] as const).map(([value, label, Icon]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={mode === value}
                  onClick={() => setMode(value)}
                  className={cn('flex items-center justify-center gap-1.5 rounded-lg text-sm font-medium transition-colors', mode === value ? 'bg-surface text-primary shadow-sm' : 'text-fg-muted')}
                >
                  <Icon className="h-4 w-4" aria-hidden />{label}
                </button>
              ))}
            </div>
          </fieldset>
        </div>
        <div className="space-y-1.5 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" className="h-4 w-4 accent-[rgb(var(--color-primary))]" checked={fewerIsolatedStretches} onChange={(e) => setFewerIsolated(e.target.checked)} />Prefer fewer isolated stretches</label>
          <label className="flex items-center gap-2"><input type="checkbox" className="h-4 w-4 accent-[rgb(var(--color-primary))]" checked={preferMainRoads} onChange={(e) => setPreferMainRoads(e.target.checked)} />Prefer main roads</label>
        </div>
        <Button type="submit" size="lg" fullWidth loading={plan.isPending} disabled={!origin || !destination}>
          {plan.isPending ? 'Checking routes…' : 'Compare routes'}
        </Button>
        {plan.isPending ? <p className="text-center text-xs text-fg-muted">Looking up places along each route. The first search in an area can take up to 20 seconds.</p> : null}
      </form>

      {plan.isError ? <ErrorState title="Couldn’t plan this journey" message={plan.error.message} onRetry={() => plan.mutate()} retrying={plan.isPending} /> : null}
      {plan.data ? (
        <Results plan={plan.data} ranking={ranking} setRanking={setRanking} selectedId={selectedId} setSelectedId={setSelectedId} tiles={config.data?.providers.geoapify.mode === 'live'} />
      ) : null}
    </div>
  );
}

function Results({
  plan,
  ranking,
  setRanking,
  selectedId,
  setSelectedId,
  tiles,
}: {
  plan: RoutePlan;
  ranking: Ranking;
  setRanking: (r: Ranking) => void;
  selectedId: string | null;
  setSelectedId: (id: string) => void;
  tiles: boolean;
}) {
  const ordered = useMemo(() => {
    const byId = new Map(plan.routes.map((r) => [r.id, r]));
    return plan.rankings[ranking].map((id) => byId.get(id)!).filter(Boolean);
  }, [plan, ranking]);

  return (
    <section className="space-y-4" aria-label="Route options">
      <Suspense fallback={<Skeleton className="h-72 w-full" />}>
        <RouteMap routes={plan.routes} selectedId={selectedId} tiles={tiles} onSelect={setSelectedId} />
      </Suspense>
      <p className="text-xs text-fg-muted">Tap a route on the map to select it, or a dot to see the place. Green dots are open when you pass.{tiles ? '' : ' Map tiles need a Geoapify key; routes are drawn without a base map.'}</p>

      {plan.notices.map((n) => <Notice key={n} tone={/synthetic|could not|unavailable/i.test(n) ? 'warning' : 'info'}>{n}</Notice>)}

      {plan.routes.length > 1 ? (
        <div className="flex items-center gap-2" role="tablist" aria-label="Sort routes">
          <ArrowUpDown className="h-4 w-4 text-fg-muted" aria-hidden />
          {RANKINGS.map((r) => (
            <button key={r} type="button" role="tab" aria-selected={ranking === r} onClick={() => setRanking(r)} className={cn('rounded-full px-3 py-1.5 text-sm font-medium', ranking === r ? 'bg-primary text-primary-fg' : 'bg-surface-muted text-fg-muted')}>
              {RANKING_LABELS[r]}
            </button>
          ))}
        </div>
      ) : null}

      <div className="space-y-3">
        {ordered.map((r) => <RouteCard key={r.id} route={r} mode={plan.mode} selected={r.id === selectedId} onSelect={() => setSelectedId(r.id)} action={r.id === selectedId ? <StartJourney plan={plan} routeId={r.id} /> : null} />)}
      </div>

      <div className="flex items-start gap-2 rounded-2xl bg-surface-muted/70 p-3.5 text-xs text-fg-muted">
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div className="space-y-1">
          <p>{plan.disclaimer}</p>
          <p>
            Data: routes by <Badge>{plan.providers.routing.mode === 'live' ? 'Geoapify' : 'synthetic'}</Badge> places {plan.providers.places.status === 'unavailable' ? 'unavailable' : `from OpenStreetMap via Geoapify${plan.providers.places.cached ? ' (cached)' : ''}`}.
          </p>
        </div>
      </div>
    </section>
  );
}

/** Turns the selected route into a tracked journey. Sharing follows the Profile default unless changed on the journey. */
function StartJourney({ plan, routeId }: { plan: RoutePlan; routeId: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const start = useMutation({
    mutationFn: () =>
      journeysApi.create({
        routeId,
        ...(plan.origin.label ? { originLabel: plan.origin.label.slice(0, 120) } : {}),
        ...(plan.destination.label ? { destinationLabel: plan.destination.label.slice(0, 120) } : {}),
      }),
    onSuccess: (trip) => {
      void qc.invalidateQueries({ queryKey: ['journeys'] });
      navigate(`/journeys/${trip.id}`);
    },
  });
  const inProgress = start.error instanceof ApiRequestError && start.error.code === 'CONFLICT';
  return (
    <div className="space-y-2">
      <Button fullWidth icon={<Compass className="h-4 w-4" aria-hidden />} loading={start.isPending} onClick={() => start.mutate()}>
        Start this journey
      </Button>
      {start.isError ? (
        <p role="alert" className="text-sm text-danger">
          {start.error.message} {inProgress ? <Link to="/journeys" className="font-medium underline">Go to your journey</Link> : null}
        </p>
      ) : null}
    </div>
  );
}
