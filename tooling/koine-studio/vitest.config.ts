import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';

const dirname = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));

// On the Windows runner, `vitest run`'s storybook browser project starts a Vite dev server whose
// file watcher falls back to Node's libuv `fs.watch` (src/win/fs-event.c). That native watcher
// aborts during teardown — `Assertion failed: !_wcsnicmp(filename, dir, dirlen), file
// src\win\fs-event.c, line 72` — failing the whole job *after* a fully green suite (#414). A one-shot
// run never needs to watch files, so disable the dev-server watcher for `vitest run` only, leaving
// human watch-mode (`npm run test:watch` → bare `vitest`) free to watch and re-run on change. The
// `test` npm script is `vitest run`, so the literal `run` arg is the reliable run-vs-watch signal.
// @ts-expect-error process is a nodejs global
const isOneShotRun = process.argv.includes('run');

// Unit/integration tests run under happy-dom: the overlay/modal chrome (focus, keydown, document.body
// mounting) and the file explorer's role=tree (focus, keyboard nav, DOM rebuild) behave as they do in
// the browser; the browser fs ops are driven against mocked File-System-Access handles. The second
// `storybook` project runs every story as a browser test via @storybook/addon-vitest (Playwright/Chromium).
// More info at: https://storybook.js.org/docs/next/writing-tests/integrations/vitest-addon
export default defineConfig({
  // Disable the Vite dev-server file watcher for the non-interactive `vitest run` (see the note on
  // `isOneShotRun` above) so no native libuv `fs-event` watcher is carried into teardown on Windows.
  // `extends: true` propagates this root server config into BOTH projects below — the happy-dom
  // unit run and the storybook browser run (which spins up the Vite server that owns the watcher).
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
