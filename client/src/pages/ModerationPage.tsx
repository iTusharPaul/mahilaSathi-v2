import { maskPhone, type AuditEvent, type CommunityReviewItem, type ModerationReport } from '@mahilasathi/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileClock, Flag, Gavel, KeyRound, LogOut, MapPin, MessageSquareText } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge, Button, Card, EmptyState, ErrorState, Notice, Skeleton, TextField, cn } from '@/components/ui';
import { REPORT_LABELS, formatDayTime } from '@/features/community/format';
import { REPORT_CATEGORY_LABELS } from '@/pages/community/AreaReportsPage';
import { ApiRequestError } from '@/services/apiClient';
import { moderationApi, type ModerationApi } from '@/services/moderationApi';
import { usePublicConfig } from '@/hooks/useSystem';

type Tab = 'reports' | 'community' | 'audit' | 'sms';
const when = (iso: string) => formatDayTime(Date.parse(iso));

/**
 * Moderator tools, unlocked with the server's ADMIN_TOKEN. The token is held in this page's memory only
 * (never in storage or the URL), so closing or reloading the tab signs out.
 */
export function ModerationPage() {
  const [api, setApi] = useState<ModerationApi | null>(null);
  const [tab, setTab] = useState<Tab>('reports');
  const qc = useQueryClient();
  const config = usePublicConfig();
  const devSms = config.data?.providers.sms.mode === 'dev-adapter';

  if (!api) return <TokenGate onUnlock={setApi} />;
  const signOut = () => {
    qc.removeQueries({ queryKey: ['moderation'] });
    setApi(null);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Moderation"
        description="Review reports and the audit trail. People appear by pseudonym only."
        action={<Button size="sm" variant="ghost" icon={<LogOut className="h-4 w-4" aria-hidden />} onClick={signOut}>Lock</Button>}
      />
      <div role="tablist" aria-label="Moderation sections" className={cn('grid gap-1 rounded-xl bg-surface-muted p-1', devSms ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3')}>
        {(
          [
            ['reports', 'Reports', Flag],
            ['community', 'Area reports', MapPin],
            ['audit', 'Audit log', FileClock],
            ...(devSms ? ([['sms', 'SMS outbox', MessageSquareText]] as const) : []),
          ] as const
        ).map(([value, label, Icon]) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`tab-${value}`}
            aria-selected={tab === value}
            aria-controls={`panel-${value}`}
            onClick={() => setTab(value)}
            className={cn('flex items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-medium', tab === value ? 'bg-surface text-primary shadow-sm' : 'text-fg-muted')}
          >
            <Icon className="h-4 w-4" aria-hidden />
            {label}
          </button>
        ))}
      </div>
      <section role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'reports' ? <ReportsPanel api={api} /> : tab === 'community' ? <CommunityPanel api={api} /> : tab === 'sms' ? <SmsPanel api={api} /> : <AuditPanel api={api} />}
      </section>
    </div>
  );
}

function TokenGate({ onUnlock }: { onUnlock: (api: ModerationApi) => void }) {
  const [token, setToken] = useState('');
  const check = useMutation({
    mutationFn: async (t: string) => {
      const api = moderationApi(t);
      await api.queue(); // proves the token before showing anything
      return api;
    },
    onSuccess: onUnlock,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (token.trim()) check.mutate(token.trim());
  };
  const err = check.error;
  const message =
    err instanceof ApiRequestError && err.status === 404
      ? 'Moderation is turned off on this server (no admin token is configured).'
      : err instanceof ApiRequestError && err.status === 401
        ? 'That token was not accepted.'
        : err?.message;

  return (
    <div className="space-y-5">
      <PageHeader title="Moderation" description="For moderators of this mahilaSathi server." />
      <Card>
        <form onSubmit={submit} className="space-y-4">
          <TextField
            label="Admin token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            leading={<KeyRound className="h-4 w-4" aria-hidden />}
            error={message ?? null}
          />
          <Button type="submit" fullWidth loading={check.isPending} disabled={!token.trim()}>Open moderation</Button>
          <p className="text-xs text-fg-muted">The token stays in this tab’s memory only. Reloading or closing the tab locks the tools again. Every action is recorded in the audit log.</p>
        </form>
      </Card>
    </div>
  );
}

// ─── Message and user reports ─────────────────────────────────────────────────

function ReportsPanel({ api }: { api: ModerationApi }) {
  const queue = useQuery({ queryKey: ['moderation', 'queue'], queryFn: api.queue });
  if (queue.isPending) return <Skeleton className="h-40 w-full" />;
  if (queue.isError) return <ErrorState message={queue.error.message} onRetry={() => void queue.refetch()} />;
  const items = [...queue.data.messages, ...queue.data.users].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (items.length === 0) return <EmptyState icon={<Gavel className="h-7 w-7" aria-hidden />} title="No open reports" description="Message and user reports appear here, oldest first." />;
  return (
    <ul className="space-y-3">
      {items.map((r) => <ReportCard key={r.id} r={r} api={api} />)}
    </ul>
  );
}

const ACTIONS = [
  ['dismiss', 'Dismiss (no action)'],
  ['warn', 'Warn (recorded on their history; they are not notified)'],
  ['remove_from_channel', 'Remove from the channel'],
  ['suspend', 'Suspend from community'],
] as const;
type Action = (typeof ACTIONS)[number][0];

function ReportCard({ r, api }: { r: ModerationReport; api: ModerationApi }) {
  const qc = useQueryClient();
  const [action, setAction] = useState<Action>('dismiss');
  const [reason, setReason] = useState('');
  const [hours, setHours] = useState(72);
  const resolve = useMutation({
    mutationFn: () => api.resolve(r.id, { action, reason: reason.trim(), ...(action === 'suspend' ? { suspendHours: hours } : {}) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['moderation'] }),
  });
  const unavailable = (a: Action) => (a !== 'dismiss' && !r.reported) || (a === 'remove_from_channel' && !r.channel);

  return (
    <li>
      <Card>
        <div className="flex flex-wrap items-center gap-1.5 text-sm">
          <Badge tone={r.type === 'message' ? 'primary' : 'neutral'}>{r.type === 'message' ? 'Message' : 'User'}</Badge>
          <span className="font-semibold">{REPORT_LABELS[r.reason] ?? r.reason}</span>
          <span className="text-fg-muted">· {when(r.createdAt)}</span>
        </div>
        <dl className="mt-3 grid gap-1 text-sm">
          <div><dt className="inline text-fg-muted">Reported: </dt><dd className="inline">
            {r.reported ? (
              <>
                <strong>{r.reported.handle}</strong>
                {r.reported.isDemo ? <Badge tone="warning" className="ml-1">demo</Badge> : null}
                {r.reported.suspendedUntil ? <Badge tone="danger" className="ml-1">suspended until {when(r.reported.suspendedUntil)}</Badge> : null}
                <span className="text-fg-muted"> · {r.reported.openReports} open {r.reported.openReports === 1 ? 'report' : 'reports'}</span>
              </>
            ) : 'Unknown sender'}
          </dd></div>
          <div><dt className="inline text-fg-muted">Reported by: </dt><dd className="inline">{r.reporterHandle}</dd></div>
          {r.channel ? <div><dt className="inline text-fg-muted">Where: </dt><dd className="inline">{r.channel.name} <span className="text-fg-muted">({r.channel.kind.replace('_', ' ')})</span></dd></div> : null}
        </dl>
        {r.snapshotText ? (
          <figure className="mt-3 rounded-xl bg-surface-muted/70 p-3 text-sm">
            <blockquote className="whitespace-pre-wrap break-words">“{r.snapshotText}”</blockquote>
            <figcaption className="mt-1 text-xs text-fg-muted">{r.snapshotSource === 'server' ? 'Copy held by the server' : 'Copy submitted by the reporter (the server could not read the original)'}</figcaption>
          </figure>
        ) : null}
        {r.details ? <p className="mt-2 text-sm"><span className="text-fg-muted">Reporter’s note: </span>{r.details}</p> : null}

        <form
          className="mt-4 space-y-3 border-t border-border/60 pt-3 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            resolve.mutate();
          }}
        >
          <label className="block">
            <span className="mb-1 block font-medium">Decision</span>
            <select className="h-11 w-full rounded-xl border border-border bg-surface px-3" value={action} onChange={(e) => setAction(e.target.value as Action)}>
              {ACTIONS.map(([v, label]) => <option key={v} value={v} disabled={unavailable(v)}>{label}{unavailable(v) ? ' (not available)' : ''}</option>)}
            </select>
          </label>
          {action === 'suspend' ? (
            <label className="block">
              <span className="mb-1 block font-medium">Suspend for</span>
              <select className="h-11 w-full rounded-xl border border-border bg-surface px-3" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
                {[24, 72, 168, 720].map((h) => <option key={h} value={h}>{h < 168 ? `${h} hours` : `${h / 24} days`}</option>)}
              </select>
            </label>
          ) : null}
          <label className="block">
            <span className="mb-1 block font-medium">Reason (recorded in the audit log)</span>
            <textarea className="min-h-[64px] w-full rounded-xl border border-border bg-surface p-2.5" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} />
          </label>
          <Button type="submit" size="sm" loading={resolve.isPending} disabled={reason.trim().length < 3 || unavailable(action)}>Apply decision</Button>
          {resolve.isError ? <p role="alert" className="text-danger">{resolve.error.message}</p> : null}
        </form>
      </Card>
    </li>
  );
}

// ─── Community (area) reports ─────────────────────────────────────────────────

function CommunityPanel({ api }: { api: ModerationApi }) {
  const list = useQuery({ queryKey: ['moderation', 'community'], queryFn: api.communityReports });
  if (list.isPending) return <Skeleton className="h-40 w-full" />;
  if (list.isError) return <ErrorState message={list.error.message} onRetry={() => void list.refetch()} />;
  if (list.data.reports.length === 0) return <EmptyState icon={<MapPin className="h-7 w-7" aria-hidden />} title="Nothing to review" description="Area reports waiting for review appear here. Reports about people stay hidden from others until verified." />;
  return (
    <div className="space-y-3">
      <Notice>Verifying a report shows it as “Verified information” and lets it count in the Community Pulse. Reports about people are only ever shown once verified. Rejecting one removes its effect; repeated rejections lower that reporter’s future weight.</Notice>
      <ul className="space-y-3">{list.data.reports.map((r) => <CommunityCard key={r.id} r={r} api={api} />)}</ul>
    </div>
  );
}

function CommunityCard({ r, api }: { r: CommunityReviewItem; api: ModerationApi }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const review = useMutation({
    mutationFn: (decision: 'verify' | 'reject') => api.review(r.id, decision, note.trim()),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['moderation'] }),
  });
  return (
    <li>
      <Card>
        <div className="flex flex-wrap items-center gap-1.5 text-sm">
          <span className="font-semibold">{REPORT_CATEGORY_LABELS[r.category]}</span>
          <Badge tone={r.status === 'under_review' ? 'warning' : 'neutral'}>{r.status === 'under_review' ? 'About people: hidden until verified' : 'Shown as “Community reported”'}</Badge>
          {r.demo ? <Badge tone="warning">demo</Badge> : null}
        </div>
        <p className="mt-2 text-sm">{r.description}</p>
        <p className="mt-1 text-xs text-fg-muted">{r.areaName ?? 'Area unknown'} · happened {when(r.occurredAt)} · reported {when(r.createdAt)}</p>
        <div className="mt-3 space-y-2 border-t border-border/60 pt-3 text-sm">
          <TextField label="Review note (recorded)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
          <div className="flex gap-2">
            <Button size="sm" loading={review.isPending && review.variables === 'verify'} disabled={note.trim().length < 3 || review.isPending} onClick={() => review.mutate('verify')}>Verify</Button>
            <Button size="sm" variant="secondary" loading={review.isPending && review.variables === 'reject'} disabled={note.trim().length < 3 || review.isPending} onClick={() => review.mutate('reject')}>Reject</Button>
          </div>
          {review.isError ? <p role="alert" className="text-danger">{review.error.message}</p> : null}
        </div>
      </Card>
    </li>
  );
}

// ─── Audit log ────────────────────────────────────────────────────────────────

const AUDIT_FILTERS = [
  ['', 'Everything'],
  ['moderation.', 'Moderation'],
  ['safety.', 'Blocks and reports'],
  ['community.', 'Community'],
  ['circle.', 'Guardian Circles'],
  ['sos.', 'SOS'],
  ['journey.', 'Journeys'],
  ['walk_together.', 'Walk Together'],
  ['privacy.', 'Privacy'],
  ['auth.', 'Sign-in'],
  ['user.', 'Accounts'],
] as const;

function AuditPanel({ api }: { api: ModerationApi }) {
  const [action, setAction] = useState('');
  const log = useInfiniteQuery({
    queryKey: ['moderation', 'audit', action],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.audit({ action: action || undefined, before: pageParam, limit: 50 }),
    getNextPageParam: (last) => (last.events.length === 50 ? last.events[last.events.length - 1]!.occurredAt : undefined),
  });
  const events = log.data?.pages.flatMap((p) => p.events) ?? [];

  return (
    <div className="space-y-3">
      <label className="block text-sm">
        <span className="mb-1 block font-medium">Show</span>
        <select className="h-11 w-full rounded-xl border border-border bg-surface px-3" value={action} onChange={(e) => setAction(e.target.value)}>
          {AUDIT_FILTERS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
      </label>
      <p className="text-xs text-fg-muted">The audit trail is append-only and holds identifiers and counts only: no coordinates, phone numbers or message text.</p>
      {log.isPending ? <Skeleton className="h-40 w-full" /> : null}
      {log.isError ? <ErrorState message={log.error.message} onRetry={() => void log.refetch()} /> : null}
      {log.isSuccess && events.length === 0 ? <p className="text-sm text-fg-muted">No events.</p> : null}
      <ol className="divide-y divide-border/60 rounded-2xl border border-border/70 bg-surface">
        {events.map((e) => <AuditRow key={e.id} e={e} />)}
      </ol>
      {log.hasNextPage ? <Button variant="secondary" fullWidth loading={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>Load older events</Button> : null}
    </div>
  );
}

function AuditRow({ e }: { e: AuditEvent }) {
  const meta = e.metadata && typeof e.metadata === 'object' && Object.keys(e.metadata).length ? JSON.stringify(e.metadata) : null;
  return (
    <li className="px-3 py-2.5 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <code className="font-mono text-[0.8rem] font-semibold">{e.action}</code>
        <time className="text-xs text-fg-muted" dateTime={e.occurredAt}>{when(e.occurredAt)}</time>
      </div>
      <p className="text-xs text-fg-muted">
        {e.actorType}{e.actorId ? ` ${e.actorId.slice(0, 8)}…` : ''}{e.targetType ? ` → ${e.targetType}${e.targetId ? ` ${e.targetId.slice(0, 8)}…` : ''}` : ''}
      </p>
      {meta ? <p className="mt-0.5 break-all font-mono text-[0.72rem] text-fg-muted">{meta}</p> : null}
    </li>
  );
}

// ─── Development SMS outbox ───────────────────────────────────────────────────

function SmsPanel({ api }: { api: ModerationApi }) {
  const list = useQuery({ queryKey: ['moderation', 'sms'], queryFn: api.devSms, refetchInterval: 10_000 });
  return (
    <div className="space-y-3">
      <Notice tone="warning" title="Development SMS adapter">Nothing here was sent to a real phone. This shows what emergency contacts would receive during an SOS, so a demo can show the escalation.</Notice>
      {list.isPending ? <Skeleton className="h-24 w-full" /> : null}
      {list.isError ? <ErrorState message={list.error.message} onRetry={() => void list.refetch()} /> : null}
      {list.data?.messages.length === 0 ? <p className="text-sm text-fg-muted">No SMS recorded yet. Raise an SOS from an account with an emergency contact to see one.</p> : null}
      <ul className="space-y-2">
        {list.data?.messages.map((m) => (
          <li key={m.id} className="rounded-xl border border-border/70 bg-surface p-3 text-sm">
            <p className="flex flex-wrap justify-between gap-2 text-xs text-fg-muted"><span>To {maskPhone(m.to)}</span><time dateTime={m.recordedAt}>{when(m.recordedAt)}</time></p>
            <p className="mt-1 whitespace-pre-wrap break-words">{m.body}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
