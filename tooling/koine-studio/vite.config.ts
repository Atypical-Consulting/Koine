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
// The PWA manifest generator. Its pure core (buildManifest/renderManifest) is exported from the .mjs
// so the plugin below and the vitest suite drive identical logic. The manifest's start_url/scope and
// icon srcs are prefixed by the resolved Vite `base` (KOINE_STUDIO_BASE) so the installed app works
// at the site root or under a sub-path.
import { buildManifest, renderManifest } from "./scripts/pwa-manifest.mjs";
// Dev-only plugin: serve `/koine-wasm/**` `?import` requests as raw assets so the browser WASM host's
// dynamic import of the published dotnet.js loader (a /public asset) doesn't trip Vite's transform
// middleware and pop the error overlay under the dev server (issue #384).
import { koineWasmDevPlugin } from "./src/dev/koineWasmDevMiddleware";

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

// Emit a base-aware PWA Web App Manifest so the studio is installable (Add to Home Screen / Install
// app). Mirrors templateManifestPlugin's shape: a pure generator (scripts/pwa-manifest.mjs) drives
// both the build emission and the dev middleware. The manifest's start_url/scope and icon srcs are
// prefixed with the resolved Vite `base` (KOINE_STUDIO_BASE), and the `<link rel="manifest">` +
// `<meta name="theme-color">` are injected through transformIndexHtml so they honour that base too.
function pwaManifestPlugin(): Plugin {
  let base = "/";
  const themeColor = buildManifest("/").theme_color;
  return {
    name: "koine-pwa-manifest",
    // base is only known once Vite has resolved the config (it depends on mode + KOINE_STUDIO_BASE).
    configResolved(config) {
      base = config.base;
    },
    // Build: emit manifest.webmanifest at the output root (served at `${base}manifest.webmanifest`).
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "manifest.webmanifest",
        source: renderManifest(base),
      });
    },
    // Dev: there is no bundle, so serve the manifest from memory at the base-aware URL.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0];
        if (url && url.endsWith("/manifest.webmanifest")) {
          res.setHeader("Content-Type", "application/manifest+json");
          res.end(renderManifest(base));
          return;
        }
        next();
      });
    },
    // Inject the manifest link + theme-color. order:'post' runs after Vite's own HTML asset rewriting,
    // so the href we build with the resolved base is emitted verbatim (no double base-prefixing).
    transformIndexHtml: {
      order: "post",
      handler() {
        return [
          {
            tag: "link",
            attrs: { rel: "manifest", href: `${base}manifest.webmanifest` },
            injectTo: "head",
          },
          {
            tag: "meta",
            attrs: { name: "theme-color", content: themeColor },
            injectTo: "head",
          },
        ];
      },
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
    plugins: [templateManifestPlugin(), pwaManifestPlugin(), koineWasmDevPlugin()],

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

    // Pre-bundle the diagram tab's heavy, lazily-imported engines at server startup. They are only
    // `import()`-ed the first time a diagram renders (maxGraph for the domain canvas — see
    // src/diagrams/diagrams-maxgraph.ts; mermaid for the context-map). Without this, Vite discovers
    // them lazily, re-runs its dep optimizer mid-session, bumps the optimized-deps hash, and the
    // in-flight dynamic import 404s with "Failed to fetch dynamically imported module". Pre-including
    // them keeps the hash stable so the tab loads first try.
    optimizeDeps: {
      include: ["mermaid", "@maxgraph/core"],
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
