import { defineConfig, type Plugin } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// The template-manifest generator. Its pure core is exported from the .mjs so this plugin can
// regenerate src/templates.generated.ts at the start of every build and on `templates/` changes
// during dev (HMR), keeping the studio in sync with the repo's single source of truth (#101).
import {
  generate as generateTemplates,
  resolveTemplatesDir,
} from "./scripts/generate-templates.mjs";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const studioBase = process.env.KOINE_STUDIO_BASE;

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
);

// Regenerate src/templates.generated.ts before each build (buildStart) and watch the repo
// `templates/` dir during dev so editing a template.json / .koi regenerates the manifest and
// triggers an HMR reload. This is belt-and-suspenders alongside the npm pre-scripts: it covers
// `dev`/`dev:web`/`build`/`build:web` and live edits to templates while the server is running.
function templateManifestPlugin(): Plugin {
  const templatesDir = resolveTemplatesDir();
  return {
    name: "koine-template-manifest",
    buildStart() {
      generateTemplates();
    },
    configureServer(server) {
      // Generate once up front (dev has no buildStart), then watch the templates tree.
      generateTemplates();
      server.watcher.add(templatesDir);
      const onChange = (file: string) => {
        if (!file.startsWith(templatesDir)) return;
        if (!/template\.json$/.test(file) && !/\.koi$/.test(file)) return;
        try {
          generateTemplates();
          server.ws.send({ type: "full-reload" });
        } catch (e) {
          server.config.logger.error(`[koine-template-manifest] ${String(e)}`);
        }
      };
      server.watcher.on("add", onChange);
      server.watcher.on("change", onChange);
      server.watcher.on("unlink", onChange);
    },
  };
}

// https://vite.dev/config/
//
// Two modes:
//   • default  — Tauri desktop dev/build (fixed port 1420, Rust error passthrough).
//   • `web`    — the studio as a plain web page (browser backend + WASM compiler). Set
//                KOINE_STUDIO_BASE (e.g. /Koine/studio/) for a sub-path deployment.
export default defineConfig(({ mode }) => {
  const web = mode === "web";
  return {
    plugins: [templateManifestPlugin()],

    // Alias React's runtime to Preact's compat layer so the `zustand` React hook (`useStore`) and
    // any React-shaped deps resolve to Preact. Vanilla Zustand (`zustand/vanilla`) needs none of this;
    // the alias only matters once Preact panels consume the store through the React entry point.
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
        react: "preact/compat",
        "react-dom": "preact/compat",
        "react/jsx-runtime": "preact/jsx-runtime",
      },
    },

    // Sub-path base for the deployed web build; '/' for local dev and the Tauri build.
    base: web ? studioBase || "/" : "/",

    // Expose the app version to the browser backend's About dialog (the desktop backend reads it
    // from the Tauri `app_version` command instead).
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },

    // Pre-bundle the diagram tab's heavy, lazily-imported engines at server startup. Both are only
    // `import()`-ed the first time the Diagram tab renders (see src/diagrams.ts / diagrams-svg.ts);
    // without this, Vite discovers them lazily, re-runs its dep optimizer mid-session, bumps the
    // optimized-deps hash, and the in-flight dynamic import 404s with "Failed to fetch dynamically
    // imported module". Pre-including them keeps the hash stable so the tab loads first try.
    optimizeDeps: {
      include: ["elkjs/lib/elk.bundled.js", "mermaid"],
    },

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
