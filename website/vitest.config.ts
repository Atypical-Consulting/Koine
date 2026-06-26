import { defineConfig } from 'vitest/config';

// Minimal Vitest config for the website's playground unit tests.
// Tests run in Node environment (no DOM needed — the playground logic under test is purely
// concerned with worker-client wiring, which is mocked). No Astro build is involved.
export default defineConfig({
  test: {
    environment: 'node',
    // src/**: playground worker-client unit tests. scripts/**: the smoke-test verdict logic
    // (classifyBootOutcome) — a pure, browser-free unit (the Chromium boot itself is `npm run
    // test:browser`, not part of this suite).
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
  },
});
