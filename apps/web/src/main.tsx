import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import './styles.css';
import { DemoBanner } from './demo/Banner';

/*
 * A build-time constant, so a normal build folds this to `false`, drops the
 * element and tree-shakes the component away. Kept as a static import because
 * a dynamic one here would be a top-level await, which the browser targets this
 * project builds for do not support.
 */
/*
 * Read inline at the use site rather than hoisted into a `const`.
 * `Boolean(import.meta.env.VITE_DEMO)` is not folded by the bundler, so the
 * banner — and the demo password it displays — survived into the production
 * bundle. Measured: one file matched `demo-viewer` after a normal build.
 */

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 401 means the session ended; retrying only delays the sign-in screen.
      retry: (count, error) =>
        count < 2 && !(error instanceof Error && error.name === 'ApiError'),
      staleTime: 5_000,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      {import.meta.env.VITE_DEMO ? <DemoBanner /> : null}
    </QueryClientProvider>
  </StrictMode>,
);
