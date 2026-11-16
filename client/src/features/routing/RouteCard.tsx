import { FACTOR_LABELS, type ScoredRoute } from '@mahilasathi/shared';
import { ChevronDown, Clock, Footprints, Route as RouteIcon, ShieldCheck, Store, TrainFront } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Badge, cn, type BadgeTone } from '@/components/ui';

const CONFIDENCE: Record<ScoredRoute['confidence'], { tone: BadgeTone; label: string }> = {
  high: { tone: 'success', label: 'High confidence' },
  medium: { tone: 'primary', label: 'Medium confidence' },
  low: { tone: 'neutral', label: 'Low confidence' },
};

const fmtDistance = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
const fmtDuration = (s: number) => {
  const min = Math.round(s / 60);
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
};
const fmtTime = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(Date.parse(iso)) : null;

function ScoreDial({ score }: { score: number | null }) {
  return (
    <div className={cn('flex h-16 w-16 shrink-0 flex-col items-center justify-center rounded-2xl', score === null ? 'bg-surface-muted text-fg-muted' : 'bg-primary text-primary-fg')}>
      <span className="text-2xl font-semibold leading-none">{score ?? '—'}</span>
      <span className="mt-0.5 text-[0.6rem] uppercase tracking-wide opacity-80">/ 100</span>
    </div>
  );
}

export function RouteCard({ route, selected, onSelect, mode, action }: { route: ScoredRoute; selected: boolean; onSelect: () => void; mode: 'walk' | 'drive'; action?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const m = route.metrics;
  const conf = CONFIDENCE[route.confidence];
  const stats = [
    { icon: Clock, text: `${fmtDuration(route.durationS)} · ${fmtDistance(route.distanceM)}` },
    { icon: RouteIcon, text: `${route.turns} turns${m.mainRoadPct !== null ? ` · ${m.mainRoadPct}% main roads` : ''}` },
    { icon: Store, text: m.openEstablishments !== null && m.hoursKnown ? `${m.openEstablishments} open (of ${m.hoursKnown} with known hours)` : m.mappedEstablishments ? `${m.mappedEstablishments} places mapped, hours unknown` : 'Open places: no data' },
    { icon: Footprints, text: m.longestLowActivityM !== null ? `Longest low-activity stretch ${fmtDistance(m.longestLowActivityM)}` : 'Low-activity stretch: no data' },
    { icon: TrainFront, text: m.transitStops !== null ? `${m.transitStops} transit stops nearby` : 'Transit: no data' },
    { icon: ShieldCheck, text: m.assistancePoints !== null ? `${m.assistancePoints} police, hospitals or fuel stations nearby` : 'Assistance points: no data' },
  ];

  return (
    <article
      className={cn('rounded-2xl border bg-surface p-4 shadow-card transition-colors', selected ? 'border-primary ring-1 ring-primary/40' : 'border-border/70')}
      aria-label={`${route.label}, Night Activity Score ${route.score ?? 'not available'}`}
    >
      <button type="button" onClick={onSelect} className="flex w-full items-start gap-3 text-left" aria-pressed={selected}>
        <ScoreDial score={route.score} />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{route.label} <span className="font-normal text-fg-muted">· {route.variant}</span></p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Badge tone={conf.tone}>{conf.label}</Badge>
            {route.synthetic ? <Badge tone="warning">Synthetic, not real roads</Badge> : null}
            <Badge>{mode === 'walk' ? 'Walking' : 'Cab / drive'}</Badge>
          </div>
        </div>
      </button>

      <ul className="mt-3 grid gap-1.5 text-sm text-fg-muted">
        {stats.map(({ icon: Icon, text }) => (
          <li key={text} className="flex items-start gap-2"><Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{text}</li>
        ))}
      </ul>

      {route.reasons.length ? (
        <ul className="mt-3 space-y-1 border-t border-border/60 pt-3 text-sm">
          {route.reasons.map((r) => <li key={r} className="flex gap-2"><span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />{r}</li>)}
        </ul>
      ) : null}

      {route.jurisdictions.length > 1 ? (
        <p className="mt-2 text-xs text-fg-muted">Via {route.jurisdictions.map((j) => j.districtName).filter((d, i, a) => a.indexOf(d) === i).join(' → ')}</p>
      ) : null}

      {action ? <div className="mt-3">{action}</div> : null}

      <button type="button" onClick={() => setOpen((v) => !v)} className="mt-3 flex items-center gap-1 text-sm font-medium text-primary" aria-expanded={open}>
        How this score was worked out <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open ? (
        <ul className="mt-2 space-y-3">
          {route.factors.map((f) => (
            <li key={f.key} className="rounded-xl bg-surface-muted/60 p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{FACTOR_LABELS[f.key]}</span>
                <span className="text-xs text-fg-muted">{f.score === null ? 'Not counted' : `${Math.round(f.score * 100)} · weight ${Math.round(f.appliedWeight * 100)}%`}</span>
              </div>
              {f.score !== null ? (
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-border" aria-hidden>
                  <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round(f.score * 100)}%` }} />
                </div>
              ) : null}
              <p className="mt-1.5">{f.raw}</p>
              <p className="mt-0.5 text-xs text-fg-muted">{f.explanation}</p>
              <p className="mt-1 text-[0.7rem] text-fg-muted">
                {f.source} · {f.confidence} confidence{fmtTime(f.dataTimestamp) ? ` · data from ${fmtTime(f.dataTimestamp)}` : ''}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}
