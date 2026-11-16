import { SOS_CONTACT_POLICIES, SOS_LOCATION_DETAIL, type SosSettings } from '@mahilasathi/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { Card, CardHeader, ErrorState, Skeleton, cn } from '@/components/ui';
import { sosApi } from '@/services/sosApi';

const LOCATION: Record<SosSettings['locationDetail'], string> = {
  precise: 'Exact position (to your guardians and emergency contacts only)',
  approximate: 'Area only (e.g. the neighbourhood)',
  none: 'Don’t share location',
};
const CONTACTS: Record<SosSettings['emergencyContacts'], string> = {
  immediately: 'Message them straight away',
  if_unacknowledged: 'Message them only if no guardian responds in time',
  never: 'Never message them',
};

/** The user's escalation rules. They are copied into each SOS when it starts, so changes never alter one in progress. */
export function SosSettingsCard() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['sos', 'settings'], queryFn: sosApi.settings });
  const save = useMutation({ mutationFn: sosApi.updateSettings, onSuccess: (s) => qc.setQueryData(['sos', 'settings'], s) });
  const s = settings.data;

  return (
    <Card id="sos-settings">
      <CardHeader icon={<ShieldAlert className="h-5 w-5" aria-hidden />} title="SOS rules" description="Your Guardian Circle is always alerted in the app and the circle chat." />
      {settings.isPending ? <Skeleton className="h-40 w-full" /> : null}
      {settings.isError ? <ErrorState message={settings.error.message} onRetry={() => void settings.refetch()} /> : null}
      {s ? (
        <div className="space-y-4 text-sm">
          <Choice legend="Location sent with an SOS" name="sos-location" options={SOS_LOCATION_DETAIL.map((v) => [v, LOCATION[v]])} value={s.locationDetail} onChange={(v) => save.mutate({ locationDetail: v })} disabled={save.isPending} />
          <Choice legend="Emergency contacts (by SMS)" name="sos-contacts" options={SOS_CONTACT_POLICIES.map((v) => [v, CONTACTS[v]])} value={s.emergencyContacts} onChange={(v) => save.mutate({ emergencyContacts: v })} disabled={save.isPending} />
          <label className="block">
            <span className="mb-1.5 block font-medium">Wait for a guardian response for</span>
            <select className="h-11 w-full rounded-xl border border-border bg-surface px-3" value={s.escalateAfterMinutes} disabled={save.isPending} onChange={(e) => save.mutate({ escalateAfterMinutes: Number(e.target.value) })}>
              {[1, 2, 3, 5, 10, 15].map((m) => <option key={m} value={m}>{m} {m === 1 ? 'minute' : 'minutes'}</option>)}
            </select>
            <span className="mt-1 block text-xs text-fg-muted">If nobody responds by then, the circle is reminded{s.emergencyContacts === 'if_unacknowledged' ? ' and your emergency contacts are messaged' : ''}.</span>
          </label>
          <Choice
            legend="SOS shortcut (from your home screen, once the app is installed)"
            name="sos-shortcut"
            options={[
              ['hold', 'Open the SOS button (hold to send)'],
              ['countdown', 'Start a 5-second countdown I can cancel'],
            ]}
            value={s.shortcut}
            onChange={(v) => save.mutate({ shortcut: v as SosSettings['shortcut'] })}
            disabled={save.isPending}
          />
          {save.isError ? <p role="alert" className="text-danger">{save.error.message}</p> : null}
        </div>
      ) : null}
    </Card>
  );
}

function Choice<T extends string>({ legend, name, options, value, onChange, disabled }: { legend: string; name: string; options: (readonly [T, string])[]; value: T; onChange: (v: T) => void; disabled: boolean }) {
  return (
    <fieldset>
      <legend className="mb-1.5 font-medium">{legend}</legend>
      <div className="space-y-1.5">
        {options.map(([v, label]) => (
          <label key={v} className={cn('flex cursor-pointer items-center gap-2.5 rounded-xl border p-2.5', value === v ? 'border-primary bg-primary-soft/40' : 'border-border/70')}>
            <input type="radio" name={name} className="accent-[rgb(var(--color-primary))]" checked={value === v} onChange={() => onChange(v)} disabled={disabled} />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
