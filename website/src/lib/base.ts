// Shared Astro base-path helper for the docs-site (issue #369).
//
// `astro.config.mjs` sets `base: '/Koine/'`, surfaced at runtime as `import.meta.env.BASE_URL`.
// Several call sites — the Playground worker/controller, the service-worker registration, and the
// `.astro` pages/layout — need that base with its trailing slash stripped, and the SW scope and the
// dedicated worker's `/koine-wasm/_framework/*` URL MUST be derived from the *same* definition or
// cache interception silently breaks (see #328, #362). Keep that math here, in exactly one place.

/** Astro's site base with any trailing slash stripped (e.g. '/Koine/' → '/Koine', '/' → ''). */
export function basePath(): string {
  return (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
}
