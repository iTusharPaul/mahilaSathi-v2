import { useQuery } from '@tanstack/react-query';
import { Crosshair, MapPin, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Spinner, cn } from '@/components/ui';
import { geoApi } from '@/services/geoApi';

export interface PickedPoint {
  lat: number;
  lng: number;
  label: string;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Search box for a start or destination. Device location is used only when the user asks. */
export function LocationInput({
  label,
  value,
  onChange,
  allowCurrentLocation,
}: {
  label: string;
  value: PickedPoint | null;
  onChange: (p: PickedPoint | null) => void;
  allowCurrentLocation?: boolean;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [locError, setLocError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const debounced = useDebounced(query.trim(), 300);
  const search = useQuery({
    queryKey: ['geo', 'search', debounced],
    queryFn: ({ signal }) => geoApi.search(debounced, signal),
    enabled: debounced.length >= 2 && !value,
    staleTime: 5 * 60_000,
  });

  const useCurrent = () => {
    setLocError(null);
    if (!('geolocation' in navigator)) return setLocError('This browser cannot share location.');
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        onChange({ lat: pos.coords.latitude, lng: pos.coords.longitude, label: 'Current location' });
      },
      (err) => {
        setLocating(false);
        setLocError(err.code === 1 ? 'Location permission was denied. Search instead.' : 'Location unavailable. Search instead.');
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  };

  return (
    <div className="relative">
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">{label}</label>
      {value ? (
        <div className="flex h-12 items-center gap-2 rounded-xl border border-primary/40 bg-primary-soft/40 px-3">
          <MapPin className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-[0.95rem]">{value.label}</span>
          <button type="button" onClick={() => { onChange(null); setQuery(''); }} className="rounded-lg p-1 text-fg-muted hover:bg-surface-muted" aria-label={`Clear ${label.toLowerCase()}`}>
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ) : (
        <div className="flex h-12 items-center gap-2 rounded-xl border border-border bg-surface px-3 focus-within:border-primary">
          <MapPin className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
          <input
            id={id}
            className="h-full min-w-0 flex-1 bg-transparent text-[0.95rem] placeholder:text-fg-muted/70 focus:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
            placeholder="Search a place in NCR"
            value={query}
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setTimeout(() => setFocused(false), 150)}
          />
          {allowCurrentLocation ? (
            <button type="button" onClick={useCurrent} className="rounded-lg p-1.5 text-primary hover:bg-primary-soft" aria-label="Use my current location" title="Use my current location">
              {locating ? <Spinner size="sm" label="" /> : <Crosshair className="h-4 w-4" aria-hidden />}
            </button>
          ) : null}
        </div>
      )}
      {locError ? <p role="alert" className="mt-1 text-xs text-danger">{locError}</p> : null}
      {!value && focused && debounced.length >= 2 ? (
        <div className="absolute inset-x-0 top-full z-20 mt-1 max-h-72 overflow-auto rounded-2xl border border-border bg-surface shadow-raised">
          {search.isPending ? (
            <div className="flex justify-center p-3 text-primary"><Spinner size="sm" /></div>
          ) : search.isError ? (
            <p className="p-3 text-sm text-danger">{search.error.message}</p>
          ) : search.data.results.length === 0 ? (
            <p className="p-3 text-sm text-fg-muted">No matching places in NCR.{search.data.outsideNcrHidden ? ` ${search.data.outsideNcrHidden} result(s) outside NCR were hidden.` : ''}</p>
          ) : (
            <ul>
              {search.data.results.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    aria-label={[r.label, r.secondary].filter(Boolean).join(', ')}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onChange({ lat: r.lat, lng: r.lng, label: r.label })}
                    className={cn('flex w-full items-start gap-2.5 px-3.5 py-2.5 text-left hover:bg-surface-muted')}
                  >
                    <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{r.label}</span>
                      {r.secondary ? <span className="block truncate text-xs text-fg-muted">{r.secondary}</span> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
