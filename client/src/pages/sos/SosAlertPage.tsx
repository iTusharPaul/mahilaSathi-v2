import { EMERGENCY_NUMBERS, type ReceivedSos } from '@mahilasathi/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, ExternalLink, MapPin, MessageCircle, Phone, ShieldAlert } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { Badge, Button, Card, CardHeader, ErrorState, Notice, Skeleton } from '@/components/ui';
import { RESPONSE_LABEL, sinceClock } from '@/features/sos/format';
import { sosApi } from '@/services/sosApi';
import { sosKeys } from './SosPage';

const RESPONSES = [
  ['seen', 'I’ve seen this'],
  ['calling', 'I’m calling them'],
  ['on_my_way', 'I’m on my way'],
] as const;

/** What a guardian sees for an SOS they were alerted to. Location detail is what the sender allowed. */
export function SosAlertPage() {
  const { sosId = '' } = useParams();
  const qc = useQueryClient();
  const key = ['sos', 'alert', sosId];
  const view = useQuery({ queryKey: key, queryFn: () => sosApi.get(sosId), refetchInterval: (q) => (q.state.data?.event.status === 'ACTIVE' ? 10_000 : false) });
  const respond = useMutation({
    mutationFn: (r: 'seen' | 'calling' | 'on_my_way') => sosApi.acknowledge(sosId, r),
    onSuccess: (event) => {
      qc.setQueryData(key, { kind: 'recipient', event });
      void qc.invalidateQueries({ queryKey: sosKeys.received });
    },
  });

  if (view.isPending) return <Skeleton className="h-80 w-full" />;
  if (view.isError) return <ErrorState title="This SOS isn’t available" message="It may have ended more than 12 hours ago, or you were not one of the people alerted." />;
  if (view.data.kind === 'owner') {
    return <Notice title="This is your own SOS"><Link to="/sos" className="font-medium underline">Open your SOS screen</Link></Notice>;
  }
  const s: ReceivedSos = view.data.event;
  const active = s.status === 'ACTIVE';
  const loc = s.location;

  return (
    <div className="space-y-4">
      <Link to="/" className="inline-flex items-center gap-1 text-sm font-medium text-primary"><ArrowLeft className="h-4 w-4" aria-hidden />Home</Link>
      {s.demo ? <Notice tone="warning" title="DEMO, not a real emergency">This SOS was raised by a fictional demo account.</Notice> : null}
      <section className={active ? 'rounded-3xl bg-danger p-5 text-danger-fg shadow-raised' : 'rounded-3xl bg-surface-muted p-5'} role="status">
        <p className="flex items-center gap-2 text-sm font-medium opacity-90"><ShieldAlert className="h-5 w-5" aria-hidden />{active ? 'SOS active' : s.outcome === 'safe' ? 'SOS ended: safe now' : 'SOS ended: false alarm'}</p>
        <h1 className="mt-1 text-2xl font-semibold">{s.travellerName} {active ? 'needs help' : ''}</h1>
        <p className="mt-1 text-sm opacity-90">Since {sinceClock(s.activatedAt)}{s.endedAt ? `, ended ${sinceClock(s.endedAt)}` : ''}</p>
        {s.note ? <p className="mt-2 rounded-xl bg-black/10 p-2 text-sm">“{s.note}”</p> : null}
      </section>

      {active ? (
        <>
          <Card>
            <CardHeader icon={<MapPin className="h-5 w-5" aria-hidden />} title="Last known location" />
            {loc ? (
              <div className="space-y-2 text-sm">
                <p>{loc.areaName ?? 'Location shared'} · {sinceClock(loc.recordedAt)}{loc.accuracyM ? ` · within about ${Math.round(loc.accuracyM)} m` : ''}</p>
                {loc.lat !== null && loc.lng !== null ? (
                  <a
                    className="inline-flex items-center gap-1.5 font-medium text-primary underline"
                    href={`https://www.openstreetmap.org/?mlat=${loc.lat}&mlon=${loc.lng}#map=17/${loc.lat}/${loc.lng}`}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    Open exact position on a map <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                  </a>
                ) : (
                  <p className="text-fg-muted">{s.travellerName} shares the area only, not an exact position.</p>
                )}
              </div>
            ) : (
              <p className="text-sm text-fg-muted">{s.locationLevel === 'none' ? `${s.travellerName} chose not to share location with SOS alerts.` : 'No location available yet.'}</p>
            )}
          </Card>

          <Card>
            <CardHeader title="Let them know you’re responding" description="Your response is shown to them and to the rest of the circle." />
            <div className="grid gap-2">
              {RESPONSES.map(([value, label]) => (
                <Button key={value} variant={s.myResponse === value ? 'primary' : 'secondary'} loading={respond.isPending && respond.variables === value} onClick={() => respond.mutate(value)}>
                  {s.myResponse === value ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : null}
                  {label}
                </Button>
              ))}
            </div>
            {respond.isError ? <p role="alert" className="mt-2 text-sm text-danger">{respond.error.message}</p> : null}
          </Card>
        </>
      ) : null}

      {s.responses.length ? (
        <Card>
          <CardHeader title="Responses" />
          <ul className="space-y-1.5 text-sm">
            {s.responses.map((r) => <li key={r.name}><strong>{r.name}</strong> <Badge tone="success">{RESPONSE_LABEL[r.response].replace('Calling you', 'Calling')}</Badge> <span className="text-fg-muted">{sinceClock(r.at)}</span></li>)}
          </ul>
        </Card>
      ) : null}

      {active ? (
        <>
          <a href={`tel:${EMERGENCY_NUMBERS.national}`} className="flex h-12 items-center justify-center gap-2 rounded-2xl border-2 border-danger font-semibold text-danger hover:bg-danger-soft">
            <Phone className="h-5 w-5" aria-hidden /> If they are in immediate danger, call {EMERGENCY_NUMBERS.national}
          </a>
          <p className="text-xs text-fg-muted">mahilaSathi has not contacted the police or emergency services.</p>
        </>
      ) : null}
      <Link to="/circle" className="flex items-center gap-1.5 text-sm font-medium text-primary"><MessageCircle className="h-4 w-4" aria-hidden />Open the circle chat</Link>
    </div>
  );
}
