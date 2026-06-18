import { defineConfig } from "vitest/config";

// Unit tests run against a happy-dom DOM so the overlay/modal chrome (focus, keydown,
// document.body mounting) behaves as it does in the browser.
export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts"],
  },
});
