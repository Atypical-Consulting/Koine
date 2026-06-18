import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const studioBase = process.env.KOINE_STUDIO_BASE;

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
);

// https://vite.dev/config/
//
// Two modes:
//   • default  — Tauri desktop dev/build (fixed port 1420, Rust error passthrough).
//   • `web`    — the studio as a plain web page (browser backend + WASM compiler). Set
//                KOINE_STUDIO_BASE (e.g. /Koine/studio/) for a sub-path deployment.
export default defineConfig(({ mode }) => {
  const web = mode === "web";
  return {
    // Sub-path base for the deployed web build; '/' for local dev and the Tauri build.
    base: web ? studioBase || "/" : "/",

    // Expose the app version to the browser backend's About dialog (the desktop backend reads it
    // from the Tauri `app_version` command instead).
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },

    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,

    server: web
      ? {
          // Web dev server: a distinct port from Tauri's, and not strict so it can fall back.
          port: 1430,
          strictPort: false,
        }
      : {
          // 2. tauri expects a fixed port, fail if that port is not available
          port: 1420,
          strictPort: true,
          host: host || false,
          hmr: host
            ? {
                protocol: "ws",
                host,
                port: 1421,
              }
            : undefined,
          watch: {
            // 3. tell Vite to ignore watching `src-tauri`
            ignored: ["**/src-tauri/**"],
          },
        },
  };
});
