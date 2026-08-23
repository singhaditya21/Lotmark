import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  /**
   * The demo is published under a repository subpath, so its assets are
   * requested from `/Lotmark/assets/…` rather than the root. A normal build
   * keeps `/` — a stray subpath there would break the real deployment, and
   * silently, because index.html would still load.
   */
  base: process.env['VITE_DEMO'] ? '/Lotmark/' : '/',
  plugins: [react()],
  server: {
    port: 5173,
    /**
     * The API is proxied under the SAME ORIGIN as the console.
     *
     * Without this the browser sees http://localhost:5173 calling
     * http://127.0.0.1:4000 — a cross-site request, so the session cookie is
     * not sent and nobody can sign in during development. Proxying keeps one
     * origin, which means the cookie needs no SameSite relaxation and
     * development matches production behaviour instead of diverging from it.
     */
    proxy: {
      '/api': { target: 'http://127.0.0.1:4000', changeOrigin: false },
    },
  },
});
