import { defineConfig } from 'vitest/config';

// Unit/integration tests run under happy-dom: the overlay/modal chrome (focus, keydown, document.body
// mounting) and the file explorer's role=tree (focus, keyboard nav, DOM rebuild) behave as they do in
// the browser; the browser fs ops are driven against mocked File-System-Access handles.
export default defineConfig({
  // Transpile JSX with the Preact automatic runtime so .tsx tests (and the panels they exercise)
  // compile without a React import — matches tsconfig's jsx/jsxImportSource. Vite 8 / Vitest 4 use
  // oxc (not esbuild) as the default transformer, so the JSX runtime is configured under `oxc.jsx`
  // (the plan's `esbuild: { jsx, jsxImportSource }` snippet would be ignored here).
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.mjs'],
    environmentMatchGlobs: [
      // scripts tests run in Node — no DOM needed
      ['scripts/**', 'node'],
    ],
    // Generate the git-ignored src/templates.generated.ts before any test imports it. Covers every
    // vitest entry point (vitest run / test:watch / bare vitest), which npm pre-hooks alone do not.
    globalSetup: ['./scripts/vitest-global-setup.mjs'],
    // happy-dom 20 has no Web Storage; the setup installs an in-memory localStorage shim.
    setupFiles: ['./src/test-setup.ts'],
  },
});
