import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';

const dirname = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));

// Unit/integration tests run under happy-dom: the overlay/modal chrome (focus, keydown, document.body
// mounting) and the file explorer's role=tree (focus, keyboard nav, DOM rebuild) behave as they do in
// the browser; the browser fs ops are driven against mocked File-System-Access handles. The second
// `storybook` project runs every story as a browser test via @storybook/addon-vitest (Playwright/Chromium).
// More info at: https://storybook.js.org/docs/next/writing-tests/integrations/vitest-addon
export default defineConfig({
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
