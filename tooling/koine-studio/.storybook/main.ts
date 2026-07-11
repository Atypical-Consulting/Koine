import type { StorybookConfig } from '@storybook/preact-vite';
import { fileURLToPath } from 'node:url';

// Storybook for the Studio's Preact panels. The @storybook/preact-vite framework supplies the
// react→preact/compat aliasing (so the zustand React hook the panels use resolves), and we re-assert the
// project's `@/` → src alias here so a story's `@/model/...` import resolves the same as in the app build.
const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-a11y', '@storybook/addon-vitest'],
  framework: { name: '@storybook/preact-vite', options: {} },
  core: { disableTelemetry: true },
  async viteFinal(cfg) {
    const { mergeConfig } = await import('vite');
    // Pin a SINGLE preact instance. Without this, Storybook pre-bundles `preact/compat` (pulled in by the
    // panels' zustand `useStore`, since the app aliases react→preact/compat) into an optimized-deps chunk
    // that carries its own `preact/hooks` — separate from the preact rendering the story. Hooks then read
    // `__H` off the wrong (undefined) current-component → "Cannot read properties of undefined (reading
    // '__H')". `dedupe` + the explicit react aliases (mirroring vite.config.ts) collapse it to one instance.
    return mergeConfig(cfg, {
      resolve: {
        // #1470: mirror vitest.config.ts's koine-ui→source alias here too — without it, a story that
        // imports a component straight from `@atypical/koine-ui` (e.g. DocsPanelHost.stories.tsx) still
        // resolves through the workspace-symlinked, gitignored `dist/`, which only `npm install`'s
        // postinstall rebuilds; a stale dist can silently export `undefined` for a newly-added component,
        // and Preact renders that as literal "[object Object]" text with no thrown error (the exact bug
        // this issue fixes). Without this, `npx vitest run --project storybook` would stay green against
        // fresh source while real Storybook (`npm run storybook` / `build-storybook`) rendered the stale
        // dist — the opposite of the vitest addon's "proves what Storybook shows" contract. Array form
        // with an exact-match RegExp (not a plain string) so it doesn't also rewrite this file's own deep
        // import `@atypical/koine-ui/styles.css` (preview.ts) onto a nonsensical path.
        alias: [
          { find: '@', replacement: fileURLToPath(new URL('../src', import.meta.url)) },
          { find: /^@atypical\/koine-ui$/, replacement: fileURLToPath(new URL('../../koine-ui/src/index.ts', import.meta.url)) },
          { find: 'react', replacement: 'preact/compat' },
          { find: 'react-dom', replacement: 'preact/compat' },
          { find: 'react/jsx-runtime', replacement: 'preact/jsx-runtime' },
        ],
        dedupe: ['preact', 'preact/compat', 'preact/hooks', 'preact/jsx-runtime'],
      },
      // The framework serves `preact` raw but pre-bundles `preact/compat`+`preact/hooks` (pulled in by
      // the panels' zustand `useStore`) into a separate optimized chunk with its OWN hooks copy → two
      // instances → the `__H` crash. Excluding the whole preact family from pre-bundling forces them all
      // to the single raw node_modules copy, so hooks share one current-component.
      optimizeDeps: {
        exclude: ['preact', 'preact/compat', 'preact/hooks', 'preact/jsx-runtime'],
      },
    });
  },
};

export default config;
