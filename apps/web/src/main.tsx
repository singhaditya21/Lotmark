import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import './styles.css';
import { DemoBanner } from './demo/Banner';
import { DemoVerify, VerifyLanding, verifyTokenFromPath, isVerifyPath } from './demo/Verify';

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

/*
 * `/verify/<token>` is a public page, not part of the console.
 *
 * In production the API serves it before the SPA ever sees the path; in the
 * static demo there is no server, so the 404 fallback loads the app here and
 * this stands in. Guarded by VITE_DEMO and by the path, so a normal build folds
 * it away and the real console is never affected. It renders without the query
 * client or the banner — a person checking a certificate is not signed in and
 * should see nothing of the console around it.
 */
/*
 * `/verify/<token>` shows the result; the bare `/verify` shows a code box. Both
 * are demo only — the product serves them from the API — so a normal build
 * folds the whole branch to `null` and drops the Verify module.
 */
const onVerify = import.meta.env.VITE_DEMO && isVerifyPath();
const verifyToken = onVerify ? verifyTokenFromPath() : null;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {onVerify ? (
      verifyToken ? <DemoVerify token={verifyToken} /> : <VerifyLanding />
    ) : (
      <QueryClientProvider client={queryClient}>
        <App />
        {import.meta.env.VITE_DEMO ? <DemoBanner /> : null}
      </QueryClientProvider>
    )}
  </StrictMode>,
);
