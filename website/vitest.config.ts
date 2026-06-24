import { defineConfig } from 'vitest/config';

// Minimal Vitest config for the website's playground unit tests.
// Tests run in Node environment (no DOM needed — the playground logic under test is purely
// concerned with worker-client wiring, which is mocked). No Astro build is involved.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
