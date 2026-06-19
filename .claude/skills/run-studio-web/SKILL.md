---
name: run-studio-web
description: >-
  Launch and drive Koine Studio in WEB mode — the browser host of the Studio IDE
  (`tooling/koine-studio` run as a plain web page with the browser backend + Blazor
  WASM compiler, no Tauri/Rust sidecar). Use when asked to run, start, serve,
  screenshot, or verify a change in Koine Studio Web / the WASM studio in a browser.
  For the Tauri DESKTOP build (`npm run tauri dev`) or the `Koine.Cli` compiler,
  this is the wrong skill.
---

# Run Koine Studio (Web)

The web build runs the Studio frontend (`tooling/koine-studio/src/`) as an ordinary
Vite-served page. There is **no Tauri/Rust host** in this mode — the language service
and emitter run client-side as a Blazor **WASM** module (`src/Koine.Wasm`). Vite serves
on **port 1430** (`--mode web`, non-strict so it may fall back to 1431+).

## Prerequisites (one-time)

- **Node** + studio deps: `cd tooling/koine-studio && npm install`
- **.NET SDK 10** + WASM workloads — `scripts/build-wasm.mjs` does a
  `dotnet publish -c Release` of `Koine.Wasm`, which needs:
  ```bash
  dotnet workload install wasm-tools wasm-experimental
  ```

## Launch

```bash
cd tooling/koine-studio
npm run dev:web
```

`predev:web` runs `node scripts/build-wasm.mjs` first — it publishes `src/Koine.Wasm`
(Release) and copies the AppBundle (`_framework` + loader) into
`public/koine-wasm/`, which the browser backend loads as
`${BASE_URL}koine-wasm/_framework/dotnet.js`. **This step is slow** (a full WASM
Release publish, minutes on a cold build). Run it in the background and wait for Vite's
`Local: http://localhost:1430/` line — that URL is the source of truth (honor the
fallback port if 1430 was taken).

If you only changed frontend code and the WASM bundle in `public/koine-wasm/` already
exists, you can skip the rebuild with a plain `vite --mode web` (via `npx vite --mode web`)
to start faster — but the first run of a session must build the WASM.

## Drive it (don't just launch it)

Launching only proves Vite served the page. Drive it the way a user would, in a browser:

1. Navigate to the served URL.
2. **Wait for the WASM runtime to boot** — the editor is non-functional until
   `dotnet.js` finishes loading; watch for diagnostics/preview to become live (give it a
   few seconds and re-check, don't screenshot the blank first frame).
3. Type representative `.koi` source into the CodeMirror editor (e.g. a small value
   object or aggregate). Confirm:
   - **diagnostics** update in the lint strip (push-based, debounced), and
   - the **emitted-code preview** pane renders C#/TypeScript.
4. **Screenshot the window and look at it.** A blank pane = WASM didn't boot (failure to
   launch), not success.

Use the browser-driving pattern from the `run` skill's `examples/playwright.md`
(`chromium-cli` against the Vite URL) — no custom driver is needed for the web host.

## Notes / gotchas

- **MCP panel is degraded by design in web mode.** The web build passes
  `mcpHostable: false` (a browser page can't host the `koine mcp --http` server), so
  Settings → MCP shows the toggle/test rows disabled; only the copy-paste client recipes
  render. Don't treat that as a bug.
- **Sub-path deploys:** `KOINE_STUDIO_BASE` (e.g. `/Koine/studio/`) sets Vite's `base`.
  For local runs leave it unset (defaults to `/`).
- If the WASM publish fails on `dotnet`, the missing piece is almost always the
  `wasm-tools wasm-experimental` workloads — install them (above) and re-run.
