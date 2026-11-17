import type { Preferences } from '@mahilasathi/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, LogOut, MapPin, Shield, Trash2, UserRound, Users } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge, Button, Card, CardHeader, ErrorState, Skeleton, TextField } from '@/components/ui';
import { meKey, useMe, useSignOut, useUpdateMe } from '@/features/auth/useSession';
import { AreaPicker, type AreaChoice } from '@/features/neighbourhoods/AreaPicker';
import { EmergencyContactsEditor } from '@/features/profile/EmergencyContactsEditor';
import { LocationSharingOptions } from '@/features/profile/LocationSharingOptions';
import { NotificationsCard } from '@/features/notifications/NotificationsCard';
import { PrivacyControlsCard } from '@/features/profile/PrivacyControlsCard';
import { SosSettingsCard } from '@/features/profile/SosSettingsCard';
import { SystemStatusCard } from '@/features/system/SystemStatusCard';
import { usersApi } from '@/services/accountApi';
import { communityApi } from '@/services/communityApi';

export function ProfilePage() {
  const me = useMe();
  const signOut = useSignOut();
  const navigate = useNavigate();

  if (me.isPending) return <Skeleton className="h-40 w-full" />;
  if (!me.data) return null;

  return (
    <div className="space-y-5">
      <PageHeader title="Profile" description={`Signed in as ${me.data.signInMethod === 'google' ? `${me.data.maskedEmail ?? 'your Google account'} (Google)` : me.data.maskedPhone}`} action={me.data.isDemo ? <Badge tone="warning">Demo account</Badge> : undefined} />
      <DisplayNameCard />
      <HomeAreaCard />
      <Card>
        <CardHeader icon={<Users className="h-5 w-5" aria-hidden />} title="Emergency contacts" description="Messaged by SMS when you raise an SOS, following your SOS rules below." />
        <EmergencyContactsEditor />
      </Card>
      <SosSettingsCard />
      <NotificationsCard />
      <PreferencesCard />
      <PrivacyControlsCard />
      <BlockedUsersCard />
      <SystemStatusCard />
      <Button
        variant="secondary"
        fullWidth
        icon={<LogOut className="h-4 w-4" aria-hidden />}
        loading={signOut.isPending}
        onClick={() => signOut.mutate(undefined, { onSettled: () => navigate('/welcome', { replace: true }) })}
      >
        Sign out
      </Button>
      <DeleteAccountCard />
      <p className="text-center text-xs text-fg-muted">
        Moderating this server? <Link to="/moderation" className="font-medium text-primary underline">Moderator tools</Link> (admin token required)
      </p>
    </div>
  );
}

function DisplayNameCard() {
  const me = useMe();
  const update = useUpdateMe();
  const [name, setName] = useState(me.data?.displayName ?? '');
  const dirty = name.trim() !== (me.data?.displayName ?? '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (dirty) update.mutate({ displayName: name });
  };
  return (
    <Card>
      <CardHeader icon={<UserRound className="h-5 w-5" aria-hidden />} title="Your name" description={<>Community pseudonym: <Badge tone="primary">{me.data?.communityHandle}</Badge></>} />
      <form onSubmit={submit} className="space-y-3" noValidate>
        <TextField label="Display name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} error={update.isError ? update.error.message : null} />
        <Button type="submit" variant="secondary" disabled={!dirty} loading={update.isPending}>
          {update.isSuccess && !dirty ? 'Saved' : 'Save name'}
        </Button>
      </form>
    </Card>
  );
}

function HomeAreaCard() {
  const me = useMe();
  const update = useUpdateMe();
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState<AreaChoice | null>(null);
  const area = me.data?.homeArea;

  return (
    <Card>
      <CardHeader
        icon={<MapPin className="h-5 w-5" aria-hidden />}
        title="Home area"
        description="Only the area name is stored."
        action={!editing ? <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Change</Button> : null}
      />
      {!editing ? (
        area ? (
          <p className="text-sm">
            <strong>{area.neighbourhood?.name ?? area.district.name}</strong>
            <span className="text-fg-muted">, {[area.neighbourhood ? (area.city?.name ?? area.district.name) : null, area.state.name].filter(Boolean).join(', ')}</span>
          </p>
        ) : (
          <p className="text-sm text-fg-muted">Not set.</p>
        )
      ) : (
        <div className="space-y-3">
          <AreaPicker value={choice} onChange={setChoice} />
          {update.isError ? <p role="alert" className="text-sm text-danger">{update.error.message}</p> : null}
          <div className="flex gap-2">
            <Button
              disabled={!choice}
              loading={update.isPending}
              onClick={() =>
                choice &&
                update.mutate(choice.kind === 'neighbourhood' ? { homeNeighbourhoodId: choice.id } : { homeDistrictId: choice.id }, {
                  onSuccess: () => setEditing(false),
                })
              }
            >
              Save {choice ? choice.label : 'area'}
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function PreferencesCard() {
  const qc = useQueryClient();
  const prefs = useQuery({ queryKey: ['me', 'preferences'], queryFn: usersApi.preferences });
  const save = useMutation({
    mutationFn: usersApi.updatePreferences,
    onSuccess: (p) => qc.setQueryData(['me', 'preferences'], p),
  });
  const toggle = (key: keyof Omit<Preferences, 'locationSharingDefault'>) => prefs.data && save.mutate({ [key]: !prefs.data[key] });

  return (
    <Card>
      <CardHeader icon={<Bell className="h-5 w-5" aria-hidden />} title="Privacy & notifications" />
      {prefs.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : prefs.isError ? (
        <ErrorState message={prefs.error.message} onRetry={() => void prefs.refetch()} />
      ) : (
        <div className="space-y-4">
          <div>
            <p className="mb-2 text-sm font-medium">Default location sharing during journeys</p>
            <LocationSharingOptions value={prefs.data.locationSharingDefault} onChange={(v) => save.mutate({ locationSharingDefault: v })} disabled={save.isPending} />
          </div>
          <div className="divide-y divide-border/60">
            {(
              [
                ['notifySos', 'SOS alerts from people I guard'],
                ['notifyJourneyUpdates', 'Journey updates from my Guardian Circles'],
                ['notifyCommunity', 'Walk Together matches'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex cursor-pointer items-center justify-between gap-3 py-2.5 text-sm">
                {label}
                <input type="checkbox" className="h-5 w-5 accent-[rgb(var(--color-primary))]" checked={prefs.data[key]} onChange={() => toggle(key)} disabled={save.isPending} />
              </label>
            ))}
          </div>
          <p className="text-xs text-fg-muted">These choose which push notifications you get on devices where notifications are on. In-app SOS alerts from people you guard are always shown.</p>
          {save.isError ? <p role="alert" className="text-sm text-danger">{save.error.message}</p> : null}
        </div>
      )}
    </Card>
  );
}

function DeleteAccountCard() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState('');
  const del = useMutation({
    mutationFn: usersApi.deleteAccount,
    onSuccess: () => {
      qc.clear();
      qc.setQueryData(meKey, null);
      navigate('/welcome', { replace: true });
    },
  });
  return (
    <details className="rounded-2xl border border-border/70 bg-surface p-4">
      <summary className="flex cursor-pointer select-none items-center gap-2 text-sm font-medium text-fg-muted">
        <Trash2 className="h-4 w-4" aria-hidden /> Delete account
      </summary>
      <div className="mt-3 space-y-3 text-sm">
        <p className="text-fg-muted">
          This removes your name, phone number, home area, emergency contacts, preferences, journeys, reports and SOS history, and signs you out everywhere. It can’t be undone.
        </p>
        <TextField label='Type DELETE to confirm' value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
        {del.isError ? <p role="alert" className="text-danger">{del.error.message}</p> : null}
        <Button variant="secondary" disabled={confirm !== 'DELETE'} loading={del.isPending} onClick={() => del.mutate()}>
          Permanently delete my account
        </Button>
      </div>
    </details>
  );
}

function BlockedUsersCard() {
  const qc = useQueryClient();
  const blocks = useQuery({ queryKey: ['me', 'blocks'], queryFn: communityApi.blocks });
  const unblock = useMutation({ mutationFn: communityApi.unblock, onSuccess: () => void qc.invalidateQueries({ queryKey: ['me', 'blocks'] }) });
  return (
    <Card>
      <CardHeader icon={<Shield className="h-5 w-5" aria-hidden />} title="Blocked users" description="Blocked people never see that you blocked them." />
      {blocks.isPending ? (
        <Skeleton className="h-10 w-full" />
      ) : blocks.isError ? (
        <ErrorState message={blocks.error.message} onRetry={() => void blocks.refetch()} />
      ) : blocks.data.blocked.length === 0 ? (
        <p className="text-sm text-fg-muted">You haven’t blocked anyone.</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {blocks.data.blocked.map((b) => (
            <li key={b.publicId} className="flex items-center justify-between gap-3 py-2.5 text-sm">
              <span className="font-medium">{b.handle}</span>
              <Button size="sm" variant="ghost" loading={unblock.isPending && unblock.variables === b.publicId} onClick={() => unblock.mutate(b.publicId)}>Unblock</Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
