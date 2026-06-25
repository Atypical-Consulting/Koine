import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';

const dirname = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));

// The `studio (windows-latest)` runner intermittently failed `npm test` with a native libuv abort —
// `Assertion failed: !_wcsnicmp(filename, dir, dirlen), file src\win\fs-event.c, line 72` — fired
// *after* a fully green suite, exiting the process 1 during teardown (#414). Root cause: a Vitest
// `forks`-pool worker holds a native `fs.watch` handle (Vite uses Node's libuv `fs.watch` directly on
// Node >= 19 — vitejs/vite#12495), and the libuv Windows fs-event handle aborts on a path-case compare
// (libuv#693). Vitest 4's default `forks` pool is itself flaky on Windows (vitest-dev/vitest#8861,
// `os: windows`). Two layered measures below kill it:
//
//   1. `pool: 'threads'` on Windows (see `isWindows`) — the worker_threads pool has no per-fork child
//      process whose teardown holds/aborts on the native fs-event handle. This is the operative fix.
//   2. `server.watch: null` for the one-shot run (see `isOneShotRun`) — a `vitest run` never needs a
//      file watcher, so don't start the Vite dev-server watcher at all. Hygiene/defense-in-depth that
//      shrinks the native-watcher surface; not sufficient alone (the aborting watcher lives in the
//      worker, which this root server config does not govern), but correct and cheap to keep.
//
// Both are scoped so human watch-mode (`npm run test:watch` → bare `vitest`) and non-Windows dev are
// untouched, and the test set/count is identical on every OS leg.
// @ts-expect-error process is a nodejs global
const isOneShotRun = process.argv.includes('run');
// @ts-expect-error process is a nodejs global
const isWindows = process.platform === 'win32';

// Unit/integration tests run under happy-dom: the overlay/modal chrome (focus, keydown, document.body
// mounting) and the file explorer's role=tree (focus, keyboard nav, DOM rebuild) behave as they do in
// the browser; the browser fs ops are driven against mocked File-System-Access handles. The second
// `storybook` project runs every story as a browser test via @storybook/addon-vitest (Playwright/Chromium).
// More info at: https://storybook.js.org/docs/next/writing-tests/integrations/vitest-addon
export default defineConfig({
  // Measure 2 (see the header note): no Vite dev-server file watcher for the one-shot `vitest run`.
  // `extends: true` propagates this root server config into both projects below.
  server: isOneShotRun ? { watch: null } : {},
  // Transpile JSX with the Preact automatic runtime so .tsx tests (and the panels they exercise)
  // compile without a React import — matches tsconfig's jsx/jsxImportSource. Vite 8 / Vitest 4 use
  // oxc (not esbuild) as the default transformer, so the JSX runtime is configured under `oxc.jsx`
  // (the plan's `esbuild: { jsx, jsxImportSource }` snippet would be ignored here).
  oxc: {
    jsx: {
      runtime: 'automatic',
      importSource: 'preact'
    }
  },
  // Alias React's runtime to Preact's compat layer — the SAME alias vite.config.ts declares — so the
  // `zustand` React hook (`useStore`, imported from bare `react`) resolves under vitest's happy-dom
  // run. Vitest does not share vite.config.ts's resolve.alias, so the panel tests need it here too.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      react: 'preact/compat',
      'react-dom': 'preact/compat',
      'react/jsx-runtime': 'preact/jsx-runtime'
    }
  },
  test: {
    projects: [{
      extends: true,
      test: {
        environment: 'happy-dom',
        // Measure 1 (see the header note): the operative fix for the #414 Windows fs-event abort.
        // On windows-latest the default `forks` pool's worker holds a native libuv `fs.watch` that
        // aborts the process after a green suite; worker_threads has no such per-fork teardown. Scoped
        // to Windows so Linux/macOS (local dev + CI) keep the faster default forks pool. Same tests run.
        pool: isWindows ? 'threads' : 'forks',
        // The IDE boot tests do a cold `await import('@/shell/ide')` (a large module graph) + a full
        // init(); on slow CI runners (notably windows-latest) that first transform+import alone can
        // exceed the 5s default and time the test out. Give a generous ceiling that still catches a
        // genuine hang. Applies to both tests and hooks.
        testTimeout: 20000,
        hookTimeout: 20000,
        // Inline zustand so its React entry (`import React from 'react'`) is transformed through the alias
        // above instead of being externalized and resolved by Node (which has no `react` package). Without
        // this the panel tests fail with "Cannot find package 'react'".
        server: {
          deps: {
            inline: ['zustand']
          }
        },
        include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.mjs'],
        environmentMatchGlobs: [
          // scripts tests run in Node — no DOM needed
          ['scripts/**', 'node'],
        ],
        // Generate the git-ignored src/templates.generated.ts before any test imports it. Covers every
        // vitest entry point (vitest run / test:watch / bare vitest), which npm pre-hooks alone do not.
        globalSetup: ['./scripts/vitest-global-setup.mjs'],
        // happy-dom 20 has no Web Storage; the setup installs an in-memory localStorage shim.
        setupFiles: ['./src/test-setup.ts']
      }
    }, {
      extends: true,
      plugins: [
      // The plugin will run tests for the stories defined in your Storybook config
      // See options at: https://storybook.js.org/docs/next/writing-tests/integrations/vitest-addon#storybooktest
      storybookTest({
        configDir: path.join(dirname, '.storybook')
      })],
      test: {
        name: 'storybook',
        browser: {
          enabled: true,
          headless: true,
          provider: playwright({}),
          instances: [{
            browser: 'chromium'
          }]
        }
      }
    }]
  }
});
