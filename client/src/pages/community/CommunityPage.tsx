import type { ChannelSummary } from '@mahilasathi/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ChevronRight, Footprints, Home, MapPin, Plus, ShieldCheck, Users } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Notice, Skeleton } from '@/components/ui';
import { useMe } from '@/features/auth/useSession';
import { ConnectionBadge } from '@/features/community/ConnectionBadge';
import { formatWindow } from '@/features/community/format';
import { communityApi } from '@/services/communityApi';
import { geoApi } from '@/services/geoApi';

export const communityKeys = {
  mine: ['community', 'mine'] as const,
  neighbourhoods: ['community', 'neighbourhoods'] as const,
  rooms: (districtId?: string) => ['community', 'rooms', districtId ?? 'all'] as const,
};

export function CommunityPage() {
  return (
    <div className="space-y-5">
      <PageHeader title="Community" description="Neighbourhood channels, journey rooms and your Guardian Circle." />
      <ConnectionBadge />
      <MyChannels />
      <GuardianCircleCard />
      <AreaPulseCard />
      <Neighbourhoods />
      <JourneyRooms />
    </div>
  );
}

function ChannelRow({ c }: { c: ChannelSummary }) {
  const Icon = c.kind === 'neighbourhood' ? Home : c.kind === 'journey_room' || c.kind === 'walk_together' ? Footprints : ShieldCheck;
  return (
    <Link to={`/community/${c.id}`} className="flex items-center gap-3 rounded-xl px-1 py-2.5 hover:bg-surface-muted/60">
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary-soft text-primary"><Icon className="h-4 w-4" aria-hidden /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{c.name}</span>
        <span className="block text-xs text-fg-muted">
          {c.kind === 'journey_room' && c.journey ? formatWindow(c.journey.windowStart, c.journey.windowEnd) : c.kind === 'guardian_circle' ? 'Private circle' : c.kind === 'walk_together' ? 'Private Walk Together chat' : c.neighbourhood?.districtName}
          {' · '}
          {c.memberCount} {c.memberCount === 1 ? 'member' : 'members'}
        </span>
      </span>
      {c.status === 'archived' ? <Badge>Ended</Badge> : null}
      <ChevronRight className="h-4 w-4 text-fg-muted" aria-hidden />
    </Link>
  );
}

function MyChannels() {
  const mine = useQuery({ queryKey: communityKeys.mine, queryFn: communityApi.myChannels });
  return (
    <Card>
      <CardHeader icon={<Users className="h-5 w-5" aria-hidden />} title="Your channels" />
      {mine.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : mine.isError ? (
        <ErrorState message={mine.error.message} onRetry={() => void mine.refetch()} />
      ) : mine.data.channels.length === 0 ? (
        <p className="text-sm text-fg-muted">You haven’t joined any channels yet. Start with your neighbourhood below.</p>
      ) : (
        <div className="divide-y divide-border/60">{mine.data.channels.map((c) => <ChannelRow key={c.id} c={c} />)}</div>
      )}
    </Card>
  );
}

function GuardianCircleCard() {
  return (
    <Link to="/circle" className="block">
      <Card className="flex items-center gap-3 hover:bg-surface-muted/60">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-success-soft text-success"><ShieldCheck className="h-5 w-5" aria-hidden /></span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium">Guardian Circle</span>
          <span className="block text-sm text-fg-muted">A private space with the people you trust</span>
        </span>
        <ChevronRight className="h-4 w-4 text-fg-muted" aria-hidden />
      </Card>
    </Link>
  );
}

function AreaPulseCard() {
  return (
    <Link to="/community/reports" className="block">
      <Card className="flex items-center gap-3 hover:bg-surface-muted/60">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-fg"><Activity className="h-5 w-5" aria-hidden /></span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium">Area pulse & reports</span>
          <span className="block text-sm text-fg-muted">See what the community noticed around a place, or report an issue</span>
        </span>
        <ChevronRight className="h-4 w-4 text-fg-muted" aria-hidden />
      </Card>
    </Link>
  );
}

function Neighbourhoods() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const options = useQuery({ queryKey: communityKeys.neighbourhoods, queryFn: communityApi.neighbourhoods });
  const join = useMutation({
    mutationFn: communityApi.joinNeighbourhood,
    onSuccess: (channel) => {
      void qc.invalidateQueries({ queryKey: ['community'] });
      navigate(`/community/${channel.id}`);
    },
  });

  return (
    <Card>
      <CardHeader icon={<MapPin className="h-5 w-5" aria-hidden />} title="Neighbourhood channels" description={options.data ? `You can be in up to ${options.data.limit}. Joined: ${options.data.joinedCount}.` : undefined} />
      {options.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : options.isError ? (
        <ErrorState message={options.error.message} onRetry={() => void options.refetch()} />
      ) : options.data.neighbourhoods.length === 0 ? (
        <EmptyState
          title="Set your home area first"
          description="Neighbourhood channels are for residents. Choose your home area in your profile."
          action={<Link to="/profile" className="text-sm font-medium text-primary underline">Go to profile</Link>}
        />
      ) : (
        <ul className="divide-y divide-border/60">
          {options.data.neighbourhoods.map((n) => (
            <li key={n.id} className="flex items-center gap-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 font-medium">{n.name}{n.isHome ? <Badge tone="primary">Home</Badge> : null}</span>
                <span className="block text-xs text-fg-muted">{n.city ?? n.district} · {n.channel ? `${n.channel.memberCount} ${n.channel.memberCount === 1 ? 'member' : 'members'}` : 'No channel yet'}</span>
              </span>
              {n.channel?.isMember ? (
                <Link to={`/community/${n.channel.id}`} className="text-sm font-medium text-primary">Open</Link>
              ) : (
                <Button size="sm" variant="secondary" loading={join.isPending && join.variables === n.id} onClick={() => join.mutate(n.id)}>
                  {n.channel ? 'Join' : 'Start'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {join.isError ? <p role="alert" className="mt-2 text-sm text-danger">{join.error.message}</p> : null}
    </Card>
  );
}

function JourneyRooms() {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [nearMe, setNearMe] = useState(true);
  const districtId = nearMe ? me.data?.homeArea?.district.id : undefined;
  const rooms = useQuery({ queryKey: communityKeys.rooms(districtId), queryFn: () => communityApi.journeyRooms(districtId) });
  const [creating, setCreating] = useState(false);
  const join = useMutation({
    mutationFn: communityApi.joinRoom,
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ['community'] });
      navigate(`/community/${c.id}`);
    },
  });

  return (
    <Card>
      <CardHeader
        icon={<Footprints className="h-5 w-5" aria-hidden />}
        title="Journey rooms"
        description="Temporary rooms for people travelling the same way around the same time. They close 2 hours after the window."
        action={<Button size="sm" variant="ghost" icon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => setCreating((v) => !v)}>New</Button>}
      />
      {creating ? <CreateRoomForm onDone={() => setCreating(false)} /> : null}
      {me.data?.homeArea ? (
        <label className="mb-2 flex items-center gap-2 text-sm text-fg-muted">
          <input type="checkbox" checked={nearMe} onChange={(e) => setNearMe(e.target.checked)} className="h-4 w-4 accent-[rgb(var(--color-primary))]" />
          Only rooms starting or ending in {me.data.homeArea.district.name}
        </label>
      ) : null}
      {rooms.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : rooms.isError ? (
        <ErrorState message={rooms.error.message} onRetry={() => void rooms.refetch()} />
      ) : rooms.data.rooms.length === 0 ? (
        <p className="text-sm text-fg-muted">No open rooms{nearMe ? ' near your area' : ''} right now.</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {rooms.data.rooms.map((r) => (
            <li key={r.id} className="flex items-center gap-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{r.name}</span>
                <span className="block text-xs text-fg-muted">{r.journey ? formatWindow(r.journey.windowStart, r.journey.windowEnd) : ''} · {r.memberCount}/{r.maxMembers}</span>
              </span>
              {r.isMember ? (
                <Link to={`/community/${r.id}`} className="text-sm font-medium text-primary">Open</Link>
              ) : (
                <Button size="sm" variant="secondary" loading={join.isPending && join.variables === r.id} onClick={() => join.mutate(r.id)}>Join</Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {join.isError ? <p role="alert" className="mt-2 text-sm text-danger">{join.error.message}</p> : null}
      <Notice>Rooms show area names only. Never share your exact start point or home address in a room.</Notice>
    </Card>
  );
}

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function CreateRoomForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const neighbourhoods = useQuery({ queryKey: ['geo', 'neighbourhoods', 'all'], queryFn: () => geoApi.neighbourhoods({ limit: 100 }), staleTime: Infinity });
  const districts = useQuery({ queryKey: ['geo', 'districts'], queryFn: geoApi.districts, staleTime: Infinity });
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [start, setStart] = useState(() => toLocalInput(new Date(Date.now() + 30 * 60_000)));
  const [minutes, setMinutes] = useState(30);
  const create = useMutation({
    mutationFn: () => {
      const parse = (v: string) => {
        const [type, id] = v.split(':') as ['neighbourhood' | 'district', string];
        return { type, id };
      };
      return communityApi.createJourneyRoom({ from: parse(from), to: parse(to), windowStart: new Date(start).toISOString(), windowMinutes: minutes });
    },
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ['community'] });
      onDone();
      navigate(`/community/${c.id}`);
    },
  });

  const areaOptions = (
    <>
      <optgroup label="Neighbourhoods">
        {(neighbourhoods.data?.neighbourhoods ?? []).map((n) => <option key={n.id} value={`neighbourhood:${n.id}`}>{n.name} ({n.city?.name ?? n.district.name})</option>)}
      </optgroup>
      <optgroup label="Whole district">
        {(districts.data?.districts ?? []).map((d) => <option key={d.id} value={`district:${d.id}`}>{d.name}, {d.state.name}</option>)}
      </optgroup>
    </>
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  const selectClass = 'h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm';

  return (
    <form onSubmit={submit} className="mb-4 space-y-3 rounded-2xl border border-dashed border-border p-3.5">
      <label className="block text-sm"><span className="mb-1 block font-medium">From area</span>
        <select className={selectClass} value={from} onChange={(e) => setFrom(e.target.value)} required><option value="">Choose…</option>{areaOptions}</select>
      </label>
      <label className="block text-sm"><span className="mb-1 block font-medium">To area</span>
        <select className={selectClass} value={to} onChange={(e) => setTo(e.target.value)} required><option value="">Choose…</option>{areaOptions}</select>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-sm"><span className="mb-1 block font-medium">Leaving around</span>
          <input type="datetime-local" className={selectClass} value={start} onChange={(e) => setStart(e.target.value)} required />
        </label>
        <label className="block text-sm"><span className="mb-1 block font-medium">Window</span>
          <select className={selectClass} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
            {[15, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m} min</option>)}
          </select>
        </label>
      </div>
      {create.isError ? <p role="alert" className="text-sm text-danger">{create.error.message}</p> : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={create.isPending} disabled={!from || !to}>Create room</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}
