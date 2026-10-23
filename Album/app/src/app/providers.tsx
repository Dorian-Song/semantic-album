import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { useCallback, type ReactNode } from 'react';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false } },
});

export function Providers({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

/** Refetches library views (albums, galleries, photo details) after any change. Job polling is separate. */
export function useRefreshLibrary(): () => void {
  const qc = useQueryClient();
  return useCallback(() => void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'jobs' }), [qc]);
}
