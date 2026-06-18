import { defineConfig } from 'vitest/config';

// Unit/integration tests for the studio's host fs layer and the explorer UI run under jsdom
// (the explorer builds real DOM; the browser fs ops are driven against mocked FS-Access handles).
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
});
