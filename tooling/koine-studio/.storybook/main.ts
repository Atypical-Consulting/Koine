import type { StorybookConfig } from '@storybook/preact-vite';
import { fileURLToPath } from 'node:url';

// Storybook for the Studio's Preact panels. The @storybook/preact-vite framework supplies the
// react→preact/compat aliasing (so the zustand React hook the panels use resolves), and we re-assert the
// project's `@/` → src alias here so a story's `@/model/...` import resolves the same as in the app build.
const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-a11y'],
  framework: { name: '@storybook/preact-vite', options: {} },
  core: { disableTelemetry: true },
  async viteFinal(cfg) {
    cfg.resolve ??= {};
    cfg.resolve.alias = {
      ...(cfg.resolve.alias as Record<string, string> | undefined),
      '@': fileURLToPath(new URL('../src', import.meta.url)),
    };
    return cfg;
  },
};

export default config;
