// The About section (extracted from prefs.ts, #987 task 3): wraps the existing About panel CONTENT
// (@/settings/about's createAboutPanel — the colophon: wordmark, links, credit) in the panel() tabpanel
// chrome and exposes its refresh() for the assembler's on-open repaint (applyOpenState). NOTE the two
// different "about" modules at play: @/settings/about.ts (existing, unrelated to this task — the panel
// CONTENT) vs this file, @/settings/prefsSections/about.ts (new — the section BUILDER that wraps that
// content for the category rail). About carries no per-Settings fields, so populate() is a no-op.
//
// This module must not import prefs.ts (no import cycles).
import type { Settings } from "@/settings/persistence";
import { createAboutPanel } from "@/settings/about";
import { panel } from "@/settings/prefsControls";
import type { PrefsSection } from "@/settings/prefsSections/types";

export function buildAboutSection(): PrefsSection & { refresh(): void } {
    const about = createAboutPanel();
    const aboutPanel = panel("about", about.el);

    // About has no Settings-driven fields today; its only repaint is the version chip, exposed as
    // refresh() below (called by the assembler's applyOpenState, at the same point the inline
    // about.refresh() call used to run).
    function populate(_s: Settings): void {}

    return { panel: aboutPanel, populate, refresh: about.refresh };
}
