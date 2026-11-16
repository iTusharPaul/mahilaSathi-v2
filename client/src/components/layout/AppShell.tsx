import { FlaskConical, Moon, ShieldAlert, Sun, SunMoon } from 'lucide-react';
import { Link, Outlet, useNavigation } from 'react-router-dom';
import { Badge } from '@/components/ui';
import { useMe } from '@/features/auth/useSession';
import { SosAlertBanner } from '@/features/sos/SosAlertBanner';
import { usePublicConfig } from '@/hooks/useSystem';
import { useThemeStore, type ThemePreference } from '@/stores/themeStore';
import { BottomNav } from './BottomNav';
import { BrandMark } from './BrandMark';

const nextTheme: Record<ThemePreference, ThemePreference> = { system: 'light', light: 'dark', dark: 'system' };
const themeIcon = { system: SunMoon, light: Sun, dark: Moon } as const;

export function AppShell() {
  const { data: config } = usePublicConfig();
  const { preference, setPreference } = useThemeStore();
  const ThemeIcon = themeIcon[preference];
  const me = useMe();
  const navigation = useNavigation();

  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-xl focus:bg-surface focus:px-4 focus:py-2 focus:shadow-raised"
      >
        Skip to content
      </a>

      {navigation.state === 'loading' ? (
        <div className="fixed inset-x-0 top-0 z-40 h-0.5 overflow-hidden bg-primary/20" role="progressbar" aria-label="Loading screen">
          <div className="h-full w-1/3 animate-[loading_1s_ease-in-out_infinite] bg-primary motion-reduce:animate-none" />
        </div>
      ) : null}
      <header className="pt-safe sticky top-0 z-20 border-b border-border/60 bg-bg/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-app items-center gap-2 px-4 sm:gap-3">
          <Link to="/" className="flex min-w-0 items-center gap-2 rounded-lg" aria-label="mahilaSathi home">
            <BrandMark className="h-8 w-8 shrink-0" />
            <span className="hidden text-[1.05rem] font-semibold tracking-tight min-[360px]:inline">
              mahila<span className="text-primary">Sathi</span>
            </span>
          </Link>
          {config?.demoMode ? (
            <Badge tone="warning" icon={<FlaskConical className="h-3 w-3" aria-hidden />}>
              Demo<span className="hidden min-[400px]:inline">&nbsp;mode</span>
            </Badge>
          ) : null}
          <span className="ml-auto" />
          {me.data?.onboardingCompleted ? (
            <Link to="/sos" className="flex h-9 shrink-0 items-center gap-1 rounded-full bg-danger px-3 text-sm font-bold tracking-wide text-danger-fg shadow-sm hover:bg-danger/90" aria-label="SOS: get help now">
              <ShieldAlert className="h-4 w-4" aria-hidden />SOS
            </Link>
          ) : null}
          <button
            type="button"
            onClick={() => setPreference(nextTheme[preference])}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg"
            aria-label={`Theme: ${preference}. Switch to ${nextTheme[preference]}`}
            title={`Theme: ${preference}`}
          >
            <ThemeIcon className="h-5 w-5" aria-hidden />
          </button>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-app px-4 pb-28 pt-5">
        <div className="mb-4 empty:mb-0">
          <SosAlertBanner />
        </div>
        <Outlet />
      </main>

      <BottomNav />
    </div>
  );
}
