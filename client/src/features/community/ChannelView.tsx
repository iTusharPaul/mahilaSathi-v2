import { CONTACT_INFO_MESSAGE, INFRA_CATEGORIES, MAX_TEXT_LENGTH, REPORT_REASONS, containsContactInfo, type ChannelSummary } from '@mahilasathi/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Ban, Compass, Flag, Lightbulb, MoreVertical, RotateCcw, Send, ShieldAlert, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Badge, Button, ErrorState, Notice, Spinner, cn } from '@/components/ui';
import { communityApi } from '@/services/communityApi';
import { blocksKey, useChannelMessages } from './chat/useChannelMessages';
import type { ChatMessage } from './chat/types';
import { INFRA_LABELS, REPORT_LABELS, formatDayTime } from './format';

type Reason = (typeof REPORT_REASONS)[number];

export function ChannelView({ channel }: { channel: ChannelSummary }) {
  const ref = useMemo(() => (channel.providerChannelId ? { id: channel.id, providerChannelId: channel.providerChannelId } : null), [channel.id, channel.providerChannelId]);
  const chat = useChannelMessages(ref);
  const members = useQuery({ queryKey: ['community', 'members', channel.id], queryFn: () => communityApi.members(channel.id), enabled: channel.isMember });
  const names = useMemo(() => new Map((members.data?.members ?? []).map((m) => [m.publicId, `${m.displayName ?? m.handle}${m.isDemo && !/demo/i.test(m.displayName ?? '') ? ' (demo)' : ''}`])), [members.data]);
  const [actionsFor, setActionsFor] = useState<ChatMessage | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const archived = channel.status === 'archived';

  // Block body on purpose: newer browsers return a Promise from scrollIntoView, and an effect must not
  // return anything except a cleanup function.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [chat.messages.length]);

  const nameOf = (m: ChatMessage) =>
    m.senderPublicId === chat.me ? 'You' : m.senderPublicId === 'mssystem' ? 'mahilaSathi' : (m.senderPublicId && names.get(m.senderPublicId)) || 'Former member';

  return (
    <div className="flex flex-col gap-3">
      {channel.kind !== 'guardian_circle' ? (
        <Notice>Don’t share phone numbers, addresses or exact locations here. Use your Guardian Circle for that.</Notice>
      ) : (
        <Notice>Private to your Guardian Circle. Only members can read this.</Notice>
      )}

      <div className="min-h-[16rem] space-y-3 rounded-2xl border border-border/70 bg-surface p-3" aria-live="polite">
        {chat.loading ? (
          <div className="flex justify-center py-10 text-primary"><Spinner /></div>
        ) : chat.loadError ? (
          <ErrorState title="Couldn’t load messages" message={chat.loadError} />
        ) : (
          <>
            {chat.hasMore && chat.messages.length > 0 ? (
              <button type="button" onClick={() => void chat.loadOlder()} className="mx-auto block text-xs font-medium text-primary">Load earlier messages</button>
            ) : null}
            {chat.messages.length === 0 ? <p className="py-10 text-center text-sm text-fg-muted">No messages yet. Say hello.</p> : null}
            {chat.messages.map((m) => (
              <MessageBubble key={m.id} message={m} mine={m.senderPublicId === chat.me} name={nameOf(m)} onActions={() => setActionsFor(m)} onRetry={() => void chat.send(m.text, m)} onDiscard={() => chat.discard(m.id)} />
            ))}
          </>
        )}
        <div ref={bottom} />
      </div>

      {actionsFor ? <MessageActions key={actionsFor.id} message={actionsFor} channel={channel} name={nameOf(actionsFor)} onClose={() => setActionsFor(null)} /> : null}

      {archived ? (
        <Notice tone="warning" title="This chat has ended">{channel.kind === 'walk_together' ? 'It’s read-only now. Walk Together chats close an hour after the walking window, or when either person leaves.' : 'It’s read-only now. Journey rooms close two hours after their departure window.'}</Notice>
      ) : (
        <>
          <Composer onSend={(text) => chat.send(text)} disabled={!ref} checkContactInfo={channel.kind !== 'guardian_circle'} />
          {channel.kind === 'neighbourhood' ? <UpdateComposer channelId={channel.id} /> : null}
        </>
      )}
    </div>
  );
}

function MessageBubble({ message: m, mine, name, onActions, onRetry, onDiscard }: { message: ChatMessage; mine: boolean; name: string; onActions: () => void; onRetry: () => void; onDiscard: () => void }) {
  if (m.kind === 'system') return <p className="text-center text-xs text-fg-muted">{m.text}</p>;
  if (m.kind === 'sos' && m.sos) {
    const live = m.sos.status === 'ACTIVE';
    return (
      <div className={cn('mx-auto w-full max-w-[92%] rounded-2xl border px-3.5 py-2.5 text-sm', live ? 'border-danger bg-danger-soft' : 'border-border/70 bg-surface')}>
        <p className="flex items-center gap-1.5 font-semibold"><ShieldAlert className="h-4 w-4 text-danger" aria-hidden />SOS {live ? '' : <Badge tone="success">ended</Badge>}</p>
        <p className="mt-0.5">{m.text}</p>
        <p className="mt-1 flex items-center justify-between text-xs text-fg-muted">
          <span>{formatDayTime(m.sentAt)} · sent by mahilaSathi</span>
          <Link to={`/sos/alerts/${m.sos.sosId}`} className="font-medium text-danger underline">Open SOS</Link>
        </p>
      </div>
    );
  }
  if (m.kind === 'journey' && m.journey) {
    const tone = m.journey.status === 'ARRIVED' ? 'success' : m.journey.status === 'ESCALATED' ? 'danger' : m.journey.status === 'DELAYED' ? 'warning' : 'primary';
    return (
      <div className={cn('mx-auto w-full max-w-[92%] rounded-2xl border px-3.5 py-2.5 text-sm', tone === 'danger' ? 'border-danger/40 bg-danger-soft' : tone === 'warning' ? 'border-warning/40 bg-warning-soft' : 'border-border/70 bg-surface')}>
        <p className="flex items-center gap-1.5 font-semibold"><Compass className="h-4 w-4" aria-hidden />Journey update <Badge tone={tone}>{m.journey.status.toLowerCase()}</Badge></p>
        <p className="mt-0.5">{m.text}</p>
        <p className="mt-1 flex items-center justify-between text-xs text-fg-muted">
          <span>{formatDayTime(m.sentAt)} · sent by mahilaSathi</span>
          <Link to="/journeys" className="font-medium text-primary underline">Open journeys</Link>
        </p>
      </div>
    );
  }
  return (
    <div className={cn('flex flex-col', mine ? 'items-end' : 'items-start')}>
      <div className="mb-0.5 flex items-center gap-1.5 px-1 text-[0.7rem] text-fg-muted">
        <span className="font-medium">{name}</span>
        <span>{formatDayTime(m.sentAt)}</span>
        {!mine && m.status === 'sent' ? (
          <button type="button" onClick={onActions} className="rounded p-0.5 hover:bg-surface-muted" aria-label={`Report or block ${name}`}>
            <MoreVertical className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
      {m.kind === 'infra_update' && m.infra ? (
        <div className="max-w-[85%] rounded-2xl border border-warning/40 bg-warning-soft px-3.5 py-2.5 text-sm">
          <p className="flex items-center gap-1.5 font-semibold"><Lightbulb className="h-4 w-4 text-warning-strong" aria-hidden />{INFRA_LABELS[m.infra.category]}</p>
          <p className="mt-0.5">{m.infra.note}</p>
          <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
            <Badge tone="warning">Community reported</Badge> Not verified · {m.infra.areaLabel}
          </p>
        </div>
      ) : (
        <div className={cn('max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-[0.95rem]', mine ? 'rounded-br-md bg-primary text-primary-fg' : 'rounded-bl-md bg-surface-muted', m.status === 'pending' && 'opacity-60', m.kind === 'unsupported' && 'italic text-fg-muted')}>
          {m.text}
        </div>
      )}
      {m.status === 'failed' ? (
        <div className="mt-1 flex items-center gap-2 text-xs text-danger" role="alert">
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> {m.error ?? 'Not sent'}
          <button type="button" className="inline-flex items-center gap-1 font-medium underline" onClick={onRetry}><RotateCcw className="h-3 w-3" aria-hidden />Retry</button>
          <button type="button" className="font-medium underline" onClick={onDiscard}>Discard</button>
        </div>
      ) : null}
    </div>
  );
}

function Composer({ onSend, disabled, checkContactInfo }: { onSend: (text: string) => Promise<void>; disabled: boolean; checkContactInfo: boolean }) {
  const [text, setText] = useState('');
  const [blocked, setBlocked] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    // Same rule as the server, checked here too so it also holds with Nexconn when the pre-messaging
    // webhook isn't reachable. The text is kept so it can be edited.
    if (checkContactInfo && containsContactInfo(t)) {
      setBlocked(CONTACT_INFO_MESSAGE);
      return;
    }
    setBlocked(null);
    setText('');
    void onSend(t);
  };
  return (
    <form onSubmit={submit} className="space-y-1.5">
      <div className="flex items-end gap-2">
      <label className="sr-only" htmlFor="composer">Message</label>
      <textarea
        id="composer"
        rows={1}
        maxLength={MAX_TEXT_LENGTH}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setBlocked(null);
        }}
        aria-describedby={blocked ? 'composer-blocked' : undefined}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) submit(e);
        }}
        placeholder="Write a message"
        className="max-h-32 min-h-[2.75rem] flex-1 resize-none rounded-xl border border-border bg-surface px-3 py-2.5 text-[0.95rem] focus:border-primary focus:outline-none"
        disabled={disabled}
      />
      <Button type="submit" aria-label="Send" disabled={disabled || !text.trim()} icon={<Send className="h-4 w-4" aria-hidden />} />
      </div>
      {blocked ? <p id="composer-blocked" role="alert" className="text-sm text-danger">{blocked}</p> : null}
    </form>
  );
}

function UpdateComposer({ channelId }: { channelId: string }) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<(typeof INFRA_CATEGORIES)[number]>('poor_lighting');
  const [note, setNote] = useState('');
  const post = useMutation({
    mutationFn: () => communityApi.postUpdate(channelId, { category, note }),
    onSuccess: () => {
      setNote('');
      setOpen(false);
    },
  });
  if (!open) {
    return (
      <Button variant="secondary" size="sm" icon={<Lightbulb className="h-4 w-4" aria-hidden />} onClick={() => setOpen(true)}>
        Post a neighbourhood update
      </Button>
    );
  }
  return (
    <form
      className="space-y-2.5 rounded-2xl border border-border/70 bg-surface p-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        post.mutate();
      }}
    >
      <p className="text-sm font-medium">Neighbourhood update</p>
      <select className="h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm" value={category} onChange={(e) => setCategory(e.target.value as typeof category)} aria-label="Update type">
        {INFRA_CATEGORIES.map((c) => <option key={c} value={c}>{INFRA_LABELS[c]}</option>)}
      </select>
      <textarea className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm" rows={2} maxLength={280} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What’s happening? Describe the place, not people." aria-label="Update details" />
      <p className="text-xs text-fg-muted">Shown as “Community reported”, not as verified information.</p>
      {post.isError ? <p role="alert" className="text-sm text-danger">{post.error.message}</p> : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={post.isPending} disabled={note.trim().length < 3}>Post update</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}

function MessageActions({ message, channel, name, onClose }: { message: ChatMessage; channel: ChannelSummary; name: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState<Reason>('harassment');
  const panel = useRef<HTMLDivElement>(null);
  // Bring the panel into view and move focus to it: it opens below the chat, often off-screen on phones.
  useEffect(() => {
    panel.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    panel.current?.focus({ preventScroll: true });
  }, []);
  const report = useMutation({
    mutationFn: () =>
      communityApi.reportMessage(message.id, {
        channelId: channel.id,
        reason,
        // Nexconn: the server can't read message history, so the reporter's copy is attached (and labelled unverified).
        ...(message.senderPublicId ? { snapshot: { text: message.text, senderPublicId: message.senderPublicId, sentAt: message.sentAt } } : {}),
      }),
  });
  const block = useMutation({
    mutationFn: () => communityApi.block(message.senderPublicId!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: blocksKey });
      void qc.invalidateQueries({ queryKey: ['community'] });
    },
  });

  return (
    <div ref={panel} tabIndex={-1} role="dialog" aria-label="Message actions" className="rounded-2xl border border-border bg-surface p-4 shadow-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold">Message from {name}</p>
          <p className="mt-0.5 line-clamp-2 text-sm text-fg-muted">“{message.text}”</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1 hover:bg-surface-muted"><X className="h-4 w-4" aria-hidden /></button>
      </div>
      <div className="space-y-3">
        {report.isSuccess ? (
          <p className="text-sm" role="status">Reported. A moderator will review it. The sender is not told who reported them.</p>
        ) : (
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium">Report reason</span>
            <select className="h-11 w-full rounded-xl border border-border bg-surface px-3" value={reason} onChange={(e) => setReason(e.target.value as Reason)}>
              {REPORT_REASONS.map((r) => <option key={r} value={r}>{REPORT_LABELS[r]}</option>)}
            </select>
          </label>
        )}
        {block.isSuccess ? (
          <p className="text-sm" role="status">{name} is blocked. You won’t see their messages, and you won’t be placed in rooms or circles together.</p>
        ) : null}
        {report.isError || block.isError ? <p role="alert" className="text-sm text-danger">{(report.error ?? block.error)?.message}</p> : null}
        <div className="flex flex-wrap gap-2">
          {!report.isSuccess ? (
            <Button size="sm" variant="secondary" icon={<Flag className="h-4 w-4" aria-hidden />} loading={report.isPending} onClick={() => report.mutate()}>Report message</Button>
          ) : null}
          {message.senderPublicId && !block.isSuccess ? (
            <Button size="sm" variant="ghost" icon={<Ban className="h-4 w-4" aria-hidden />} loading={block.isPending} onClick={() => block.mutate()}>Block {name}</Button>
          ) : null}
        </div>
        <p className="flex items-start gap-1.5 text-xs text-fg-muted"><ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />If you are in danger, call 112.</p>
      </div>
    </div>
  );
}
