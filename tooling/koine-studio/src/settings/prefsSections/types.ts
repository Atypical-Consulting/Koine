// Shared types for the per-category section modules extracted from prefs.ts (#987 task 3 onward: this
// pair of interfaces is set by the FIRST section module — Appearance/About. `PrefsSection` is reused
// unchanged by every later section; `SectionCtx` is taken by most of them (Appearance, Editor, Assistant,
// MCP, Advanced) but not all — Keyboard and Output don't need it (Keyboard's commits route through
// saveKeybindingOverride/clearKeybindingOverrides and its own `onKeybindingsChanged` dep, not
// commit/onChange; Output routes its one field through the shared ScopeKit instead — see their own
// builders' deps shapes). A section module builds one category's panel + control wiring in isolation and
// must not import prefs.ts (no import cycles): mountPreferencesPane imports these modules, never the
// other way around.
import type { Settings } from "@/settings/persistence";

/**
 * What a section builder needs from its host (mountPreferencesPane) to report a change.
 *
 * - `commit` is the single-field-patch path — the exact shape of prefs.ts's own `commit()`
 *   (`cb.onChange(patchSettings(patch))`). Almost every control in every section uses only this.
 * - `onChange` is the raw report path for a control that persists through ITS OWN path instead of
 *   `patchSettings` and must still hand the host the merged Settings the same way `commit` would —
 *   Appearance's Theme (persists + applies live via `@/settings/theme`'s `setTheme`, which has its own
 *   live-apply + listener-notify story) and, in Assistant, the AI-provider switch and the API-key save
 *   (both read back a value `patchSettings`/`saveApiKey` themselves computed, rather than a caller-known
 *   patch). Kept as a narrow second field rather than folding these into `commit` so `SectionCtx` stays
 *   a plain, composable pair — a section that never needs the bypass just never calls `onChange`.
 */
export interface SectionCtx {
    /** Commit a single-field patch — same shape as prefs.ts's own `commit(patch)`. */
    commit(patch: Partial<Settings>): void;
    /** Report the merged Settings back to the host directly, bypassing patchSettings. */
    onChange(s: Settings): void;
}

/**
 * One category's built panel + repaint hook.
 *
 * `panel` is the role=tabpanel section (id `koi-settings-panel-<id>`, from prefsControls' `panel()`),
 * appended into the category rail's panel list by the assembler (mountPreferencesPane's `categories`
 * array). `populate(s)` repaints every control in this section from a fresh Settings — the assembler
 * calls it at the exact point in its own `populate()` sequence the inline code used to run at, so
 * cross-section repaint ORDER is preserved (e.g. a later section's populate may assume an earlier one
 * already ran — see Output's `outputLang.refresh()` before `scopeKit.syncAll()` today).
 *
 * Kept deliberately minimal: later sections extend it with their own extra hooks rather than this
 * interface growing section-specific members. About (below) is the first example — it has no
 * Settings-driven fields, so `populate` is a no-op, but it still needs its own on-show repaint
 * (the version chip), so it returns `PrefsSection & { refresh(): void }` instead of widening this type.
 */
export interface PrefsSection {
    panel: HTMLElement;
    populate(s: Settings): void;
}
