import { EMERGENCY_NUMBERS } from '@mahilasathi/shared';
import { AlertCircle, Phone, RotateCcw } from 'lucide-react';
import { isRouteErrorResponse, useRouteError } from 'react-router-dom';
import { Button } from '@/components/ui';

/**
 * Shown when a screen fails to load or render: most often a code chunk that couldn't download (offline, or
 * the app was updated since this page opened). Always offers the emergency number.
 */
export function RouteError() {
  const error = useRouteError();
  const chunk = error instanceof Error && /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(error.message);
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return (
    <div role="alert" className="mx-auto flex min-h-dvh max-w-app flex-col items-center justify-center gap-4 px-6 text-center">
      <AlertCircle className="h-10 w-10 text-danger" aria-hidden />
      <h1 className="text-xl font-semibold">{notFound ? 'Page not found' : chunk ? 'This screen couldn’t load' : 'Something went wrong'}</h1>
      <p className="max-w-sm text-sm text-fg-muted">
        {chunk ? 'Check your connection, or the app may have been updated. Reloading usually fixes it.' : 'Reload to try again. Your data is safe on the server.'}
      </p>
      <Button icon={<RotateCcw className="h-4 w-4" aria-hidden />} onClick={() => window.location.reload()}>Reload</Button>
      <a href={`tel:${EMERGENCY_NUMBERS.national}`} className="mt-2 inline-flex items-center gap-2 font-semibold text-danger underline">
        <Phone className="h-4 w-4" aria-hidden /> In an emergency, call {EMERGENCY_NUMBERS.national}
      </a>
    </div>
  );
}
