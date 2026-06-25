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
        alias: {
          '@': fileURLToPath(new URL('../src', import.meta.url)),
          react: 'preact/compat',
          'react-dom': 'preact/compat',
          'react/jsx-runtime': 'preact/jsx-runtime',
        },
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
