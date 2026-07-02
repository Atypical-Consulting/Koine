import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import dts from 'vite-plugin-dts';

// Library-mode build for the publishable @atypical/koine-ui package: a single ESM entry
// (src/index.ts) plus rolled-up .d.ts declarations. `preact` is external — it's a peer
// dependency, so consumers (koine-studio, website) resolve a single shared Preact instance
// instead of bundling a second copy (the Preact-singleton rule; see MEMORY.md).
export default defineConfig({
  plugins: [
    dts({
      include: ['src'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/**/*.stories.tsx'],
      rollupTypes: true,
    }),
  ],
  // Transpile JSX with Preact's automatic runtime (issue #905, Task 4 — the moved presentational
  // components are the first .tsx in this package). Vite 8 / Vitest 4 use oxc (not esbuild) as the
  // default transformer, so this has to live under `oxc.jsx` rather than `esbuild.jsx` — matches
  // koine-studio's own vitest.config.ts note on the same gotcha.
  oxc: {
    jsx: {
      runtime: 'automatic',
      importSource: 'preact',
    },
  },
  build: {
    lib: {
      entry: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'index.js',
      // src/index.ts imports './styles.css' as a side effect so Vite's library build extracts the
      // design tokens (issue #905, Task 2) into their own file; name it to match the package.json
      // "./styles.css" export (Vite's default would otherwise derive the name from package.json's
      // `name`, i.e. a scoped/slashed string, not "styles.css").
      cssFileName: 'styles',
    },
    rollupOptions: {
      external: ['preact', 'preact/hooks', 'preact/jsx-runtime'],
    },
    sourcemap: true,
  },
  test: {
    // The DOM/utility primitives (issue #905, Task 3) build and mount real elements
    // (document.createElement, event listeners, focus) — happy-dom gives them a DOM to run
    // against, matching koine-studio's own vitest environment for this same code. The moved
    // presentational components (Task 4) render through @testing-library/preact into the same DOM.
    environment: 'happy-dom',
    setupFiles: ['./src/test-setup.ts'],
  },
});
