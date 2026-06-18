import { defineConfig } from 'vitest/config';

// Unit tests for the studio's pure logic (project-name helpers, zip assembly, the
// can-generate guard). Node environment is enough — nothing here touches the DOM.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
