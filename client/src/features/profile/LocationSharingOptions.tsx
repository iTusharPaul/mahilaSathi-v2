import type { Preferences } from '@mahilasathi/shared';
import { Check } from 'lucide-react';
import { cn } from '@/components/ui';

const OPTIONS: { value: Preferences['locationSharingDefault']; label: string; detail: string }[] = [
  { value: 'off', label: 'Off', detail: 'Share journey status only. Turn location on per journey if you want.' },
  { value: 'guardians_approximate', label: 'Approximate location', detail: 'Your Guardian Circle sees roughly where you are (neighbourhood level).' },
  { value: 'guardians_precise', label: 'Precise location', detail: 'Your Guardian Circle sees your live position during the journey.' },
];

export function LocationSharingOptions({
  value,
  onChange,
  disabled,
}: {
  value: Preferences['locationSharingDefault'];
  onChange: (v: Preferences['locationSharingDefault']) => void;
  disabled?: boolean;
}) {
  return (
    <ul className="mb-4 space-y-2" role="radiogroup" aria-label="Default location sharing">
      {OPTIONS.map((o) => {
        const selected = o.value === value;
        return (
          <li key={o.value}>
            <button
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange(o.value)}
              className={cn(
                'flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors disabled:opacity-60',
                selected ? 'border-primary bg-primary-soft/60' : 'border-border/70 bg-surface hover:bg-surface-muted',
              )}
            >
              <span className={cn('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border', selected ? 'border-primary bg-primary text-primary-fg' : 'border-border')}>
                {selected ? <Check className="h-3 w-3" aria-hidden /> : null}
              </span>
              <span>
                <span className="block text-sm font-medium">{o.label}</span>
                <span className="block text-xs text-fg-muted">{o.detail}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
