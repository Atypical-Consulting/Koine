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
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
      rollupTypes: true,
    }),
  ],
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
});
