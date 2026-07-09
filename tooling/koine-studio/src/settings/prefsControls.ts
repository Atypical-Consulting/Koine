// Pure, callback-driven control factories for the Settings form (extracted from prefs.ts, #987 task 1).
// Every function here just builds DOM and wires event listeners to the callbacks it's given — none of
// them close over prefs.ts's `cb`/`commit`/Settings state, so they're safe to share as plain module-scope
// exports. `segmented` and `stringListInput` were already module-scope in prefs.ts; `row`, `panel`,
// `toggle`, `select`, `metricInput`, `accentPicker`, and `langPicker` were hoisted out of the closure
// inside `mountPreferencesPane` — they already took their callbacks as parameters, so the hoist is
// mechanical. prefs.ts re-exports `segmented` and `stringListInput` so existing importers keep compiling.
import type { AccentName, PreviewTarget } from "@/settings/persistence";
import { ACCENTS, ACCENT_ORDER } from "@/settings/appearance";
import { EMIT_TARGETS } from "@/shared/emitTargets";
import { wrapIndex } from "@/shared/wrapIndex";

/**
 * A segmented radio group (e.g. Dark / Light): a row of role=radio buttons under a role=radiogroup, with
 * exactly one option checked at a time. Keyboard-navigable per the WAI-ARIA radiogroup pattern — a roving
 * tabindex (only the checked option is in the tab order) plus Arrow/Home/End navigation where focus
 * follows selection (single-select semantics, matching a click). Arrow nav skips disabled options, so a
 * scope toggle whose every option is disabled (no workspace open) stays inert. `set(value)` drives both
 * `aria-checked` and the roving tabindex; the group is seeded with one tabbable option at construction so
 * it is reachable by Tab even before the first `set()`.
 *
 * Module-level + exported (it was a closure inside {@link import('@/settings/prefs').mountPreferencesPane})
 * so it can be the single shared control behind every Studio segmented: the Theme toggle and the four
 * User/Workspace scope toggles, and the Settings page's Visual/JSON representation toggle
 * (settingsPage.tsx).
 */
export function segmented<T extends string>(
    ariaLabel: string,
    options: readonly { value: T; label: string }[],
    onSelect: (value: T) => void,
): {
    el: HTMLElement;
    set(value: T): void;
    setDisabled(disabled: boolean): void;
} {
    const group = document.createElement("div");
    group.className = "koi-segmented";
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", ariaLabel);

    const buttons = options.map(({ value, label }) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "koi-seg";
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", "false");
        b.tabIndex = -1;
        b.dataset.value = value;
        b.textContent = label;
        b.addEventListener("click", () => selectButton(b));
        b.addEventListener("keydown", onArrow);
        group.appendChild(b);
        return b;
    });

    // set() drives aria-checked AND the roving tabindex: only the checked option is tabbable (0), every
    // other is taken out of the tab order (-1) so Tab enters the group once and the arrows move within it.
    const set = (value: T): void => {
        for (const b of buttons) {
            const checked = b.dataset.value === value;
            b.setAttribute("aria-checked", String(checked));
            b.tabIndex = checked ? 0 : -1;
        }
    };

    // setDisabled enables/disables the WHOLE group at once: aria-disabled on the group wrapper signals
    // that every option is inert, is-disabled styles it visually, and per-button disabled blocks clicks so
    // aria-disabled isn't the only guard. All three mirror the browser's built-in disabled affordances for
    // a group — arrow nav already skips .disabled buttons, so a fully-disabled group stays keyboard-inert.
    // This replaces the previously open-coded 3-line block in makeScopeBinding.applyEnabled and in the
    // JSON scope toggle (settingsPage.tsx), centralizing the single shared concern here.
    const setDisabled = (disabled: boolean): void => {
        group.setAttribute("aria-disabled", String(disabled));
        group.classList.toggle("is-disabled", disabled);
        for (const b of buttons) b.disabled = disabled;
    };

    // Move selection (and focus) to `target` and commit it — the shared path for both a click and an arrow
    // key, so focus-follows-selection holds for the keyboard exactly as it already did for the pointer.
    function selectButton(target: HTMLButtonElement): void {
        const value = target.dataset.value as T;
        set(value);
        onSelect(value);
        target.focus();
    }

    // Arrow / Home / End navigation across the ENABLED options (a no-workspace scope toggle has none, so
    // this is a no-op there). Right/Down → next, Left/Up → previous (both wrap), Home → first, End → last.
    function onArrow(e: KeyboardEvent): void {
        const enabled = buttons.filter((b) => !b.disabled);
        const i = enabled.indexOf(e.target as HTMLButtonElement);
        if (i < 0) return; // the focused option isn't navigable (e.g. all disabled) — leave the group be
        let next: HTMLButtonElement;
        if (e.key === "ArrowRight" || e.key === "ArrowDown")
            next = enabled[wrapIndex(i, +1, enabled.length)]; // shared wrap helper
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
            next = enabled[wrapIndex(i, -1, enabled.length)]; // shared wrap helper
        else if (e.key === "Home") next = enabled[0];
        else if (e.key === "End") next = enabled[enabled.length - 1];
        else return;
        e.preventDefault();
        selectButton(next);
    }

    // Seed one tabbable option so the group is keyboard-reachable before the first set() (callers set the
    // real selection during populate); the first option carries the roving tabindex until then.
    if (buttons.length > 0) buttons[0].tabIndex = 0;

    return { el: group, set, setDisabled };
}

/**
 * Build a reusable string-list (chip/token) editor control.
 *
 * Renders the current values as removable chips plus an add-field.  Trimmed blank tokens are
 * silently rejected (mirrors `coerceShellArgs`).  Each add/remove fires `onCommit` with the
 * full updated array.  Call `set(values)` to repaint from an external value (e.g. `populate()`).
 *
 * @param ariaLabel  Accessible label for the chip list and the add-input.
 * @param onCommit   Called with the full updated array after every add or remove.
 */
export function stringListInput(
    ariaLabel: string,
    onCommit: (values: string[]) => void,
): { el: HTMLElement; set(values: string[]): void } {
    let current: string[] = [];

    const chipList = document.createElement("ul");
    chipList.className = "koi-string-list-chips";
    chipList.setAttribute("role", "list");
    chipList.setAttribute("aria-label", ariaLabel);

    function renderChips(): void {
        chipList.innerHTML = "";
        for (let i = 0; i < current.length; i++) {
            const token = current[i];
            const li = document.createElement("li");
            li.className = "koi-chip";
            li.setAttribute("role", "listitem");

            const span = document.createElement("span");
            span.textContent = token;

            const removeBtn = document.createElement("button");
            removeBtn.type = "button";
            removeBtn.setAttribute("aria-label", `Remove ${token}`);
            removeBtn.textContent = "×";
            removeBtn.addEventListener("click", () => {
                current = current.filter((_, j) => j !== i);
                renderChips();
                onCommit([...current]);
            });

            li.append(span, removeBtn);
            chipList.append(li);
        }
    }

    const addInput = document.createElement("input");
    addInput.type = "text";
    addInput.className = "koi-string-list-input";
    addInput.setAttribute("aria-label", ariaLabel);
    addInput.placeholder = "Add argument…";

    function addToken(): void {
        const val = addInput.value.trim();
        if (!val) return;
        current = [...current, val];
        addInput.value = "";
        renderChips();
        onCommit([...current]);
    }

    addInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            addToken();
        }
    });

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.textContent = "Add";
    addBtn.className = "koi-string-list-add";
    addBtn.addEventListener("click", addToken);

    const addRow = document.createElement("div");
    addRow.className = "koi-string-list-addrow";
    addRow.append(addInput, addBtn);

    const el = document.createElement("div");
    el.className = "koi-string-list";
    el.append(chipList, addRow);

    function set(values: string[]): void {
        current = [...values];
        renderChips();
    }

    return { el, set };
}

// A labelled settings row: a title (+ optional description) on the left, the control on the right.
// `content` is what fills the control cell (usually `control` itself, but a scoped row passes a
// wrapper holding the value control + its User/Workspace toggle); `control` is the labelable target
// the <label for> binds to (defaults to `content`).
export function row(
    title: string,
    description: string,
    content: HTMLElement,
    control: HTMLElement = content,
): HTMLElement {
    const r = document.createElement("div");
    r.className = "koi-set-row";
    const text = document.createElement("div");
    text.className = "koi-set-text";
    // Associate the label with a labelable form control (input/select/textarea): give it a stable id
    // derived from the title and emit a real <label for>, so the field has an accessible name + id
    // (fixes the "form field should have an id/name" + "no label associated" DevTools notices). Non-form
    // controls (the role=switch toggle, segmented groups, accent swatches) carry their own aria-label,
    // so they keep a plain <span>.
    const labelable =
        control instanceof HTMLInputElement ||
        control instanceof HTMLSelectElement ||
        control instanceof HTMLTextAreaElement;
    const label = document.createElement(labelable ? "label" : "span");
    label.className = "koi-set-label";
    label.textContent = title;
    if (labelable) {
        if (!control.id)
            control.id = `koi-set-${title
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/(^-|-$)/g, "")}`;
        if (!control.getAttribute("name"))
            control.setAttribute("name", control.id);
        (label as HTMLLabelElement).htmlFor = control.id;
    }
    text.appendChild(label);
    if (description) {
        const desc = document.createElement("span");
        desc.className = "koi-set-desc";
        desc.textContent = description;
        text.appendChild(desc);
    }
    const ctrl = document.createElement("div");
    ctrl.className = "koi-set-control";
    ctrl.appendChild(content);
    r.append(text, ctrl);
    return r;
}

// A panel groups rows under a category.
export function panel(id: string, ...rows: HTMLElement[]): HTMLElement {
    const p = document.createElement("section");
    p.className = "koi-settings-panel";
    p.id = `koi-settings-panel-${id}`;
    p.setAttribute("role", "tabpanel");
    p.append(...rows);
    return p;
}

// An iOS-style on/off switch backed by role=switch (toggles on click; label via aria-label).
export function toggle(
    ariaLabel: string,
    onChange: (on: boolean) => void,
): {
    el: HTMLButtonElement;
    set(on: boolean): void;
    setDisabled(disabled: boolean): void;
} {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "koi-switch";
    btn.setAttribute("role", "switch");
    btn.setAttribute("aria-label", ariaLabel);
    btn.setAttribute("aria-checked", "false");
    const thumb = document.createElement("span");
    thumb.className = "koi-switch-thumb";
    btn.appendChild(thumb);
    const set = (on: boolean) => btn.setAttribute("aria-checked", String(on));
    // Grey out + block interaction (e.g. a mutually-exclusive sibling is on). The native `disabled`
    // attribute is what actually blocks the click (a disabled <button> dispatches no click event, so
    // onChange can't fire); aria-disabled is set alongside it as an explicit, redundant signal.
    const setDisabled = (disabled: boolean) => {
        btn.disabled = disabled;
        btn.setAttribute("aria-disabled", String(disabled));
    };
    btn.addEventListener("click", () => {
        const next = btn.getAttribute("aria-checked") !== "true";
        set(next);
        onChange(next);
    });
    return { el: btn, set, setDisabled };
}

export function select<T extends string>(
    options: readonly { value: T; label: string }[],
): HTMLSelectElement {
    const sel = document.createElement("select");
    sel.className = "koi-select";
    for (const { value, label } of options) {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = label;
        sel.appendChild(opt);
    }
    return sel;
}

// The accent swatch picker: one coloured dot per preset, single-selection radio group.
export function accentPicker(onSelect: (value: AccentName) => void): {
    el: HTMLElement;
    set(value: AccentName): void;
} {
    const group = document.createElement("div");
    group.className = "koi-accent-row";
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", "Accent colour");
    const buttons = ACCENT_ORDER.map((name) => {
        const preset = ACCENTS[name];
        const b = document.createElement("button");
        b.type = "button";
        b.className = "koi-accent-swatch";
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", "false");
        b.setAttribute("aria-label", preset.label);
        b.title = preset.label;
        b.dataset.value = name;
        b.style.setProperty("--koi-swatch", preset.swatch);
        const dot = document.createElement("span");
        dot.className = "koi-accent-dot";
        b.appendChild(dot);
        b.addEventListener("click", () => {
            set(name);
            onSelect(name);
        });
        group.appendChild(b);
        return b;
    });
    const set = (value: AccentName) => {
        for (const b of buttons)
            b.setAttribute("aria-checked", String(b.dataset.value === value));
    };
    return { el: group, set };
}

// The output-language picker: a card per target (identity dot + name + the file extension it
// emits), laid out as a single-selection radio group.
export function langPicker(onSelect: (value: PreviewTarget) => void): {
    el: HTMLElement;
    set(value: PreviewTarget): void;
    refresh(): void;
} {
    const group = document.createElement("div");
    group.className = "koi-lang-picker";
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", "Output language");
    // A card per target (identity dot + display name + emitted extension). The picker DOM is built
    // once at construction (during init(), before the backend seed resolves), so `refresh()` REBUILDS
    // the cards from the LIVE EMIT_TARGETS — called from the settings-panel open path (issue #282) so
    // a backend-seeded target appears here without a front-end edit, even though construction predates
    // the seed. `set` only toggles the selection, so it must read the current buttons each call.
    function refresh(): void {
        group.replaceChildren();
        for (const t of EMIT_TARGETS) {
            const id = t.id;
            const b = document.createElement("button");
            b.type = "button";
            b.className = "koi-lang-opt";
            b.setAttribute("role", "radio");
            b.setAttribute("aria-checked", "false");
            b.dataset.value = id;
            const dot = document.createElement("span");
            dot.className = "lang-dot";
            dot.dataset.lang = id;
            dot.setAttribute("aria-hidden", "true");
            const label = document.createElement("span");
            label.className = "koi-lang-name";
            label.textContent = t.displayName;
            const ext = document.createElement("span");
            ext.className = "koi-lang-ext";
            ext.textContent = t.fileExtension;
            b.append(dot, label, ext);
            b.addEventListener("click", () => {
                set(id);
                onSelect(id);
            });
            group.appendChild(b);
        }
    }
    const set = (value: PreviewTarget) => {
        for (const b of group.children)
            b.setAttribute(
                "aria-checked",
                String((b as HTMLElement).dataset.value === value),
            );
    };
    refresh();
    return { el: group, set, refresh };
}

// A clamped numeric setting input. On commit it parses, restores the prior value for empty/blank
// or non-numeric input (Number('') is 0, so the blank case must be caught explicitly), clamps into
// [min, max], then writes the single field. The committed change re-applies appearance via onChange.
export function metricInput(
    min: number,
    max: number,
    step: number,
    read: () => number,
    write: (value: number) => void,
): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "number";
    input.className = "koi-number";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.addEventListener("change", () => {
        const text = input.value.trim();
        const raw = Number(text);
        if (text === "" || !Number.isFinite(raw)) {
            input.value = String(read()); // restore the last good value
            return;
        }
        const clamped = Math.min(Math.max(raw, min), max);
        input.value = String(clamped);
        write(clamped);
    });
    return input;
}
