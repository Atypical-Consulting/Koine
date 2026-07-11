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
//
// A second, distinct studio flake (#493, observed on ubuntu-latest) has the same "green suite, crashing
// teardown" shape: CodeMirror's EditorView captures its owning window as `this.win` and reads
// `this.win.requestAnimationFrame` from a DEFERRED measure (its DOMObserver.onResize schedules a 50ms
// setTimeout → view.requestMeasure()). When that timer fires after the owning test/file has ended and
// happy-dom has torn the window's rAF down, the read throws an uncaught
// `TypeError: this.win.requestAnimationFrame is not a function`, which Vitest counts as a run error and
// exits the worker non-zero despite every test passing. The operative fix is teardown hygiene —
// editor-mounting suites (editorSession.test.ts and the actions.test.ts peer) destroy() every
// EditorView in `afterEach`, so no measure stays queued past a test. `src/test-setup.ts` also installs a
// setTimeout-backed requestAnimationFrame shim as defense-in-depth (inert under happy-dom 20, which
// already ships rAF; it guards a future happy-dom that drops it, and never clobbers a real browser rAF).
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
  //
  // `@atypical/koine-ui` is aliased straight to its TS source (not the npm-workspace-symlinked, built
  // `dist/`): normally that dist is rebuilt by `npm install`'s postinstall, but nothing rebuilds it
  // automatically between installs — a worktree/checkout whose node_modules predates a koine-ui source
  // change (e.g. a newly added export) silently resolves that export to `undefined`. Preact then renders
  // the resulting `h(undefined, …)` vnode as the literal text "[object Object]" with no thrown error,
  // which is exactly the `GlossaryPanel` regression in #1470 — reproduced by deliberately building
  // koine-ui's dist from before its `GlossaryPanel` export existed. Aliasing to source makes the test
  // suite immune to that staleness class entirely, independent of node_modules/dist state. Array form
  // (not the `{find: replacement}` object shorthand used elsewhere in this file) so the koine-ui find can
  // be an exact-match RegExp — a plain string prefix-matches, which would also rewrite the unrelated deep
  // import `@atypical/koine-ui/styles.css` (main.ts) onto a nonsensical path.
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      { find: /^@atypical\/koine-ui$/, replacement: fileURLToPath(new URL('../koine-ui/src/index.ts', import.meta.url)) },
      { find: 'react', replacement: 'preact/compat' },
      { find: 'react-dom', replacement: 'preact/compat' },
      { find: 'react/jsx-runtime', replacement: 'preact/jsx-runtime' }
    ]
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
        // codemirror-json-schema is inlined for a different reason: its published ESM emits extensionless
        // relative imports (e.g. `from './features/completion'`) that Node's native ESM resolver rejects
        // when the dep is externalized. Inlining routes it through Vite's resolver (which adds the `.js`),
        // so the settings-JSON editor tests can import it. Vite's prod build already resolves it fine.
        server: {
          deps: {
            inline: ['zustand', 'codemirror-json-schema']
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
