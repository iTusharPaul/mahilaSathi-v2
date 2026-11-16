import { AlertCircle, Info, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './Button';
import { cn } from './cn';

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center px-6 py-10 text-center', className)}>
      {icon ? (
        <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-soft text-primary">{icon}</span>
      ) : null}
      <h2 className="text-lg font-semibold">{title}</h2>
      {description ? <p className="mt-1.5 max-w-sm text-sm text-fg-muted">{description}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
  retrying,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded-2xl border border-danger/30 bg-danger-soft/60 p-4">
      <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-danger" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        {message ? <p className="mt-0.5 text-sm text-fg-muted">{message}</p> : null}
        {onRetry ? (
          <Button size="sm" variant="secondary" className="mt-3" onClick={onRetry} loading={retrying}>
            Try again
          </Button>
        ) : null}
      </div>
    </div>
  );
}

type NoticeTone = 'info' | 'warning';

/** Inline explanatory banner, e.g. demo-mode labels and data-coverage caveats. */
export function Notice({ tone = 'info', title, children }: { tone?: NoticeTone; title?: string; children: ReactNode }) {
  const Icon = tone === 'warning' ? TriangleAlert : Info;
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-2xl p-3.5 text-sm',
        tone === 'warning' ? 'bg-warning-soft text-fg' : 'bg-primary-soft/70 text-fg',
      )}
    >
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', tone === 'warning' ? 'text-warning-strong' : 'text-primary')} aria-hidden />
      <div className="min-w-0">
        {title ? <p className="font-semibold">{title}</p> : null}
        <div className={cn(title && 'mt-0.5', 'text-fg-muted')}>{children}</div>
      </div>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded-xl bg-surface-muted', className)} />;
}
