import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, LogOut } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Badge, Button, ErrorState, Skeleton } from '@/components/ui';
import { ChannelView } from '@/features/community/ChannelView';
import { ConnectionBadge } from '@/features/community/ConnectionBadge';
import { formatWindow } from '@/features/community/format';
import { ApiRequestError } from '@/services/apiClient';
import { communityApi } from '@/services/communityApi';

const KIND_LABEL = { neighbourhood: 'Neighbourhood', journey_room: 'Journey room', guardian_circle: 'Guardian Circle', walk_together: 'Walk Together' } as const;

export function ChannelPage() {
  const { channelId = '' } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const channel = useQuery({ queryKey: ['community', 'channel', channelId], queryFn: () => communityApi.channel(channelId) });
  const join = useMutation({ mutationFn: () => communityApi.joinRoom(channelId), onSuccess: () => void qc.invalidateQueries({ queryKey: ['community'] }) });
  const leave = useMutation({
    mutationFn: () => communityApi.leave(channelId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['community'] });
      navigate('/community', { replace: true });
    },
  });

  if (channel.isPending) return <Skeleton className="h-64 w-full" />;
  if (channel.isError) {
    const notFound = channel.error instanceof ApiRequestError && channel.error.status === 404;
    return <ErrorState title={notFound ? 'Channel not found' : 'Couldn’t open this channel'} message={notFound ? 'It may be private or no longer exist.' : channel.error.message} />;
  }
  const c = channel.data;

  return (
    <div className="space-y-4">
      <Link to={c.kind === 'guardian_circle' ? '/circle' : '/community'} className="-ml-1 inline-flex items-center gap-1 rounded-lg px-1 text-sm text-fg-muted hover:text-fg">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Back
      </Link>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold">{c.name}</h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-muted">
            <Badge tone="primary">{KIND_LABEL[c.kind]}</Badge>
            {c.journey ? <span>{formatWindow(c.journey.windowStart, c.journey.windowEnd)}</span> : null}
            <span>{c.memberCount} {c.memberCount === 1 ? 'member' : 'members'}</span>
            {c.status === 'archived' ? <Badge>Ended</Badge> : null}
          </p>
        </div>
        {c.isMember && c.kind !== 'guardian_circle' ? (
          <Button size="sm" variant="ghost" icon={<LogOut className="h-4 w-4" aria-hidden />} loading={leave.isPending} onClick={() => leave.mutate()}>Leave</Button>
        ) : null}
      </div>
      <ConnectionBadge />
      {c.isMember ? (
        <ChannelView channel={c} />
      ) : c.kind === 'journey_room' && c.status === 'active' ? (
        <div className="space-y-2">
          <Button onClick={() => join.mutate()} loading={join.isPending}>Join this room</Button>
          {join.isError ? <p role="alert" className="text-sm text-danger">{join.error.message}</p> : null}
        </div>
      ) : (
        <p className="text-sm text-fg-muted">You’re not a member of this channel.</p>
      )}
      {leave.isError ? <p role="alert" className="text-sm text-danger">{leave.error.message}</p> : null}
    </div>
  );
}
