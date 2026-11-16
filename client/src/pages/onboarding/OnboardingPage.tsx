import { displayNameSchema, type Preferences } from '@mahilasathi/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, EyeOff, Lock, MapPin, ShieldCheck, UserRound, Users } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { BrandMark } from '@/components/layout/BrandMark';
import { Button, Notice, TextField, cn } from '@/components/ui';
import { meKey, useMe, useUpdateMe } from '@/features/auth/useSession';
import { AreaPicker, type AreaChoice } from '@/features/neighbourhoods/AreaPicker';
import { EmergencyContactsEditor, useEmergencyContacts } from '@/features/profile/EmergencyContactsEditor';
import { LocationSharingOptions } from '@/features/profile/LocationSharingOptions';
import { usersApi } from '@/services/accountApi';

const STEPS = ['profile', 'contacts', 'area', 'privacy'] as const;
type Step = (typeof STEPS)[number];

export function OnboardingPage() {
  const [step, setStep] = useState<Step>('profile');
  const index = STEPS.indexOf(step);
  const next = () => setStep(STEPS[Math.min(index + 1, STEPS.length - 1)]!);
  const back = () => setStep(STEPS[Math.max(index - 1, 0)]!);

  return (
    <div className="pt-safe mx-auto min-h-dvh max-w-app px-5 pb-10">
      <div className="flex h-14 items-center gap-3">
        {index > 0 ? (
          <button type="button" onClick={back} className="-ml-2 flex h-10 w-10 items-center justify-center rounded-xl text-fg-muted hover:bg-surface-muted" aria-label="Previous step">
            <ArrowLeft className="h-5 w-5" aria-hidden />
          </button>
        ) : (
          <BrandMark className="h-8 w-8" />
        )}
        <ol className="flex flex-1 gap-1.5" aria-label={`Step ${index + 1} of ${STEPS.length}`}>
          {STEPS.map((s, i) => (
            <li key={s} className={cn('h-1.5 flex-1 rounded-full transition-colors', i <= index ? 'bg-primary' : 'bg-border')} />
          ))}
        </ol>
      </div>
      <div className="mt-6">
        {step === 'profile' && <ProfileStep onDone={next} />}
        {step === 'contacts' && <ContactsStep onDone={next} />}
        {step === 'area' && <AreaStep onDone={next} />}
        {step === 'privacy' && <PrivacyStep />}
      </div>
    </div>
  );
}

function StepHeader({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="mb-6">
      <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary-soft text-primary">{icon}</span>
      <h1 className="mt-4 text-2xl font-semibold">{title}</h1>
      <div className="mt-1.5 text-sm text-fg-muted">{children}</div>
    </div>
  );
}

function ProfileStep({ onDone }: { onDone: () => void }) {
  const me = useMe();
  const update = useUpdateMe();
  const [name, setName] = useState(me.data?.displayName ?? '');
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = displayNameSchema.safeParse(name);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Invalid name');
    setError(null);
    update.mutate({ displayName: parsed.data }, { onSuccess: onDone });
  };

  return (
    <form onSubmit={submit} noValidate>
      <StepHeader icon={<UserRound className="h-5 w-5" aria-hidden />} title="What should we call you?">
        This is how mahilaSathi greets you and how your trusted contacts see you. It doesn’t need to be your legal name.
      </StepHeader>
      <TextField label="Display name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoFocus error={error ?? (update.isError ? update.error.message : null)} />
      {me.data ? (
        <div className="mt-5 flex items-start gap-3 rounded-2xl bg-surface-muted/70 p-3.5 text-sm">
          <EyeOff className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <p className="text-fg-muted">
            In community spaces you appear as <strong className="text-fg">{me.data.communityHandle}</strong>, a pseudonym. Your phone number is never shown to other members.
          </p>
        </div>
      ) : null}
      <Button type="submit" size="lg" fullWidth className="mt-8" loading={update.isPending}>Continue</Button>
    </form>
  );
}

function ContactsStep({ onDone }: { onDone: () => void }) {
  const contacts = useEmergencyContacts();
  const count = contacts.data?.contacts.length ?? 0;
  return (
    <div>
      <StepHeader icon={<Users className="h-5 w-5" aria-hidden />} title="Emergency contacts">
        People mahilaSathi will message when you raise an SOS, following your SOS rules (set them in Profile). Let them know you’ve added them.
      </StepHeader>
      <EmergencyContactsEditor />
      <Button size="lg" fullWidth className="mt-8" onClick={onDone}>
        {count > 0 ? 'Continue' : 'Skip for now'}
      </Button>
      {count === 0 ? <p className="mt-2 text-center text-xs text-fg-muted">You can add contacts later from your profile.</p> : null}
    </div>
  );
}

function AreaStep({ onDone }: { onDone: () => void }) {
  const me = useMe();
  const update = useUpdateMe();
  const current = me.data?.homeArea;
  const [choice, setChoice] = useState<AreaChoice | null>(
    current?.neighbourhood
      ? { kind: 'neighbourhood', id: current.neighbourhood.id, label: current.neighbourhood.name }
      : current
        ? { kind: 'district', id: current.district.id, label: current.district.name }
        : null,
  );

  const save = () => {
    if (!choice) return;
    update.mutate(choice.kind === 'neighbourhood' ? { homeNeighbourhoodId: choice.id } : { homeDistrictId: choice.id }, { onSuccess: onDone });
  };

  return (
    <div>
      <StepHeader icon={<MapPin className="h-5 w-5" aria-hidden />} title="Your home area">
        Used for your neighbourhood community and nearby information. We save the area’s name only, never your address or coordinates.
      </StepHeader>
      <AreaPicker value={choice} onChange={setChoice} />
      {choice ? (
        <p className="mt-4 text-sm">
          Selected: <strong>{choice.label}</strong>
        </p>
      ) : null}
      {update.isError ? <p role="alert" className="mt-2 text-sm text-danger">{update.error.message}</p> : null}
      <Button size="lg" fullWidth className="mt-6" disabled={!choice} loading={update.isPending} onClick={save}>
        Save area
      </Button>
      <Button variant="ghost" fullWidth className="mt-2" onClick={onDone}>
        Skip for now
      </Button>
    </div>
  );
}

function PrivacyStep() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const prefs = useQuery({ queryKey: ['me', 'preferences'], queryFn: usersApi.preferences });
  const [sharing, setSharing] = useState<Preferences['locationSharingDefault'] | null>(null);
  const value = sharing ?? prefs.data?.locationSharingDefault ?? 'off';

  const finish = useMutation({
    mutationFn: async () => {
      await usersApi.updatePreferences({ locationSharingDefault: value });
      return usersApi.updateMe({ onboardingCompleted: true });
    },
    onSuccess: (me) => {
      qc.setQueryData(meKey, me);
      navigate('/', { replace: true });
    },
  });

  return (
    <div>
      <StepHeader icon={<Lock className="h-5 w-5" aria-hidden />} title="Your privacy">
        You stay in control of what is shared, and with whom.
      </StepHeader>
      <ul className="mb-6 space-y-3 text-sm">
        {[
          'Other members see your pseudonym, never your phone number or exact location.',
          'Location is shared only during a journey, only with people you choose, and you can stop at any time.',
          'Public journey information is trimmed so it never reveals where you start or finish.',
        ].map((t) => (
          <li key={t} className="flex gap-2.5">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
            <span className="text-fg-muted">{t}</span>
          </li>
        ))}
      </ul>
      <p className="mb-2 text-sm font-medium">During journeys, by default share my location with my Guardian Circle:</p>
      <LocationSharingOptions value={value} onChange={setSharing} />
      <Notice>This applies when you share a journey with your Guardian Circle. You can change it for any journey, and here at any time.</Notice>
      {finish.isError ? <p role="alert" className="mt-3 text-sm text-danger">{finish.error.message}</p> : null}
      <Button size="lg" fullWidth className="mt-6" loading={finish.isPending} onClick={() => finish.mutate()}>
        Finish setup
      </Button>
    </div>
  );
}
