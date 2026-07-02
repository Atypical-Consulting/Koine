import type { StorybookConfig } from '@storybook/preact-vite';

// Storybook for @atypical/koine-ui's presentational components (issue #905, Task 4). No `@/` alias or
// react→preact/compat aliasing is needed here — unlike koine-studio, this package has no zustand/React
// compat surface to reconcile; every component is plain Preact with plain props/callbacks, and its
// stories import components by relative path.
const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-a11y'],
  framework: { name: '@storybook/preact-vite', options: {} },
  core: { disableTelemetry: true },
};

export default config;
