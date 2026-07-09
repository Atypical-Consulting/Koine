// Shared test doubles for the per-category section modules' unit tests (#987 task 3 onward). Every
// `*.section.test.ts` file drives its `build<X>Section` in isolation — no `mountPreferencesPane` — so
// each needs the same two doubles `mountPreferencesPane` itself would build: a `SectionCtx` whose
// `commit`/`onChange` are spy-wrapped but still write through the REAL `@/settings/persistence` module
// (backed by happy-dom's localStorage), and — for the four sections that take the shared ScopeKit as a
// dependency (Editor, Output, Advanced; see also scopeKit.test.ts's own direct coverage) — a real
// `createScopeKit` instance built the same way `mountPreferencesPane` builds its one instance. Extracted
// here (instead of six copies) so the doubles' semantics can't drift file-to-file (#987 code review).
import { vi } from "vitest";
import { saveSettings, loadSettings, type Settings } from "@/settings/persistence";
import { createScopeKit, type ScopeKit } from "@/settings/prefsSections/scopeKit";
import type { SectionCtx } from "@/settings/prefsSections/types";

/** A `SectionCtx` whose `commit`/`onChange` are `vi.fn()` spies that still behave like the real thing:
 *  `commit` merges the patch into persisted Settings (mirroring prefs.ts's own `commit()`), `onChange` is
 *  a bare spy (most sections don't inspect what it was called with beyond "was it called"). */
export function buildCtx(): SectionCtx & {
    commit: ReturnType<typeof vi.fn>;
    onChange: ReturnType<typeof vi.fn>;
} {
    const commit = vi.fn((patch: Partial<Settings>) => {
        saveSettings({ ...loadSettings(), ...patch });
    });
    const onChange = vi.fn();
    return { commit, onChange };
}

/** The shared ScopeKit instance a section builder takes as a dependency (#987 task 2), built the same way
 *  `mountPreferencesPane` builds its one instance: no workspace open by default (matching most tests),
 *  `commit` merges into persisted Settings by default. Pass `commit`/`onChange`/`workspaceKey` to spy on
 *  or override any of the three. */
export function buildScopeKit(
    overrides: Partial<{
        workspaceKey: () => string | null;
        commit: (patch: Partial<Settings>) => void;
        onChange: (s: Settings) => void;
    }> = {},
): ScopeKit {
    return createScopeKit({
        workspaceKey: overrides.workspaceKey ?? (() => null),
        commit:
            overrides.commit ??
            ((patch: Partial<Settings>) =>
                saveSettings({ ...loadSettings(), ...patch })),
        onChange: overrides.onChange ?? (() => {}),
    });
}
