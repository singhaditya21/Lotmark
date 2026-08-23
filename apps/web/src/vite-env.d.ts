/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Set only by the demo build.
   *
   * Declared so it can be read as `import.meta.env.VITE_DEMO` rather than
   * `import.meta.env['VITE_DEMO']`. That is not style: Vite's define plugin
   * substitutes the DOT form with a literal at build time, which is what lets
   * Rollup eliminate the branch and drop the demo chunk. With bracket access the
   * substitution does not happen, the branch stays live, and a normal build
   * ships the entire recorded fixture — measured, before this file existed.
   */
  readonly VITE_DEMO?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
