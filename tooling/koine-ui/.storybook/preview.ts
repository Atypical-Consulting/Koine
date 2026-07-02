import type { Preview } from '@storybook/preact-vite';
// The package's own stylesheet — design tokens + the moved components' CSS (issue #905, Tasks 2 & 4) —
// so stories render with real koi-* theming instead of unstyled bare DOM. Mirrors how a consuming app
// imports '@atypical/koine-ui/styles.css'.
import '../src/styles.css';

const preview: Preview = {
  parameters: {
    // These components were designed for Koine Studio's dark shell; render stories on a matching
    // surface so they read correctly (mirrors koine-studio's own Storybook preview).
    backgrounds: {
      default: 'studio',
      values: [
        { name: 'studio', value: '#15161a' },
        { name: 'light', value: '#ffffff' },
      ],
    },
    // Surface accessibility findings inline (WCAG 2.1 AA — see CLAUDE.md).
    a11y: { test: 'error' },
  },
};

export default preview;
