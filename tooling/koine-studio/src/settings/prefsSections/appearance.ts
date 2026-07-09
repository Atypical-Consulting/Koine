// The Appearance section (extracted from prefs.ts, #987 task 3 — the first section module, setting the
// pattern later tasks copy): Theme, Accent, Reduce motion, Editor font, Display name, On startup.
//
// Theme is special-cased: it persists + applies live through @/settings/theme's setTheme (its own
// live-apply + listener-notify path), NOT through ctx.commit's patchSettings path — and reports the
// full reloaded Settings via ctx.onChange, exactly like prefs.ts's own inline themeSeg handler did.
// Every other field here just commits a single-field patch through ctx.commit; the live re-skin happens
// in the host's onChange via applyAppearance (the one place that defines how a Settings object maps to
// the DOM), so there is a single apply path for those.
//
// This module must not import prefs.ts (no import cycles).
import {
    loadSettings,
    type Settings,
    type StartupView,
} from "@/settings/persistence";
import { setTheme } from "@/settings/theme";
import {
    row,
    panel,
    toggle,
    select,
    accentPicker,
    segmented,
} from "@/settings/prefsControls";
import type { PrefsSection, SectionCtx } from "@/settings/prefsSections/types";

export function buildAppearanceSection(ctx: SectionCtx): PrefsSection {
    const themeSeg = segmented<Settings["theme"]>(
        "Theme",
        [
            { value: "dark", label: "Dark" },
            { value: "light", label: "Light" },
        ],
        (theme) => {
            setTheme(theme); // persists + applies live + notifies theme listeners
            ctx.onChange(loadSettings());
        },
    );

    // Appearance fields just commit; the live re-skin happens in onChange via applyAppearance (the one
    // place that defines how a Settings object maps to the DOM), so there is a single apply path.
    const accent = accentPicker((name) => ctx.commit({ accent: name }));
    const reduceMotion = toggle("Reduce motion", (on) =>
        ctx.commit({ reduceMotion: on }),
    );

    // The name attributed to review comments authored from Studio (#479). Committed trimmed; a blank
    // value is stored as-is and resolves to the 'You' fallback at comment-creation time
    // (resolveReviewAuthor).
    const displayNameInput = document.createElement("input");
    displayNameInput.type = "text";
    displayNameInput.className = "koi-text";
    displayNameInput.spellcheck = false;
    displayNameInput.autocomplete = "off";
    displayNameInput.placeholder = "You";
    displayNameInput.addEventListener("change", () => {
        ctx.commit({ displayName: displayNameInput.value.trim() });
    });

    // Editor font-stack override (#750). A blank value falls back to the theme's default mono font,
    // applied live via applyAppearance (onChange) like the other appearance fields. Committed trimmed.
    const fontFamilyInput = document.createElement("input");
    fontFamilyInput.type = "text";
    fontFamilyInput.className = "koi-text";
    fontFamilyInput.spellcheck = false;
    fontFamilyInput.autocomplete = "off";
    fontFamilyInput.placeholder = "Theme default (monospace)";
    fontFamilyInput.addEventListener("change", () => {
        ctx.commit({ fontFamily: fontFamilyInput.value.trim() });
    });

    // “On startup” (#770): which view to open on a cold boot (no explicit hash / share link). The
    // default ‘home’ preserves the #766 always-Home behaviour; ‘lastWorkspace’ opts in to auto-resume.
    // Applying on the next cold load only — no live re-route needed.
    const startupViewSelect = select<StartupView>([
        { value: "home", label: "Home screen" },
        { value: "lastWorkspace", label: "Last workspace" },
    ]);
    startupViewSelect.addEventListener("change", () => {
        const value = startupViewSelect.value as StartupView;
        ctx.commit({ startupView: value });
    });

    const appearancePanel = panel(
        "appearance",
        row(
            "Theme",
            "Light or dark surfaces across the whole studio.",
            themeSeg.el,
        ),
        row(
            "Accent",
            "The highlight colour for selections, focus, and actions.",
            accent.el,
        ),
        row(
            "Reduce motion",
            "Collapse animations and transitions.",
            reduceMotion.el,
        ),
        row(
            "Editor font",
            "A CSS font-family for the editor. Blank uses the theme’s default monospace font.",
            fontFamilyInput,
        ),
        row(
            "Display name",
            'The name your review comments are attributed to. Leave blank to show as "You".',
            displayNameInput,
        ),
        row(
            "On startup",
            'Which view to open when Studio starts. "Last workspace" re-opens the editor automatically if a prior workspace exists.',
            startupViewSelect,
        ),
    );

    function populate(s: Settings): void {
        themeSeg.set(s.theme);
        accent.set(s.accent);
        reduceMotion.set(s.reduceMotion);
        displayNameInput.value = s.displayName;
        fontFamilyInput.value = s.fontFamily;
        startupViewSelect.value = s.startupView;
    }

    return { panel: appearancePanel, populate };
}
