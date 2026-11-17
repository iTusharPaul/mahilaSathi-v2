import { DEMO_ACCOUNTS, OTP_LENGTH, normalizeIndianMobile, type AuthResult, type SendOtpResponse } from '@mahilasathi/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, FlaskConical, KeyRound, Phone } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Notice, TextField } from '@/components/ui';
import { GoogleSignInButton } from '@/features/auth/GoogleSignInButton';
import { meKey } from '@/features/auth/useSession';
import { usePublicConfig } from '@/hooks/useSystem';
import { authApi } from '@/services/accountApi';

/** Counts down from a local deadline (set from relative server timings, so clock skew can't distort it). */
function useSecondsUntil(deadlineMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadlineMs) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [deadlineMs]);
  return deadlineMs ? Math.max(0, Math.ceil((deadlineMs - now) / 1000)) : 0;
}

export function SignInPage() {
  const [phone, setPhone] = useState('');
  const config = usePublicConfig();
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [otp, setOtp] = useState<SendOtpResponse | null>(null);
  const [resendAt, setResendAt] = useState<number | null>(null);
  const [code, setCode] = useState('');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const resendIn = useSecondsUntil(resendAt);

  const googleClientId = config.data?.auth.googleClientId ?? null;
  const demoAccountsOnly = config.data?.auth.phoneSignIn === 'demo_accounts_only';

  const signedIn = (res: AuthResult) => {
    qc.setQueryData(meKey, res.user);
    navigate(res.user.onboardingCompleted ? '/' : '/onboarding', { replace: true });
  };

  const google = useMutation({ mutationFn: (credential: string) => authApi.google(credential), onSuccess: signedIn });

  const send = useMutation({
    mutationFn: (number: string) => authApi.sendOtp(number),
    onSuccess: (res) => {
      setOtp(res);
      setResendAt(Date.now() + res.resendAfterSeconds * 1000);
      setCode('');
    },
  });

  const verify = useMutation({
    mutationFn: () => authApi.verifyOtp(otp!.otpSessionId, code),
    onSuccess: signedIn,
  });

  const submitPhone = (e: FormEvent) => {
    e.preventDefault();
    if (!normalizeIndianMobile(phone)) {
      setPhoneError('Enter a valid 10-digit Indian mobile number');
      return;
    }
    setPhoneError(null);
    send.mutate(phone);
  };

  const pickDemoAccount = (number: string) => {
    setPhone(number);
    setPhoneError(null);
    // With Google sign-in on, the demo accounts are the only phone sign-ins, so tapping one goes straight on.
    if (demoAccountsOnly) send.mutate(number);
  };

  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    if (code.length === OTP_LENGTH) verify.mutate();
  };

  return (
    <div className="pt-safe mx-auto min-h-dvh max-w-app px-5 pb-10">
      <div className="flex h-14 items-center">
        {otp ? (
          <button type="button" onClick={() => setOtp(null)} className="-ml-2 flex h-10 items-center gap-1 rounded-xl px-2 text-sm text-fg-muted hover:text-fg">
            <ArrowLeft className="h-4 w-4" aria-hidden /> Change number
          </button>
        ) : (
          <Link to="/welcome" className="-ml-2 flex h-10 items-center gap-1 rounded-xl px-2 text-sm text-fg-muted hover:text-fg">
            <ArrowLeft className="h-4 w-4" aria-hidden /> Back
          </Link>
        )}
      </div>

      {!otp ? (
        <div className="mt-6 space-y-6">
          <div>
            <h1 className="text-2xl font-semibold">{googleClientId ? 'Sign in to mahilaSathi' : 'Sign in with your phone'}</h1>
            <p className="mt-1.5 text-sm text-fg-muted">
              {googleClientId
                ? 'Use your Google account. mahilaSathi never sees your Google password, and your email is never shown to other members.'
                : "We'll send a one-time code. Your number is used only to sign you in and is never shown to other members."}
            </p>
          </div>
          {config.data?.demoMode ? (
            <Notice tone="warning" title="Public test server">
              {googleClientId ? (
                <>
                  Continue with Google to use mahilaSathi as yourself. Emergency SMS is simulated on this server: no text
                  message reaches a real phone, so call your contacts yourself in an emergency. Data may be reset while the
                  app is in testing.
                </>
              ) : (
                <>
                  The sign-in code is shown on screen, so anyone can sign in with any number. Use a demo account below or a
                  made-up number such as 90000 12345, and don&apos;t enter real names, contacts or addresses. Data may be reset
                  at any time. No SMS is sent and nobody is alerted outside this app.
                </>
              )}
            </Notice>
          ) : null}

          {googleClientId ? (
            <div className="space-y-3">
              <GoogleSignInButton clientId={googleClientId} onCredential={(c) => google.mutate(c)} disabled={google.isPending} />
              {google.isPending ? <p className="text-center text-sm text-fg-muted" aria-live="polite">Signing you in…</p> : null}
              {google.isError ? <p role="alert" className="text-center text-sm text-danger">{google.error.message}</p> : null}
              <ConsentLine />
            </div>
          ) : null}

          {googleClientId && (!demoAccountsOnly || config.data?.demoMode) ? (
            <div className="flex items-center gap-3 text-xs font-medium uppercase tracking-wide text-fg-muted" aria-hidden>
              <span className="h-px flex-1 bg-border" />or<span className="h-px flex-1 bg-border" />
            </div>
          ) : null}

          {!demoAccountsOnly ? (
            <form onSubmit={submitPhone} className="space-y-6" noValidate>
              <TextField
                label="Mobile number"
                leading={<span className="flex items-center gap-1.5 text-sm"><Phone className="h-4 w-4" aria-hidden />+91</span>}
                inputMode="tel"
                autoComplete="tel-national"
                placeholder="98765 43210"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                error={phoneError ?? (send.isError ? send.error.message : null)}
                autoFocus={!googleClientId}
              />
              <Button type="submit" size="lg" fullWidth loading={send.isPending} variant={googleClientId ? 'secondary' : 'primary'}>
                Send code
              </Button>
              {!googleClientId ? <ConsentLine /> : null}
            </form>
          ) : null}

          {config.data?.demoMode ? (
            <div className="rounded-2xl border border-warning/40 bg-warning-soft/60 p-4 text-sm">
              <p className="flex items-center gap-1.5 font-semibold">
                <FlaskConical className="h-4 w-4" aria-hidden />
                {demoAccountsOnly ? 'Just looking? Try a demo account' : 'Demo accounts'}
              </p>
              <p className="mt-1 text-fg-muted">
                Fictional people shared by everyone trying mahilaSathi, so don&apos;t enter anything real in them. Lotus-42 travels
                and Jasmine-17 is her guardian: sign in to each on a different device to see an SOS arrive.{' '}
                {demoAccountsOnly ? 'Tap one to sign in.' : 'Tap one to fill in its number.'}
              </p>
              <div className="mt-3 grid gap-2">
                {DEMO_ACCOUNTS.map((a) => (
                  <button
                    key={a.handle}
                    type="button"
                    onClick={() => pickDemoAccount(a.phone)}
                    disabled={send.isPending}
                    className="flex items-center justify-between rounded-xl bg-surface px-3 py-2 text-left hover:bg-surface-muted disabled:opacity-60"
                  >
                    <span><span className="font-medium">{a.handle}</span> <span className="text-fg-muted">· {a.role}</span></span>
                    <span className="font-mono text-xs text-fg-muted">{a.phone}</span>
                  </button>
                ))}
              </div>
              {demoAccountsOnly && send.isError ? <p role="alert" className="mt-2 text-sm text-danger">{send.error.message}</p> : null}
            </div>
          ) : null}
        </div>
      ) : (
        <form onSubmit={submitCode} className="mt-6 space-y-6" noValidate>
          <div>
            <h1 className="text-2xl font-semibold">Enter the code</h1>
            <p className="mt-1.5 text-sm text-fg-muted">
              {otp.delivery.mode === 'live' ? `Sent by SMS to ${otp.maskedPhone}.` : `Code for ${otp.maskedPhone}.`} It expires in {Math.round(otp.expiresInSeconds / 60)} minutes.
            </p>
          </div>

          {otp.delivery.mode === 'dev-adapter' && otp.delivery.devCode ? (
            <Notice tone="warning" title="Development sign-in: no SMS was sent">
              Use this development code:
              <span className="mt-1.5 flex items-center gap-2">
                <FlaskConical className="h-4 w-4 text-warning-strong" aria-hidden />
                <strong className="font-mono text-lg tracking-[0.3em] text-fg">{otp.delivery.devCode}</strong>
                <Button type="button" size="sm" variant="secondary" className="ml-auto" onClick={() => setCode(otp.delivery.devCode ?? '')}>
                  Fill in code
                </Button>
              </span>
            </Notice>
          ) : null}

          <TextField
            label={`${OTP_LENGTH}-digit code`}
            leading={<KeyRound className="h-4 w-4" aria-hidden />}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={OTP_LENGTH}
            className="[&_input]:font-mono [&_input]:tracking-[0.4em]"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, OTP_LENGTH))}
            error={verify.isError ? verify.error.message : null}
            autoFocus
          />
          <Button type="submit" size="lg" fullWidth loading={verify.isPending} disabled={code.length !== OTP_LENGTH}>
            Verify and continue
          </Button>
          <Button
            variant="ghost"
            fullWidth
            disabled={resendIn > 0 || send.isPending}
            onClick={() => send.mutate(phone)}
          >
            {resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}
          </Button>
          {send.isError ? <p role="alert" className="text-center text-sm text-danger">{send.error.message}</p> : null}
        </form>
      )}
    </div>
  );
}

function ConsentLine() {
  return (
    <p className="text-center text-xs leading-relaxed text-fg-muted">
      By continuing you agree to how mahilaSathi handles your data, described in the{' '}
      <Link to="/privacy" className="font-medium text-primary underline-offset-2 hover:underline">privacy notice</Link>.
    </p>
  );
}
