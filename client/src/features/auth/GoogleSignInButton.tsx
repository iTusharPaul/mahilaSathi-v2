import { useEffect, useRef, useState } from 'react';

/** The small part of Google Identity Services this app uses. https://developers.google.com/identity/gsi/web/reference/js-reference */
interface GoogleIdApi {
  initialize(options: {
    client_id: string;
    callback: (response: { credential?: string }) => void;
    ux_mode?: 'popup' | 'redirect';
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
    itp_support?: boolean;
    use_fedcm_for_button?: boolean;
  }): void;
  renderButton(
    parent: HTMLElement,
    options: { type?: 'standard'; theme?: 'outline' | 'filled_blue' | 'filled_black'; size?: 'large'; text?: 'continue_with' | 'signin_with'; shape?: 'pill' | 'rectangular'; logo_alignment?: 'left' | 'center'; width?: number; locale?: string },
  ): void;
}
declare global {
  interface Window {
    google?: { accounts: { id: GoogleIdApi } };
  }
}

const GSI_SRC = 'https://accounts.google.com/gsi/client';
let gsiLoading: Promise<GoogleIdApi> | null = null;

/** Loads Google's sign-in script once per page, only on screens that need it. */
function loadGoogleIdentity(): Promise<GoogleIdApi> {
  if (window.google?.accounts?.id) return Promise.resolve(window.google.accounts.id);
  gsiLoading ??= new Promise<GoogleIdApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GSI_SRC;
    script.async = true;
    script.onload = () => (window.google?.accounts?.id ? resolve(window.google.accounts.id) : reject(new Error('Google sign-in did not load')));
    script.onerror = () => reject(new Error('Google sign-in could not load'));
    document.head.appendChild(script);
  }).catch((err: unknown) => {
    gsiLoading = null; // allow a retry on the next visit
    throw err;
  });
  return gsiLoading;
}

/**
 * Google's own "Continue with Google" button. Google shows the account picker and hands back a signed ID token
 * (`credential`), which the server verifies. mahilaSathi never sees the Google password.
 */
export function GoogleSignInButton({ clientId, onCredential, disabled }: { clientId: string; onCredential: (credential: string) => void; disabled?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const callback = useRef(onCredential);
  callback.current = onCredential;
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');

  useEffect(() => {
    let cancelled = false;
    loadGoogleIdentity()
      .then((gsi) => {
        if (cancelled || !box.current) return;
        gsi.initialize({
          client_id: clientId,
          callback: (res) => res.credential && callback.current(res.credential),
          ux_mode: 'popup',
          auto_select: false,
          cancel_on_tap_outside: true,
          itp_support: true,
          use_fedcm_for_button: true,
        });
        const width = Math.min(400, Math.max(200, Math.floor(box.current.clientWidth)));
        gsi.renderButton(box.current, { type: 'standard', theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill', logo_alignment: 'center', width });
        setState('ready');
      })
      .catch(() => !cancelled && setState('failed'));
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  return (
    <div>
      <div
        ref={box}
        className={
          state === 'ready'
            ? `flex min-h-11 justify-center ${disabled ? 'pointer-events-none opacity-60' : ''}`
            : state === 'loading'
              ? 'h-11 animate-pulse rounded-full bg-surface-muted motion-reduce:animate-none'
              : 'hidden'
        }
        aria-busy={state === 'loading'}
      />
      {state === 'failed' ? (
        <p role="alert" className="mt-2 text-center text-sm text-danger">Google sign-in could not load. Check your connection, or turn off a blocker for accounts.google.com, then reload.</p>
      ) : null}
    </div>
  );
}
