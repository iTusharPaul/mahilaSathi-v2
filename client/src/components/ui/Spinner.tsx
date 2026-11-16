import { cn } from './cn';

const sizes = { sm: 'h-4 w-4 border-2', md: 'h-6 w-6 border-2', lg: 'h-10 w-10 border-[3px]' } as const;

/** Pass `label=""` when the spinner sits inside a control that already describes the busy state. */
export function Spinner({ size = 'md', label = 'Loading', className }: { size?: keyof typeof sizes; label?: string; className?: string }) {
  return (
    <span role={label ? 'status' : undefined} className={cn('inline-flex items-center', className)}>
      <span
        aria-hidden="true"
        className={cn('animate-spin rounded-full border-current border-r-transparent opacity-80', sizes[size])}
      />
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}
