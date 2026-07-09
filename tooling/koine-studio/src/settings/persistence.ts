// Koine Studio persistence layer: typed settings plus the recent-folders list, all
// backed by localStorage. Pure data — no DOM, no Tauri. Every read is guarded against
// absent storage and malformed JSON so a corrupt key never breaks the app; every write
// is best-effort and swallows quota/security errors.
//
// One field is special: aiApiKey is a secret and is NEVER written to the plaintext localStorage
// blob. It lives encrypted in IndexedDB (secrets.ts) and is decrypted once at boot (initSecrets)
// into an in-memory cache, so the synchronous Settings API can keep exposing it without leaking it
// to disk in the clear.

// Re-exported so the barrel's public surface (initSecrets/whenSecretsReady/saveApiKey/clearApiKey) is
// unchanged; getCachedApiKey is intentionally NOT re-exported (barrel-private, see settings/secrets.ts).
export { initSecrets, whenSecretsReady, saveApiKey, clearApiKey } from './secrets';

// The Settings model (types, defaults, coercion, load/save/patch), the workspace-override store, and
// the keybinding-override store live in settingsStore.ts; re-exported so this barrel's public surface
// (Settings, DEFAULT_SETTINGS, loadSettings, workspaceKeyOf, resolveKeybindings, etc.) is unchanged.
export * from './settingsStore';

// The recent-folders list, legacy scratch migration, workspace center/deck, last-opened-workspace
// pointer, last-session resume snapshot, active-context scope, and per-workspace chat transcript live
// in workspaceState.ts; re-exported so this barrel's public surface is unchanged.
export * from './workspaceState';

// Diagram canvas zoom, node positions, and canvas-only annotations live in diagramState.ts;
// re-exported so this barrel's public surface is unchanged.
export * from './diagramState';
