import { defineConfig } from 'vitest/config';

// Unit/integration tests run under happy-dom: the overlay/modal chrome (focus, keydown, document.body
// mounting) and the file explorer's role=tree (focus, keyboard nav, DOM rebuild) behave as they do in
// the browser; the browser fs ops are driven against mocked File-System-Access handles.
export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
    // happy-dom 20 has no Web Storage; the setup installs an in-memory localStorage shim.
    setupFiles: ['./src/test-setup.ts'],
  },
});
