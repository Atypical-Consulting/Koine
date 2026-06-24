// Single source of truth for "is this a dev build" — reusable by any future dev-only Studio tool.
//
// Reads `import.meta.env.DEV`, which Vite sets from the serve-vs-build COMMAND (not `--mode`): it is
// `true` under both `run-ide` (tauri dev → vite serve) and `run-ide-web` (vite --mode web serve), and
// `false` in every production build (`vite build` / `vite build --mode web`). That makes it exactly the
// right gate for keeping dev-only surfaces (like the store inspector) out of shipped bundles.
//
// Kept a FUNCTION on purpose — reading `import.meta.env.DEV` at call time (not capturing it in a module
// constant) is what lets tests flip it with `vi.stubEnv('DEV', …)`.
export function isDevMode(): boolean {
  return import.meta.env.DEV;
}
