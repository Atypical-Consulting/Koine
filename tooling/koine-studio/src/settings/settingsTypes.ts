// Types-only module (no imports, no runtime) — the shared home for the Settings page's editor-mode
// and JSON-scope unions (#983/#1086). Both settingsPage.tsx and the uiChrome store slice import from
// here instead of each defining their own copy: settingsPage owns the Settings UI, uiChrome owns the
// persisted UI-chrome state, and neither should depend on the other's module (that dependency would
// cycle — the slice is imported well before the page mounts). A types-only module is erased at build
// time, so importing it from either side can never create a runtime cycle. See #1094.

/** The Settings page's editor representation (#983): the two-pane Visual form or the raw settings.json. */
export type SettingsEditorMode = 'visual' | 'json';

/** Which settings document the Settings JSON editor targets (#983): the user document or the
 *  workspace-scoped overrides. */
export type SettingsJsonScope = 'user' | 'workspace';
