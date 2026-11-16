import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { Spinner } from '@/components/ui';
import { ApiRequestError } from '@/services/apiClient';
import { router } from './router';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // Retry transient failures only; a 4xx will not fix itself.
      retry: (failureCount, error) =>
        failureCount < 2 && (!(error instanceof ApiRequestError) || error.status === 0 || error.status >= 500),
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider
        router={router}
        fallbackElement={
          <div className="flex min-h-dvh items-center justify-center" role="status" aria-label="Loading mahilaSathi">
            <Spinner />
          </div>
        }
      />
    </QueryClientProvider>
  );
}
