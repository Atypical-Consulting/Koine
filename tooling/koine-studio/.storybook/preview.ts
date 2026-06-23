import type { Preview } from '@storybook/preact-vite';
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
