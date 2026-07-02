import type { Preview } from '@storybook/preact-vite';
// The --koi-* design tokens (dark/light theme + DDD-construct hues) live in the @atypical/koine-ui
// package (issue #905); import it before main.scss so every var(--koi-*) reference below resolves,
// same ordering as the real app boot (src/main.ts).
import '@atypical/koine-ui/styles.css';
// Load the app's global stylesheet so panels render with their real koi-* styling (theme custom
// properties, typography, the panel chrome) instead of unstyled bare DOM.
import '@/styles/main.scss';

const preview: Preview = {
  parameters: {
    // The Studio shell is dark; render stories on a matching surface so the panels read correctly.
    backgrounds: {
      default: 'studio',
      values: [
        { name: 'studio', value: '#15161a' },
        { name: 'light', value: '#ffffff' },
      ],
    },
    // Surface accessibility findings inline (ties into the WCAG enforcement added to the test suite).
    a11y: { test: 'error' },
  },
};

export default preview;
