import { EMERGENCY_NUMBERS, type SosEvent } from '@mahilasathi/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, MapPin, MapPinOff, Phone, Settings2, ShieldAlert, Users } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, CardHeader, ErrorState, Notice, Skeleton, cn } from '@/components/ui';
import { useMe } from '@/features/auth/useSession';
import { useEmergencyContacts } from '@/features/profile/EmergencyContactsEditor';
import { SosHoldButton } from '@/features/sos/SosHoldButton';
import { RESPONSE_LABEL, describeDelivery, sinceClock } from '@/features/sos/format';
import { usePublicConfig } from '@/hooks/useSystem';
import { communityApi } from '@/services/communityApi';
import { sosApi } from '@/services/sosApi';

export const sosKeys = { active: ['sos', 'active'] as const, settings: ['sos', 'settings'] as const, received: ['sos', 'received'] as const };
const COUNTDOWN_S = 5;
const LOCATION_EVERY_MS = 30_000;

export function SosPage() {
  const active = useQuery({ queryKey: sosKeys.active, queryFn: sosApi.active, refetchInterval: (q) => (q.state.data?.sos ? 5_000 : false) });
  const [ended, setEnded] = useState<SosEvent | null>(null);

  if (active.isPending) return <Skeleton className="h-96 w-full" />;
  if (active.isError) {
    return (
      <div className="space-y-4">
        <ErrorState title="Couldn’t load SOS" message={active.error.message} onRetry={() => void active.refetch()} />
        <CallEmergency />
      </div>
    );
  }
  if (active.data.sos) return <ActiveSos sos={active.data.sos} onEnded={setEnded} />;
  if (ended) return <EndedSos sos={ended} onDone={() => setEnded(null)} />;
  return <Activate />;
}

function CallEmergency({ big }: { big?: boolean }) {
  return (
    <a
      href={`tel:${EMERGENCY_NUMBERS.national}`}
      className={cn('flex items-center justify-center gap-2 rounded-2xl border-2 border-danger font-semibold text-danger hover:bg-danger-soft', big ? 'h-14 text-lg' : 'h-12')}
    >
      <Phone className="h-5 w-5" aria-hidden /> Call {EMERGENCY_NUMBERS.national} (police, ambulance, fire)
    </a>
  );
}

// ─── Activation ───────────────────────────────────────────────────────────────

function Activate() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const config = usePublicConfig();
  const settings = useQuery({ queryKey: sosKeys.settings, queryFn: sosApi.settings });
  const circles = useQuery({ queryKey: ['community', 'circles'], queryFn: communityApi.circles });
  const contacts = useEmergencyContacts();
  // One key per activation: a retry after a network error re-sends the same key and gets the same SOS.
  const key = useRef(crypto.randomUUID());
  const [confirming, setConfirming] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);

  const activate = useMutation({
    mutationFn: () => sosApi.activate({ idempotencyKey: key.current }),
    onSuccess: (sos) => {
      qc.setQueryData(sosKeys.active, { sos });
      key.current = crypto.randomUUID();
    },
  });

  const send = activate.mutate;
  // The home-screen shortcut (/sos?shortcut=1) starts a cancellable countdown if the user chose that.
  useEffect(() => {
    if (params.get('shortcut') === '1' && settings.data?.shortcut === 'countdown' && countdown === null && !activate.isPending) setCountdown(COUNTDOWN_S);
  }, [params, settings.data, countdown, activate.isPending]);
  useEffect(() => {
    if (countdown === null) return;
    if (countdown === 0) {
      setCountdown(null);
      send();
      return;
    }
    const t = setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => clearTimeout(t);
  }, [countdown, send]);
  const cancelCountdown = () => {
    setCountdown(null);
    params.delete('shortcut');
    setParams(params, { replace: true });
  };

  const guardians = circles.data?.circles.find((c) => c.isOwner)?.members.filter((m) => m.role === 'guardian').length ?? 0;
  const contactCount = contacts.data?.contacts.length ?? 0;
  const smsOff = config.data?.providers.sms.mode === 'disabled';
  const smsDev = config.data?.providers.sms.mode === 'dev-adapter';
  const policy = settings.data?.emergencyContacts;
  const me = useMe();

  if (countdown !== null) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6 text-center" role="alertdialog" aria-labelledby="countdown-title">
        <p id="countdown-title" className="text-lg font-semibold">Sending SOS in</p>
        <p className="text-7xl font-bold text-danger" aria-live="assertive">{countdown}</p>
        <Button size="lg" variant="secondary" onClick={cancelCountdown} className="w-64">Cancel</Button>
        <CallEmergency />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header className="text-center">
        <h1 className="text-2xl font-semibold">Emergency SOS</h1>
        <p className="mt-1 text-sm text-fg-muted">Alerts your Guardian Circle at once{policy !== 'never' ? ' and, by your rules, your emergency contacts' : ''}.</p>
      </header>

      {me.data?.isDemo ? <Notice tone="warning" title="Demo account">An SOS from this account is a demo: every message it sends starts with “DEMO, not a real emergency”.</Notice> : null}

      <SosHoldButton onActivate={() => activate.mutate()} disabled={activate.isPending} />

      {confirming ? (
        <div className="rounded-2xl border border-danger/40 bg-danger-soft/60 p-4 text-center">
          <p className="font-medium">Send an SOS now?</p>
          <div className="mt-3 flex justify-center gap-2">
            <Button variant="danger" loading={activate.isPending} onClick={() => activate.mutate()}>Send SOS</Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>Not now</Button>
          </div>
        </div>
      ) : (
        <p className="text-center text-sm">
          <button type="button" className="font-medium text-primary underline" onClick={() => setConfirming(true)}>Can’t hold? Send with a confirmation instead</button>
        </p>
      )}

      {activate.isError ? (
        <div role="alert" className="space-y-2 rounded-2xl border border-danger/40 bg-danger-soft/60 p-4 text-sm">
          <p className="font-semibold">The SOS could not be sent: {activate.error.message}</p>
          <p>Trying again is safe: it will not create a second SOS. If you are in danger, call 112 now.</p>
          <Button variant="danger" loading={activate.isPending} onClick={() => activate.mutate()}>Try again</Button>
        </div>
      ) : null}

      <CallEmergency big />

      <Card>
        <CardHeader icon={<Users className="h-5 w-5" aria-hidden />} title="Who will be alerted" action={<Link to="/profile#sos-settings" className="text-sm font-medium text-primary"><Settings2 className="mr-1 inline h-4 w-4" aria-hidden />Rules</Link>} />
        <ul className="space-y-1.5 text-sm">
          <li>{guardians > 0 ? `${guardians} ${guardians === 1 ? 'guardian' : 'guardians'} in your circle, in the app and the circle chat.` : <>No guardians yet. <Link to="/circle" className="font-medium text-primary underline">Set up your Guardian Circle</Link>.</>}</li>
          <li>
            {contactCount === 0 ? (
              <>No emergency contacts. <Link to="/profile" className="font-medium text-primary underline">Add one</Link>.</>
            ) : policy === 'never' ? (
              `${contactCount} emergency ${contactCount === 1 ? 'contact' : 'contacts'}: not messaged (your rule).`
            ) : (
              `${contactCount} emergency ${contactCount === 1 ? 'contact' : 'contacts'} by SMS ${policy === 'immediately' || guardians === 0 ? 'straight away' : `if no guardian responds within ${settings.data?.escalateAfterMinutes ?? 3} min`}.`
            )}
          </li>
          <li>Location: {settings.data?.locationDetail === 'none' ? 'not shared (your rule).' : settings.data?.locationDetail === 'approximate' ? 'the area you are in.' : 'your exact position, to these people only.'}</li>
        </ul>
        {smsOff && contactCount > 0 && policy !== 'never' ? (
          <div className="mt-3"><Notice tone="warning" title="SMS is not set up on this server">Emergency contacts will not receive a message. The SOS screen will say so. Call them yourself if you can.</Notice></div>
        ) : null}
        {smsDev ? <div className="mt-3"><Notice tone="warning" title="Development SMS adapter">SMS is simulated on this server: nothing reaches real phones.</Notice></div> : null}
      </Card>

      <p className="px-1 text-xs leading-relaxed text-fg-muted">
        mahilaSathi is not connected to the police or emergency services. An SOS alerts the people you chose. In an emergency, always call 112.
      </p>
    </div>
  );
}

// ─── Active SOS ───────────────────────────────────────────────────────────────

/** Sends the device position while the SOS is active and location sharing is on. Stops as soon as either ends. */
function useSosLocation(sos: SosEvent) {
  const [error, setError] = useState<string | null>(null);
  const enabled = sos.status === 'ACTIVE' && sos.locationSharing && sos.locationDetail !== 'none';
  const last = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    if (!('geolocation' in navigator)) {
      setError('This browser cannot share location.');
      return;
    }
    let cancelled = false;
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        if (cancelled || Date.now() - last.current < LOCATION_EVERY_MS) return;
        last.current = Date.now();
        sosApi
          .postLocation(sos.id, { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: Math.min(10_000, Math.round(pos.coords.accuracy)) })
          .then(() => !cancelled && setError(null))
          .catch((err: Error) => !cancelled && setError(err.message));
      },
      (err) => !cancelled && setError(err.code === 1 ? 'Location permission is denied, so your position can’t be updated from this device.' : 'Your location is unavailable right now.'),
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 },
    );
    return () => {
      cancelled = true;
      navigator.geolocation.clearWatch(id);
    };
  }, [sos.id, enabled]);
  return error;
}

function ActiveSos({ sos, onEnded }: { sos: SosEvent; onEnded: (s: SosEvent) => void }) {
  const qc = useQueryClient();
  const contacts = useEmergencyContacts();
  const locationError = useSosLocation(sos);
  const [confirmEnd, setConfirmEnd] = useState<'safe' | 'false_alarm' | null>(null);
  const update = (s: SosEvent) => qc.setQueryData(sosKeys.active, { sos: s.status === 'ACTIVE' ? s : null });
  const end = useMutation({
    mutationFn: (outcome: 'safe' | 'false_alarm') => sosApi.end(sos.id, outcome),
    onSuccess: (s) => {
      update(s);
      onEnded(s);
    },
  });
  const sharing = useMutation({ mutationFn: (enabled: boolean) => sosApi.setLocationSharing(sos.id, enabled), onSuccess: update });
  const s = sos.summary;

  return (
    <div className="space-y-4">
      {sos.demo ? <Notice tone="warning" title="Demo SOS">Raised by a fictional demo account. Every message it sends starts with “DEMO, not a real emergency”.</Notice> : null}
      <section className="rounded-3xl bg-danger p-5 text-danger-fg shadow-raised" role="status" aria-live="polite">
        <p className="flex items-center gap-2 text-sm font-medium opacity-90"><ShieldAlert className="h-5 w-5" aria-hidden />SOS active since {sinceClock(sos.activatedAt)}</p>
        <p className="mt-1 text-xl font-semibold">
          {s.recipients === 0 ? 'No one could be alerted' : s.acknowledged > 0 ? `${s.acknowledged} ${s.acknowledged === 1 ? 'person has' : 'people have'} responded` : 'Waiting for a response'}
        </p>
        <p className="mt-1 text-sm opacity-90">
          {s.recipients} alerted · {s.confirmed} confirmed seen · {s.acknowledged} responded{s.unreached ? ` · ${s.unreached} could not be reached` : ''}
        </p>
      </section>

      <CallEmergency big />
      {s.recipients === 0 ? <Notice tone="warning" title="Nobody to alert">You have no Guardian Circle members or emergency contacts. Call 112 or someone nearby.</Notice> : null}

      <Card>
        <CardHeader icon={sos.locationSharing ? <MapPin className="h-5 w-5" aria-hidden /> : <MapPinOff className="h-5 w-5" aria-hidden />} title="Your location" />
        {sos.locationDetail === 'none' ? (
          <p className="text-sm text-fg-muted">Your SOS rules share no location.</p>
        ) : sos.locationSharing ? (
          <div className="space-y-2 text-sm">
            <p>
              {sos.location ? `${sos.location.areaName ?? 'Shared'} · updated ${sinceClock(sos.location.recordedAt)}` : 'Waiting for your position…'}
              <span className="text-fg-muted"> ({sos.locationDetail === 'precise' ? 'exact position' : 'area only'} to the people alerted)</span>
            </p>
            {locationError ? <p role="alert" className="text-danger">{locationError}</p> : null}
            <Button size="sm" variant="secondary" loading={sharing.isPending} onClick={() => sharing.mutate(false)}>Stop sharing my location</Button>
          </div>
        ) : (
          <div className="space-y-2 text-sm">
            <p>Location sharing is off. Your last position was deleted.</p>
            <Button size="sm" variant="secondary" loading={sharing.isPending} onClick={() => sharing.mutate(true)}>Share location again</Button>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader icon={<Users className="h-5 w-5" aria-hidden />} title="Who has been alerted" description="Updated every few seconds. “Delivered” is only shown when it is confirmed." />
        <ul className="space-y-3">
          {sos.circleChat.map((d, i) => {
            const v = describeDelivery(d);
            return (
              <li key={`chat-${i}`} className="text-sm">
                <p className="font-medium">Guardian Circle chat <span className="font-normal text-fg-muted">· {v.label}</span></p>
                <p><Badge tone={v.tone}>{v.text}</Badge></p>
              </li>
            );
          })}
          {sos.recipients.map((r) => (
            <li key={r.id} className="rounded-xl bg-surface-muted/60 p-3 text-sm">
              <p className="flex flex-wrap items-center gap-1.5 font-medium">
                {r.name}
                <span className="font-normal text-fg-muted">· {r.kind === 'guardian' ? 'guardian' : 'emergency contact'}</span>
                {r.acknowledgement ? <Badge tone="success" icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>{RESPONSE_LABEL[r.acknowledgement.response]} · {sinceClock(r.acknowledgement.at)}</Badge> : null}
              </p>
              {r.deliveries.length === 0 ? (
                <p className="mt-1 text-fg-muted">{sos.escalation.nextAt ? `Will be messaged at ${sinceClock(sos.escalation.nextAt)} if no guardian responds.` : 'Not messaged (your rules, or a guardian responded in time).'}</p>
              ) : (
                <ul className="mt-1 space-y-1">
                  {r.deliveries.map((d, i) => {
                    const v = describeDelivery(d);
                    return <li key={i}><span className="text-fg-muted">{v.label}: </span><Badge tone={v.tone}>{v.text}</Badge></li>;
                  })}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </Card>

      {contacts.data?.contacts.length ? (
        <Card>
          <CardHeader icon={<Phone className="h-5 w-5" aria-hidden />} title="Call someone yourself" />
          <ul className="grid gap-2">
            {contacts.data.contacts.map((c) => (
              <li key={c.id}><a href={`tel:${c.phone}`} className="flex h-11 items-center justify-between rounded-xl bg-surface-muted px-3 text-sm font-medium"><span>{c.name}</span><Phone className="h-4 w-4" aria-hidden /></a></li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card>
        {confirmEnd ? (
          <div className="space-y-3 text-sm">
            <p className="font-medium">{confirmEnd === 'safe' ? 'End the SOS and tell everyone you are safe now?' : 'End the SOS as a false alarm?'}</p>
            <div className="flex gap-2">
              <Button loading={end.isPending} onClick={() => end.mutate(confirmEnd)}>Yes, end SOS</Button>
              <Button variant="ghost" onClick={() => setConfirmEnd(null)}>Keep it active</Button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => setConfirmEnd('safe')}>I’m safe now</Button>
            <Button variant="ghost" onClick={() => setConfirmEnd('false_alarm')}>False alarm</Button>
          </div>
        )}
        {end.isError ? <p role="alert" className="mt-2 text-sm text-danger">{end.error.message}</p> : null}
      </Card>
    </div>
  );
}

function EndedSos({ sos, onDone }: { sos: SosEvent; onDone: () => void }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader icon={<CheckCircle2 className="h-5 w-5 text-success" aria-hidden />} title={sos.outcome === 'safe' ? 'SOS ended: you are safe' : 'SOS ended: false alarm'} description={`Active from ${sinceClock(sos.activatedAt)} to ${sos.endedAt ? sinceClock(sos.endedAt) : '—'}. Everyone who was reached is being told.`} />
        <p className="text-sm text-fg-muted">{sos.summary.recipients} alerted · {sos.summary.confirmed} confirmed seen · {sos.summary.acknowledged} responded</p>
      </Card>
      <div className="grid grid-cols-2 gap-2">
        <Link to="/"><Button fullWidth variant="secondary">Home</Button></Link>
        <Button variant="ghost" onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}
