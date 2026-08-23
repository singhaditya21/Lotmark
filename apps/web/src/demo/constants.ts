/**
 * Separate from the adapter on purpose.
 *
 * `Banner.tsx` needs the password and nothing else. Importing it from
 * `adapter.ts` would pull `fixture.json` — several hundred kilobytes of
 * recorded API responses — into the NORMAL build as well, because the banner is
 * statically imported so the bundler can tree-shake the render away.
 */
export const DEMO_PASSWORD = 'demo-viewer';
