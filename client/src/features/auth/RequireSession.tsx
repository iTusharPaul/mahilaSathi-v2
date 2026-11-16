import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { ErrorState, Spinner } from '@/components/ui';
import { useMe } from './useSession';

export function FullScreenSpinner() {
  return (
    <div className="flex min-h-dvh items-center justify-center text-primary">
      <Spinner size="lg" />
    </div>
  );
}

/**
 * Gate for signed-in areas. `onboarding="complete"` sends users who haven't finished setup to
 * onboarding; `onboarding="incomplete"` sends finished users back into the app.
 */
export function RequireSession({ onboarding }: { onboarding: 'complete' | 'incomplete' }) {
  const me = useMe();
  const location = useLocation();

  if (me.isPending) return <FullScreenSpinner />;
  if (me.isError) {
    return (
      <div className="mx-auto max-w-app px-4 pt-16">
        <ErrorState title="Can't reach mahilaSathi" message={me.error.message} onRetry={() => void me.refetch()} retrying={me.isFetching} />
      </div>
    );
  }
  if (!me.data) return <Navigate to="/welcome" replace state={{ from: location.pathname }} />;
  if (onboarding === 'complete' && !me.data.onboardingCompleted) return <Navigate to="/onboarding" replace />;
  if (onboarding === 'incomplete' && me.data.onboardingCompleted) return <Navigate to="/" replace />;
  return <Outlet />;
}

/** For public auth screens: a signed-in user goes straight into the app. */
export function RedirectIfSignedIn() {
  const me = useMe();
  if (me.isPending) return <FullScreenSpinner />;
  if (me.data) return <Navigate to={me.data.onboardingCompleted ? '/' : '/onboarding'} replace />;
  return <Outlet />;
}
