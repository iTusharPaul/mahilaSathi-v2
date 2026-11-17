import { normalizeIndianMobile, type Circle } from '@mahilasathi/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, MessageCircle, ShieldCheck, UserMinus, UserPlus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge, Button, Card, CardHeader, ErrorState, Notice, Skeleton, TextField } from '@/components/ui';
import { useChat } from '@/features/community/chat/ChatContext';
import { formatDayTime } from '@/features/community/format';
import { usePublicConfig } from '@/hooks/useSystem';
import { communityApi } from '@/services/communityApi';

const circlesKey = ['community', 'circles'] as const;

export function CirclePage() {
  const circles = useQuery({ queryKey: circlesKey, queryFn: communityApi.circles });
  const own = circles.data?.circles.find((c) => c.isOwner);
  const guarding = circles.data?.circles.filter((c) => !c.isOwner) ?? [];

  return (
    <div className="space-y-5">
      <PageHeader title="Guardian Circle" description="People you trust. Only members can see the circle and its chat." />
      {circles.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : circles.isError ? (
        <ErrorState message={circles.error.message} onRetry={() => void circles.refetch()} />
      ) : (
        <>
          {own ? <OwnCircle circle={own} /> : <CreateCircle />}
          <AcceptInvite />
          {guarding.map((c) => <GuardingCircle key={c.id} circle={c} />)}
        </>
      )}
    </div>
  );
}

function CreateCircle() {
  const qc = useQueryClient();
  const [name, setName] = useState('My Guardian Circle');
  const create = useMutation({ mutationFn: () => communityApi.createCircle(name), onSuccess: () => void qc.invalidateQueries({ queryKey: circlesKey }) });
  return (
    <Card>
      <CardHeader icon={<ShieldCheck className="h-5 w-5" aria-hidden />} title="Create your circle" description="Invite family or friends to follow your journeys and respond if you need help." />
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <TextField label="Circle name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
        {create.isError ? <p role="alert" className="text-sm text-danger">{create.error.message}</p> : null}
        <Button type="submit" loading={create.isPending} disabled={!name.trim()}>Create circle</Button>
      </form>
    </Card>
  );
}

function Members({ circle, canRemove }: { circle: Circle; canRemove: boolean }) {
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: (publicId: string) => communityApi.removeCircleMember(circle.id, publicId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: circlesKey }),
  });
  return (
    <ul className="divide-y divide-border/60">
      {circle.members.map((m) => (
        <li key={m.publicId} className="flex items-center gap-3 py-2.5">
          <span className="min-w-0 flex-1">
            <span className="block font-medium">{m.displayName ?? m.handle}</span>
            <span className="block text-xs text-fg-muted">{m.handle} · joined {formatDayTime(Date.parse(m.joinedAt))}</span>
          </span>
          {m.role === 'owner' ? <Badge tone="primary">Owner</Badge> : canRemove ? (
            <Button size="sm" variant="ghost" icon={<UserMinus className="h-4 w-4" aria-hidden />} loading={remove.isPending && remove.variables === m.publicId} onClick={() => remove.mutate(m.publicId)} aria-label={`Remove ${m.displayName ?? m.handle}`} />
          ) : <Badge>Guardian</Badge>}
        </li>
      ))}
    </ul>
  );
}

function OwnCircle({ circle }: { circle: Circle }) {
  const qc = useQueryClient();
  const [phone, setPhone] = useState('');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [lastCode, setLastCode] = useState<{ code: string; expiresAt: string; bound: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  // People who continue with Google have no phone number on their account, so a number-locked code could never be used.
  const canBindToPhone = !usePublicConfig().data?.auth.googleClientId;
  const invite = useMutation({
    mutationFn: () => communityApi.invite(circle.id, phone.trim() || undefined),
    onSuccess: (res) => {
      setLastCode({ code: res.code, expiresAt: res.expiresAt, bound: res.boundToPhone });
      setPhone('');
      void qc.invalidateQueries({ queryKey: circlesKey });
    },
  });
  const revoke = useMutation({ mutationFn: (inviteId: string) => communityApi.revokeInvite(circle.id, inviteId), onSuccess: () => void qc.invalidateQueries({ queryKey: circlesKey }) });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (phone.trim() && !normalizeIndianMobile(phone)) return setPhoneError('Enter a valid Indian mobile number, or leave it empty');
    setPhoneError(null);
    invite.mutate();
  };

  return (
    <Card>
      <CardHeader
        icon={<ShieldCheck className="h-5 w-5" aria-hidden />}
        title={circle.name}
        description={`${circle.members.length} of 10 members`}
        action={<Link to={`/community/${circle.channelId}`} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm font-medium text-primary hover:bg-primary-soft"><MessageCircle className="h-4 w-4" aria-hidden />Chat</Link>}
      />
      <Members circle={circle} canRemove />

      <div className="mt-4 space-y-3 border-t border-border/60 pt-4">
        <p className="text-sm font-medium">Invite a guardian</p>
        {lastCode ? (
          <div className="rounded-2xl bg-primary-soft/60 p-3.5 text-sm">
            <p>Share this code with them privately. It works once and expires {formatDayTime(Date.parse(lastCode.expiresAt))}{lastCode.bound ? ', and only for the number you entered' : ''}.</p>
            <div className="mt-2 flex items-center gap-2">
              <span className="font-mono text-xl font-semibold tracking-[0.2em]">{lastCode.code}</span>
              <Button size="sm" variant="ghost" icon={<Copy className="h-4 w-4" aria-hidden />} onClick={() => void navigator.clipboard?.writeText(lastCode.code).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy'}</Button>
            </div>
            <p className="mt-1 text-xs text-fg-muted">We won’t show this code again.</p>
          </div>
        ) : null}
        <form onSubmit={submit} className="space-y-2.5" noValidate>
          {canBindToPhone ? <TextField label="Their mobile number (optional)" hint="If given, only that number’s account can use the code." leading={<span className="text-sm">+91</span>} inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} error={phoneError} /> : null}
          {invite.isError ? <p role="alert" className="text-sm text-danger">{invite.error.message}</p> : null}
          <Button type="submit" variant="secondary" icon={<UserPlus className="h-4 w-4" aria-hidden />} loading={invite.isPending}>Create invite code</Button>
        </form>
        {circle.pendingInvites.length > 0 ? (
          <ul className="space-y-1.5 text-sm">
            {circle.pendingInvites.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-2 rounded-xl bg-surface-muted/70 px-3 py-2">
                <span>Pending invite{i.boundToPhone ? ' (number-bound)' : ''} · expires {formatDayTime(Date.parse(i.expiresAt))}</span>
                <button type="button" className="text-xs font-medium text-primary underline" onClick={() => revoke.mutate(i.id)}>Revoke</button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Card>
  );
}

function GuardingCircle({ circle }: { circle: Circle }) {
  const qc = useQueryClient();
  const { session } = useChat();
  const leave = useMutation({
    mutationFn: () => communityApi.removeCircleMember(circle.id, session!.chatUserId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: circlesKey }),
  });
  return (
    <Card>
      <CardHeader
        icon={<ShieldCheck className="h-5 w-5" aria-hidden />}
        title={`${circle.owner.displayName ?? circle.owner.handle}’s circle`}
        description="You are a guardian in this circle."
        action={<Link to={`/community/${circle.channelId}`} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm font-medium text-primary hover:bg-primary-soft"><MessageCircle className="h-4 w-4" aria-hidden />Chat</Link>}
      />
      <Members circle={circle} canRemove={false} />
      {session ? <Button className="mt-3" size="sm" variant="ghost" loading={leave.isPending} onClick={() => leave.mutate()}>Leave this circle</Button> : null}
      {leave.isError ? <p role="alert" className="mt-2 text-sm text-danger">{leave.error.message}</p> : null}
    </Card>
  );
}

function AcceptInvite() {
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const accept = useMutation({
    mutationFn: () => communityApi.acceptInvite(code),
    onSuccess: () => {
      setCode('');
      void qc.invalidateQueries({ queryKey: ['community'] });
    },
  });
  return (
    <Card>
      <CardHeader icon={<KeyRound className="h-5 w-5" aria-hidden />} title="Join someone’s circle" description="Enter the code they shared with you." />
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          accept.mutate();
        }}
      >
        <TextField className="flex-1 [&_input]:font-mono [&_input]:uppercase [&_input]:tracking-widest" label="Invite code" placeholder="ABCD-2345" value={code} onChange={(e) => setCode(e.target.value)} maxLength={9} autoComplete="off" />
        <Button type="submit" loading={accept.isPending} disabled={code.replace(/[^A-Za-z0-9]/g, '').length !== 8}>Join</Button>
      </form>
      {accept.isError ? <p role="alert" className="mt-2 text-sm text-danger">{accept.error.message}</p> : null}
      {accept.isSuccess ? <Notice title="You’ve joined">You’re now a guardian in {accept.data.owner.displayName ?? accept.data.owner.handle}’s circle.</Notice> : null}
    </Card>
  );
}
