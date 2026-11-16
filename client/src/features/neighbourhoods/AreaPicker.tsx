import type { GeoSearchResult, Resolution } from '@mahilasathi/shared';
import { useQuery } from '@tanstack/react-query';
import { Check, Crosshair, MapPin, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Notice, Spinner, TextField, cn } from '@/components/ui';
import { geoApi } from '@/services/geoApi';
import { CoverageBadge } from './CoverageBadge';

export type AreaChoice =
  | { kind: 'neighbourhood'; id: string; label: string }
  | { kind: 'district'; id: string; label: string };

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

type LocateState = { status: 'idle' } | { status: 'locating' } | { status: 'error'; message: string };

const GEO_ERRORS: Record<number, string> = {
  1: 'Location permission was denied. You can search for your area instead.',
  2: 'Your location could not be determined. Try searching for your area.',
  3: 'Finding your location took too long. Try again or search instead.',
};

/**
 * Lets the user pick a home area by search, by one-off device location, or from a list. Only the
 * chosen area's id is saved; coordinates are used once to resolve the area and then discarded.
 */
export function AreaPicker({ onChange, value }: { onChange: (choice: AreaChoice | null) => void; value: AreaChoice | null }) {
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query.trim(), 300);
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(null);
  const [locate, setLocate] = useState<LocateState>({ status: 'idle' });
  const [browseDistrict, setBrowseDistrict] = useState<string>('');

  const search = useQuery({
    queryKey: ['geo', 'search', debounced],
    queryFn: ({ signal }) => geoApi.search(debounced, signal),
    enabled: debounced.length >= 2,
    staleTime: 5 * 60_000,
  });

  const resolution = useQuery({
    queryKey: ['geo', 'resolve', point?.lat, point?.lng],
    queryFn: () => geoApi.resolve(point!.lat, point!.lng),
    enabled: point !== null,
  });

  const nearby = useQuery({
    queryKey: ['geo', 'near', point?.lat, point?.lng],
    queryFn: () => geoApi.neighbourhoods({ near: point!, limit: 5 }),
    enabled: point !== null && resolution.data?.inNcr === true,
  });

  const districts = useQuery({ queryKey: ['geo', 'districts'], queryFn: geoApi.districts, staleTime: Infinity });
  const browse = useQuery({
    queryKey: ['geo', 'neighbourhoods', browseDistrict],
    queryFn: () => geoApi.neighbourhoods({ districtId: browseDistrict }),
    enabled: browseDistrict !== '',
  });

  // Auto-select the confidently resolved area.
  useEffect(() => {
    const r = resolution.data;
    if (!r?.inNcr || r.needsManualConfirmation) return;
    if (r.neighbourhood) onChange({ kind: 'neighbourhood', id: r.neighbourhood.id, label: r.neighbourhood.name });
    else if (r.district) onChange({ kind: 'district', id: r.district.id, label: r.district.name });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolution.data]);

  const pickResult = (r: GeoSearchResult) => {
    setQuery('');
    setPoint({ lat: r.lat, lng: r.lng });
    if (r.neighbourhoodId) onChange({ kind: 'neighbourhood', id: r.neighbourhoodId, label: r.label });
    else onChange(null);
  };

  const useMyLocation = () => {
    if (!('geolocation' in navigator)) {
      setLocate({ status: 'error', message: 'This browser cannot share location. Search for your area instead.' });
      return;
    }
    setLocate({ status: 'locating' });
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocate({ status: 'idle' });
        onChange(null);
        setPoint({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      (err) => setLocate({ status: 'error', message: GEO_ERRORS[err.code] ?? GEO_ERRORS[2]! }),
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 5 * 60_000 },
    );
  };

  return (
    <div className="space-y-4">
      <TextField
        label="Search your area"
        placeholder="e.g. Saket, Cyber City, Indirapuram"
        leading={<Search className="h-4 w-4" aria-hidden />}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoComplete="off"
        hint={search.data?.provider.mode === 'dev-adapter' ? 'Searching mahilaSathi’s NCR area list (street-level search is not configured).' : undefined}
      />

      {debounced.length >= 2 ? (
        <div className="rounded-2xl border border-border/70 bg-surface">
          {search.isPending ? (
            <div className="flex justify-center p-4 text-primary"><Spinner /></div>
          ) : search.isError ? (
            <p className="p-4 text-sm text-danger">{search.error.message}</p>
          ) : search.data.results.length === 0 ? (
            <p className="p-4 text-sm text-fg-muted">No matching places in NCR. Try a nearby landmark or choose from the list below.</p>
          ) : (
            <ul className="divide-y divide-border/60">
              {search.data.results.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => pickResult(r)}
                    aria-label={[r.label, r.secondary].filter(Boolean).join(', ')}
                    className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-surface-muted"
                  >
                    <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                    <span className="min-w-0">
                      <span className="block font-medium">{r.label}</span>
                      {r.secondary ? <span className="block truncate text-xs text-fg-muted">{r.secondary}</span> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {search.data?.degraded ? <p className="border-t border-border/60 px-4 py-2 text-xs text-fg-muted">Live search is unavailable right now; showing mahilaSathi’s area list.</p> : null}
          {search.data && search.data.outsideNcrHidden > 0 ? (
            <p className="border-t border-border/60 px-4 py-2 text-xs text-fg-muted">{search.data.outsideNcrHidden} result(s) outside NCR were hidden.</p>
          ) : null}
        </div>
      ) : null}

      <div className="rounded-2xl bg-surface-muted/70 p-3.5">
        <Button variant="secondary" fullWidth icon={<Crosshair className="h-4 w-4" aria-hidden />} onClick={useMyLocation} loading={locate.status === 'locating'}>
          Use my current location
        </Button>
        <p className="mt-2 text-xs text-fg-muted">
          Your browser will ask first. We use your location once to find your area and don’t store the coordinates.
        </p>
        {locate.status === 'error' ? <p role="alert" className="mt-2 text-sm text-danger">{locate.message}</p> : null}
      </div>

      {point ? <ResolutionCard resolution={resolution.data} loading={resolution.isPending} error={resolution.error?.message} /> : null}

      {resolution.data?.inNcr && (resolution.data.needsManualConfirmation || !resolution.data.neighbourhood) ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">Choose the closest match</p>
          <ChoiceList
            value={value}
            onChange={onChange}
            options={[
              ...(nearby.data?.neighbourhoods ?? []).map((n) => ({ kind: 'neighbourhood' as const, id: n.id, label: n.name, detail: n.city?.name ?? n.district.name })),
              ...(resolution.data.district ? [{ kind: 'district' as const, id: resolution.data.district.id, label: `${resolution.data.district.name} (district only)`, detail: resolution.data.state?.name ?? '' }] : []),
            ]}
          />
        </div>
      ) : null}

      <details className="group rounded-2xl border border-border/70 bg-surface p-3.5" open={browseDistrict !== ''}>
        <summary className="cursor-pointer select-none text-sm font-medium">Choose from a list instead</summary>
        <div className="mt-3 space-y-3">
          <label className="block text-sm">
            <span className="mb-1.5 block text-fg-muted">District</span>
            <select
              className="h-11 w-full rounded-xl border border-border bg-surface px-3"
              value={browseDistrict}
              onChange={(e) => setBrowseDistrict(e.target.value)}
            >
              <option value="">Select a district…</option>
              {Object.entries(
                (districts.data?.districts ?? []).reduce<Record<string, { id: string; name: string }[]>>((acc, d) => {
                  (acc[d.state.name] ??= []).push(d);
                  return acc;
                }, {}),
              ).map(([state, list]) => (
                <optgroup key={state} label={state}>
                  {list.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          {browseDistrict ? (
            browse.isPending ? (
              <Spinner />
            ) : (
              <ChoiceList
                value={value}
                onChange={onChange}
                options={[
                  ...(browse.data?.neighbourhoods ?? []).map((n) => ({ kind: 'neighbourhood' as const, id: n.id, label: n.name, detail: n.city?.name ?? '' })),
                  {
                    kind: 'district' as const,
                    id: browseDistrict,
                    label: `${districts.data?.districts.find((d) => d.id === browseDistrict)?.name ?? 'This district'} (district only)`,
                    detail: 'No specific neighbourhood',
                  },
                ]}
              />
            )
          ) : null}
        </div>
      </details>
    </div>
  );
}

function ResolutionCard({ resolution, loading, error }: { resolution: Resolution | undefined; loading: boolean; error?: string }) {
  if (loading) return <div className="flex justify-center p-4 text-primary"><Spinner /></div>;
  if (error) return <p role="alert" className="text-sm text-danger">{error}</p>;
  if (!resolution) return null;
  if (!resolution.inNcr) return <Notice tone="warning" title="Outside NCR">{resolution.message}</Notice>;
  return (
    <div className="rounded-2xl border border-border/70 bg-surface p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">We found</p>
      <p className="mt-1 text-lg font-semibold">{resolution.neighbourhood?.name ?? resolution.district?.name}</p>
      <p className="text-sm text-fg-muted">
        {[resolution.neighbourhood ? resolution.city?.name ?? resolution.district?.name : null, resolution.state?.name].filter(Boolean).join(', ')}
      </p>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <CoverageBadge coverage={resolution.coverage} />
        {resolution.needsManualConfirmation ? <Badge tone="warning">Please confirm</Badge> : null}
      </div>
      {resolution.message ? <p className="mt-2.5 text-sm text-fg-muted">{resolution.message}</p> : null}
    </div>
  );
}

function ChoiceList({
  options,
  value,
  onChange,
}: {
  options: (AreaChoice & { detail: string })[];
  value: AreaChoice | null;
  onChange: (c: AreaChoice) => void;
}) {
  return (
    <ul className="space-y-1.5" role="radiogroup">
      {options.map((o) => {
        const selected = value?.kind === o.kind && value.id === o.id;
        return (
          <li key={`${o.kind}:${o.id}`}>
            <button
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange({ kind: o.kind, id: o.id, label: o.label })}
              className={cn(
                'flex w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors',
                selected ? 'border-primary bg-primary-soft/60' : 'border-border/70 bg-surface hover:bg-surface-muted',
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{o.label}</span>
                {o.detail ? <span className="block text-xs text-fg-muted">{o.detail}</span> : null}
              </span>
              {selected ? <Check className="h-4 w-4 text-primary" aria-hidden /> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
