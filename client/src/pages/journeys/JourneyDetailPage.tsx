import { SHARE_LEVELS, type ShareLevel, type Trip, type WalkMatch } from '@mahilasathi/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Footprints, Frown, MapPin, ShieldAlert, Smile, Users } from 'lucide-react';
import { Suspense, lazy, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Badge, Button, Card, CardHeader, ErrorState, Notice, Skeleton, cn } from '@/components/ui';
import { SHARE_LEVEL_META, STATUS_META, UNDERWAY, clock, dayClock, minutesFromNow } from '@/features/journeys/format';
import { useLiveLocation } from '@/features/journeys/useLiveLocation';
import { usePublicConfig } from '@/hooks/useSystem';
import { communityApi } from '@/services/communityApi';
import { journeysApi } from '@/services/journeysApi';
import { journeysKey } from './JourneysPage';

const RouteMap = lazy(() => import('@/features/routing/RouteMap').then((m) => ({ default: m.RouteMap })));

const fmtDistance = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

export function JourneyDetailPage() {
  const { tripId = '' } = useParams();
  const qc = useQueryClient();
  const config = usePublicConfig();
  const key = [...journeysKey, 'trip', tripId];
  const trip = useQuery({ queryKey: key, queryFn: () => journeysApi.get(tripId), refetchInterval: (q) => (q.state.data && !q.state.data.endedAt ? 30_000 : false) });
  const update = (t: Trip) => {
    qc.setQueryData(key, t);
    void qc.invalidateQueries({ queryKey: [...journeysKey, 'active'] });
    void qc.invalidateQueries({ queryKey: [...journeysKey, 'list'] });
  };

  if (trip.isPending) return <Skeleton className="h-96 w-full" />;
  if (trip.isError) return <ErrorState title="Couldn’t load this journey" message={trip.error.message} onRetry={() => void trip.refetch()} />;
  const t = trip.data;
  const meta = STATUS_META[t.status];
  const mapRoute = { id: t.id, geometry: t.route.geometry, places: [] };

  return (
    <div className="space-y-4">
      <Link to="/journeys" className="inline-flex items-center gap-1 text-sm font-medium text-primary"><ArrowLeft className="h-4 w-4" aria-hidden />Journeys</Link>
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={meta.tone}>{meta.label}</Badge>
          <Badge>{t.mode === 'walk' ? 'Walking' : 'Cab / drive'}</Badge>
          {t.locationSharing ? <Badge tone="primary" icon={<span className="h-2 w-2 animate-pulse rounded-full bg-primary" aria-hidden />}>Sharing live location</Badge> : null}
        </div>
        <h1 className="mt-2 text-2xl font-semibold">{t.destinationLabel ?? 'Your journey'}</h1>
        <p className="text-sm text-fg-muted">
          {t.originLabel ? `From ${t.originLabel} · ` : ''}{fmtDistance(t.route.distanceM)} · about {Math.round(t.route.durationS / 60)} min
          {t.route.score !== null ? ` · Night Activity Score ${t.route.score}` : ''}
        </p>
      </header>

      <Suspense fallback={<Skeleton className="h-72 w-full" />}>
        <RouteMap routes={[mapRoute]} selectedId={t.id} tiles={config.data?.providers.geoapify.mode === 'live'} label="Map of your journey route" />
      </Suspense>

      <StatusPanel trip={t} onUpdate={update} />
      <SharingPanel trip={t} onUpdate={update} />
      {t.mode === 'walk' && (t.status === 'CREATED' || t.status === 'ACTIVE') ? <WalkTogetherPanel tripId={t.id} /> : null}

      <Link to="/sos" className="flex h-12 items-center justify-center gap-2 rounded-2xl bg-danger font-semibold text-danger-fg shadow-sm hover:bg-danger/90">
        SOS: get help now
      </Link>
      <p className="text-xs text-fg-muted">
        “Alert my circle” asks your Guardian Circle to check on you. SOS is for emergencies: it also alerts your emergency contacts by your rules. Neither contacts the police; in an emergency, call <a href="tel:112" className="font-semibold text-danger underline">112</a>.
      </p>
    </div>
  );
}

function StatusPanel({ trip: t, onUpdate }: { trip: Trip; onUpdate: (t: Trip) => void }) {
  const [askFeedback, setAskFeedback] = useState(false);
  const [confirmAlert, setConfirmAlert] = useState(false);
  const status = useMutation({
    mutationFn: (v: { to: 'ACTIVE' | 'ARRIVED' | 'CANCELLED' | 'ESCALATED'; feedback?: 'comfortable' | 'uneasy' }) => journeysApi.setStatus(t.id, v.to, v.feedback),
    onSuccess: (next) => {
      setAskFeedback(false);
      setConfirmAlert(false);
      onUpdate(next);
    },
  });
  const checkin = useMutation({ mutationFn: () => journeysApi.checkin(t.id), onSuccess: onUpdate });
  const can = (s: string) => t.allowedTransitions.includes(s as Trip['status']);
  const underway = UNDERWAY.includes(t.status);
  const dueIn = minutesFromNow(t.nextCheckinDueAt);
  const shared = t.shares.some((s) => s.active);
  const error = status.error ?? checkin.error;

  return (
    <Card>
      {t.status === 'DELAYED' ? (
        <div className="mb-3"><Notice tone="warning" title="You’re running late">{shared ? 'Your circle has been told. ' : ''}If you’re fine, tap “I’m OK” to add 15 minutes.</Notice></div>
      ) : null}
      {t.status === 'ESCALATED' ? (
        <div className="mb-3"><Notice tone="warning" title="Your circle has been alerted">They were asked to contact you now. If you are in danger, call 112.</Notice></div>
      ) : null}

      <dl className="grid grid-cols-2 gap-3 text-sm">
        {t.status === 'CREATED' ? <Fact label="Planned for" value={dayClock(t.departureTime)} /> : null}
        {t.startedAt ? <Fact label="Started" value={clock(t.startedAt)} /> : null}
        {t.expectedArrivalAt && !t.endedAt ? <Fact label="Expected by" value={clock(t.expectedArrivalAt)} /> : null}
        {underway && t.nextCheckinDueAt ? (
          <Fact label="Next check-in" value={dueIn !== null && dueIn < 0 ? `Overdue (${clock(t.nextCheckinDueAt)})` : clock(t.nextCheckinDueAt)} warn={dueIn !== null && dueIn < 0} />
        ) : null}
        {t.arrivedAt ? <Fact label="Arrived" value={clock(t.arrivedAt)} /> : null}
        {t.status === 'CANCELLED' && t.endedAt ? <Fact label="Cancelled" value={clock(t.endedAt)} /> : null}
      </dl>

      <div className="mt-4 space-y-2">
        {can('ACTIVE') && t.status === 'CREATED' ? (
          <Button fullWidth size="lg" loading={status.isPending} onClick={() => status.mutate({ to: 'ACTIVE' })}>Start journey</Button>
        ) : null}
        {underway ? (
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" icon={<CheckCircle2 className="h-4 w-4" aria-hidden />} loading={checkin.isPending} onClick={() => checkin.mutate()}>I’m OK</Button>
            <Button onClick={() => setAskFeedback(true)} disabled={askFeedback}>I’ve arrived</Button>
          </div>
        ) : null}
        {askFeedback ? (
          <div className="rounded-xl bg-surface-muted/70 p-3 text-sm">
            <p className="font-medium">How did the route feel? <span className="font-normal text-fg-muted">(optional, shared only as an anonymous area signal)</span></p>
            <div className="mt-2 grid grid-cols-3 gap-2">
              <Button size="sm" variant="secondary" icon={<Smile className="h-4 w-4" aria-hidden />} loading={status.isPending} onClick={() => status.mutate({ to: 'ARRIVED', feedback: 'comfortable' })}>Comfortable</Button>
              <Button size="sm" variant="secondary" icon={<Frown className="h-4 w-4" aria-hidden />} loading={status.isPending} onClick={() => status.mutate({ to: 'ARRIVED', feedback: 'uneasy' })}>Uneasy</Button>
              <Button size="sm" variant="ghost" loading={status.isPending} onClick={() => status.mutate({ to: 'ARRIVED' })}>Skip</Button>
            </div>
          </div>
        ) : null}
        {can('ESCALATED') ? (
          confirmAlert ? (
            <div className="rounded-xl border border-danger/40 bg-danger-soft/60 p-3 text-sm">
              <p className="font-medium">Alert your Guardian Circle?</p>
              <p className="mt-0.5 text-fg-muted">They’ll be asked to contact you now. This does not call emergency services.</p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="danger" loading={status.isPending} onClick={() => status.mutate({ to: 'ESCALATED' })}>Alert my circle</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmAlert(false)}>Not now</Button>
              </div>
            </div>
          ) : (
            <Button fullWidth variant="ghost" className="text-danger" icon={<ShieldAlert className="h-4 w-4" aria-hidden />} onClick={() => setConfirmAlert(true)} disabled={!shared}>
              Alert my circle{shared ? '' : ' (share this journey first)'}
            </Button>
          )
        ) : null}
        {can('CANCELLED') ? (
          <Button fullWidth variant="ghost" size="sm" loading={status.isPending && status.variables?.to === 'CANCELLED'} onClick={() => status.mutate({ to: 'CANCELLED' })}>Cancel journey</Button>
        ) : null}
        {error ? <p role="alert" className="text-sm text-danger">{error.message}</p> : null}
      </div>
    </Card>
  );
}

function Fact({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className={cn('font-medium', warn && 'text-warning-strong')}>{value}</dd>
    </div>
  );
}

function SharingPanel({ trip: t, onUpdate }: { trip: Trip; onUpdate: (t: Trip) => void }) {
  const circles = useQuery({ queryKey: ['community', 'circles'], queryFn: communityApi.circles });
  const ownCircle = circles.data?.circles.find((c) => c.isOwner) ?? null;
  const active = t.shares.find((s) => s.active) ?? null;
  const share = useMutation({ mutationFn: (level: ShareLevel) => journeysApi.share(t.id, level), onSuccess: onUpdate });
  const unshare = useMutation({ mutationFn: () => journeysApi.unshare(t.id), onSuccess: onUpdate });
  const sharing = useMutation({ mutationFn: (enabled: boolean) => journeysApi.setLocationSharing(t.id, enabled), onSuccess: onUpdate });
  const open = !t.endedAt;
  const live = useLiveLocation(t.id, t.locationSharing && UNDERWAY.includes(t.status));
  const error = share.error ?? unshare.error ?? sharing.error;

  return (
    <Card>
      <CardHeader icon={<Users className="h-5 w-5" aria-hidden />} title="Guardian Circle" description={active ? `Shared with ${active.circleName}` : 'This journey is private.'} />
      {!ownCircle && circles.isSuccess ? (
        <p className="text-sm text-fg-muted">Create a Guardian Circle to share journeys with people you trust. <Link to="/circle" className="font-medium text-primary underline">Set up your circle</Link></p>
      ) : null}
      {ownCircle && open ? (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">What your circle can see</legend>
          {SHARE_LEVELS.map((level) => (
            <label key={level} className={cn('flex cursor-pointer gap-3 rounded-xl border p-3 text-sm', active?.level === level ? 'border-primary bg-primary-soft/40' : 'border-border/70')}>
              <input type="radio" name="share-level" className="mt-1 accent-[rgb(var(--color-primary))]" checked={active?.level === level} onChange={() => share.mutate(level)} disabled={share.isPending} />
              <span><span className="font-medium">{SHARE_LEVEL_META[level].label}</span><span className="block text-fg-muted">{SHARE_LEVEL_META[level].description}</span></span>
            </label>
          ))}
          {active ? <Button size="sm" variant="ghost" loading={unshare.isPending} onClick={() => unshare.mutate()}>Stop sharing this journey</Button> : null}
        </fieldset>
      ) : null}
      {active?.acknowledgedBy.length ? <p className="mt-3 text-sm"><CheckCircle2 className="mr-1 inline h-4 w-4 text-success" aria-hidden />{active.acknowledgedBy.join(', ')} {active.acknowledgedBy.length === 1 ? 'is' : 'are'} keeping an eye on this journey.</p> : null}

      {open && active && active.level !== 'status' ? (
        <div className="mt-4 rounded-xl border border-border/70 p-3">
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>
              <span className="flex items-center gap-1.5 font-medium"><MapPin className="h-4 w-4" aria-hidden />Live location</span>
              <span className="block text-fg-muted">{active.level === 'precise' ? 'Your exact position' : 'The area you’re in'}, every 30 seconds, only during this journey. Stops automatically on arrival.</span>
            </span>
            <input type="checkbox" role="switch" aria-label="Share live location with your circle" aria-checked={t.locationSharing} className="h-5 w-5 accent-[rgb(var(--color-primary))]" checked={t.locationSharing} disabled={sharing.isPending} onChange={(e) => sharing.mutate(e.target.checked)} />
          </label>
          {t.locationSharing ? (
            <p className="mt-2 flex items-center gap-2 text-xs text-primary" aria-live="polite">
              <span className="h-2 w-2 animate-pulse rounded-full bg-primary" aria-hidden />
              {t.status === 'CREATED' ? 'Will start when you start the journey.' : live.lastSentAt ? `Shared at ${clock(new Date(live.lastSentAt).toISOString())}` : 'Waiting for your location…'}
            </p>
          ) : null}
          {live.error ? <p role="alert" className="mt-1 text-xs text-danger">{live.error}</p> : null}
        </div>
      ) : null}
      {error ? <p role="alert" className="mt-2 text-sm text-danger">{error.message}</p> : null}
    </Card>
  );
}

function WalkTogetherPanel({ tripId }: { tripId: string }) {
  const qc = useQueryClient();
  const key = [...journeysKey, 'walk', tripId];
  const status = useQuery({ queryKey: key, queryFn: () => journeysApi.walkStatus(tripId), refetchInterval: 20_000 });
  const [windowMinutes, setWindow] = useState(20);
  const request = useMutation({ mutationFn: () => journeysApi.walkRequest(tripId, windowMinutes), onSuccess: (d) => qc.setQueryData(key, d) });
  const withdraw = useMutation({ mutationFn: () => journeysApi.walkWithdraw(tripId), onSuccess: () => void qc.invalidateQueries({ queryKey: key }) });
  const act = useMutation({
    mutationFn: (v: { id: string; action: 'accept' | 'reject' | 'cancel'; expect?: 'proposed' | 'accepted' }) => journeysApi.walkAct(v.id, v.action, v.expect),
    // Refresh on failure too: a 409 means the match changed under us.
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
  });
  const req = status.data?.request;
  const looking = req?.status === 'open';
  const matches = useMemo(() => status.data?.matches ?? [], [status.data]);
  const error = request.error ?? withdraw.error ?? act.error;

  return (
    <Card>
      <CardHeader icon={<Footprints className="h-5 w-5" aria-hidden />} title="Walk Together" description="Find someone walking the same way at the same time." />
      <p className="text-sm text-fg-muted">
        We compare only the middle of your route (never its first or last 300 m) and show a pseudonym, never your name, number or location. Nothing is shared unless you <em>both</em> accept, and then only a private two-person chat opens. Always meet in a busy, well-lit public place.
      </p>
      {status.isPending ? <Skeleton className="mt-3 h-12 w-full" /> : null}
      {!looking && status.isSuccess ? (
        <div className="mt-3 flex items-end gap-2">
          <label className="flex-1 text-sm">
            <span className="mb-1 block font-medium">I can wait up to</span>
            <select className="h-11 w-full rounded-xl border border-border bg-surface px-3" value={windowMinutes} onChange={(e) => setWindow(Number(e.target.value))}>
              {[10, 20, 30, 45].map((m) => <option key={m} value={m}>{m} minutes</option>)}
            </select>
          </label>
          <Button loading={request.isPending} onClick={() => request.mutate()}>Look for company</Button>
        </div>
      ) : null}
      {looking ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm">Looking for company until {clock(req!.windowEnd)}. <button type="button" className="font-medium text-primary underline" onClick={() => withdraw.mutate()}>Stop looking</button></p>
          {matches.length === 0 ? <p className="text-sm text-fg-muted">No one on your route yet. We’ll keep checking while this page is open; new walkers who look later will also see you.</p> : null}
          <ul className="space-y-2">{matches.map((m) => <MatchRow key={m.id} m={m} busy={act.isPending} onAct={(action) => act.mutate({ id: m.id, action, ...(action === 'cancel' ? { expect: m.status === 'accepted' ? 'accepted' : 'proposed' } : {}) })} />)}</ul>
          <Button size="sm" variant="ghost" loading={request.isPending} onClick={() => request.mutate()}>Check again now</Button>
        </div>
      ) : null}
      {error ? <p role="alert" className="mt-2 text-sm text-danger">{error.message}</p> : null}
    </Card>
  );
}

function MatchRow({ m, busy, onAct }: { m: WalkMatch; busy: boolean; onAct: (a: 'accept' | 'reject' | 'cancel') => void }) {
  return (
    <li className="rounded-xl border border-border/70 p-3 text-sm">
      <p className="font-medium">{m.otherHandle} <span className="font-normal text-fg-muted">· {m.overlapPct}% of the route in common</span></p>
      <p className="text-fg-muted">{m.sharedAreas.length ? `Via ${m.sharedAreas.join(', ')}` : 'Shares part of your route'} · leaving {clock(m.theirWindow.start)}–{clock(m.theirWindow.end)}</p>
      {m.status === 'accepted' && m.channelId ? (
        <div className="mt-2 flex gap-2">
          <Link to={`/community/${m.channelId}`}><Button size="sm">Open private chat</Button></Link>
          <Button size="sm" variant="ghost" loading={busy} onClick={() => onAct('cancel')}>Leave</Button>
        </div>
      ) : m.myAccepted ? (
        <p className="mt-2 text-primary">You accepted. Waiting for {m.otherHandle} to accept too. <button type="button" className="underline" onClick={() => onAct('cancel')}>Withdraw</button></p>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" loading={busy} onClick={() => onAct('accept')}>Accept</Button>
          <Button size="sm" variant="ghost" onClick={() => onAct('reject')}>Decline</Button>
          {m.theyAccepted ? <Badge tone="primary">They accepted</Badge> : null}
        </div>
      )}
    </li>
  );
}

