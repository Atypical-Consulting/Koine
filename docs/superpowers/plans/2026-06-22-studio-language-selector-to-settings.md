# Move Studio language selector to Settings → Output — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the destination-language picker out of the Koine Studio toolbar and into a new, persisted **Settings → Output** section.

**Architecture:** Add a persisted `previewTarget` field to the Settings store; render it as a segmented dot-picker in a new "Output" settings category; remove the toolbar split button and its popover/shortcuts; drive the live emitted-code preview from the setting via the existing `onChange` re-skin path. The Code mode's preview sub-tab is relabelled `Generated · <language>` so the active target stays visible.

**Tech Stack:** TypeScript, Vite, Vitest (happy-dom), SCSS. No backend changes. Project root for all paths below: `tooling/koine-studio/`.

## Global Constraints

- All work is in `tooling/koine-studio/`. Run commands from that directory.
- TypeScript is strict; `npx tsc --noEmit` must stay clean.
- Tests run under happy-dom via `npx vitest run`; the suite is currently green (34 files / 463 tests).
- The persisted `Settings` store validates every field on load; a new field MUST be added to the `Settings` interface, `DEFAULT_SETTINGS`, and the field-by-field merge in `loadSettings()` together.
- Destination-language brand hues live as theme-independent `--lang-*` tokens in `src/styles/themes/_dark.scss`'s `:root`, mapped for the dot via `$languages` in `src/styles/abstracts/_variables.scss`.
- The four supported targets, in display order: `csharp`, `typescript`, `python`, `php` (labels `C#`, `TypeScript`, `Python`, `PHP`).
- Commit identity: `git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "…"`.

---

### Task 1: Persist `previewTarget` in the Settings store

**Files:**
- Modify: `src/store.ts` (type + `Settings` interface ~24-55, `DEFAULT_SETTINGS` ~57-74, coercers ~172-175, `loadSettings()` return ~188-208)
- Test: `src/store.test.ts`

**Interfaces:**
- Produces: `export type PreviewTarget = 'csharp' | 'typescript' | 'python' | 'php'`; `export const PREVIEW_TARGETS: readonly PreviewTarget[]`; `Settings.previewTarget: PreviewTarget`; `DEFAULT_SETTINGS.previewTarget === 'csharp'`.

- [ ] **Step 1: Write the failing tests**

Add this block to the end of `src/store.test.ts`, and add `PREVIEW_TARGETS` to the existing `from './store'` import list at the top of that file:

```typescript
describe('Output / previewTarget setting', () => {
  beforeEach(() => localStorage.clear());

  test('defaults to C#', () => {
    expect(DEFAULT_SETTINGS.previewTarget).toBe('csharp');
    expect(loadSettings().previewTarget).toBe('csharp');
  });

  test('round-trips a chosen target', () => {
    saveSettings({ ...DEFAULT_SETTINGS, previewTarget: 'php' });
    expect(loadSettings().previewTarget).toBe('php');
  });

  test('coerces a bogus stored target back to the default', () => {
    saveSettings({ ...DEFAULT_SETTINGS, previewTarget: 'rust' as never });
    expect(loadSettings().previewTarget).toBe('csharp');
  });

  test('PREVIEW_TARGETS lists the four supported languages in order', () => {
    expect(PREVIEW_TARGETS).toEqual(['csharp', 'typescript', 'python', 'php']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/store.test.ts`
Expected: FAIL — `PREVIEW_TARGETS` is not exported / `previewTarget` is `undefined`.

- [ ] **Step 3: Add the type and constant**

In `src/store.ts`, immediately above `export interface Settings {`, add:

```typescript
/** A code-generation target the emitted-code ("Generated") preview can render. */
export type PreviewTarget = 'csharp' | 'typescript' | 'python' | 'php';

/** The supported preview targets, in display order. The single source of truth for the set. */
export const PREVIEW_TARGETS: readonly PreviewTarget[] = ['csharp', 'typescript', 'python', 'php'];
```

- [ ] **Step 4: Add the `Settings` field and default**

In the `Settings` interface, add this line directly after the `mcpClient: McpClientId;` line:

```typescript
  /** The language the emitted-code ("Generated") preview renders. */
  previewTarget: PreviewTarget;
```

In `DEFAULT_SETTINGS`, add this line directly after `mcpClient: 'lm-studio',`:

```typescript
  previewTarget: 'csharp',
```

- [ ] **Step 5: Add the coercer and wire it into `loadSettings()`**

Directly after the `coerceMcpClient` function, add:

```typescript
/** A supported preview target, else the default. */
function coercePreviewTarget(v: unknown): PreviewTarget {
  return PREVIEW_TARGETS.includes(v as PreviewTarget) ? (v as PreviewTarget) : DEFAULT_SETTINGS.previewTarget;
}
```

In the object returned by `loadSettings()`, add this line directly after `mcpClient: coerceMcpClient(parsed.mcpClient),`:

```typescript
      previewTarget: coercePreviewTarget(parsed.previewTarget),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/store.test.ts`
Expected: PASS (all four new tests green).

- [ ] **Step 7: Commit**

```bash
git add src/store.ts src/store.test.ts
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "feat(studio): persist previewTarget output language in settings store"
```

---

### Task 2: Add the Settings → Output section (segmented dot picker)

**Files:**
- Modify: `src/prefs.ts` (import ~8-18, `ICON` ~63-74, control factories ~176-248, panels ~250-649, `categories` ~653-659, `populate` ~720-738)
- Modify: `src/styles/components/_settings.scss` (add picker styles near the accent picker ~230)
- Modify: `src/styles/themes/_dark.scss` (add `--lang-php` after line 36)
- Modify: `src/styles/abstracts/_variables.scss` (add `php` to `$languages`)
- Test: `src/prefs.test.ts`

**Interfaces:**
- Consumes: `PreviewTarget`, `PREVIEW_TARGETS` from `./store` (Task 1).
- Produces: a Settings category `output` rendering `#koi-settings-panel-output` containing a `.koi-lang-picker[role=radiogroup]` of `.koi-lang-opt[role=radio][data-value]` buttons; selecting one commits `{ previewTarget }`.

- [ ] **Step 1: Write the failing tests**

Add `loadSettings` to the existing `from './store'` import at the top of `src/prefs.test.ts`, then append this block:

```typescript
describe('Settings → Output panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    saveSettings({ ...DEFAULT_SETTINGS });
  });

  const langOpts = () =>
    [...document.querySelectorAll<HTMLButtonElement>('#koi-settings-panel-output .koi-lang-opt')];

  it('renders the four language options with C# selected by default', () => {
    openPrefs();
    const opts = langOpts();
    expect(opts.map((b) => b.dataset.value)).toEqual(['csharp', 'typescript', 'python', 'php']);
    const checked = opts.find((b) => b.getAttribute('aria-checked') === 'true');
    expect(checked?.dataset.value).toBe('csharp');
  });

  it('selecting a language commits previewTarget and reports it via onChange', () => {
    const onChange = vi.fn();
    openPrefs({ onChange });
    langOpts().find((b) => b.dataset.value === 'python')!.click();
    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls.at(-1)![0];
    expect(last.previewTarget).toBe('python');
    expect(loadSettings().previewTarget).toBe('python');
  });

  it('reflects the persisted target when reopened', () => {
    saveSettings({ ...DEFAULT_SETTINGS, previewTarget: 'php' });
    openPrefs();
    const checked = langOpts().find((b) => b.getAttribute('aria-checked') === 'true');
    expect(checked?.dataset.value).toBe('php');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/prefs.test.ts`
Expected: FAIL — `#koi-settings-panel-output` does not exist (zero `.koi-lang-opt` nodes).

- [ ] **Step 3: Import the store types in `prefs.ts`**

In `src/prefs.ts`, add `type PreviewTarget` and `PREVIEW_TARGETS` to the `from './store'` import (alongside `loadSettings`, `patchSettings`, etc.):

```typescript
import {
  loadSettings,
  patchSettings,
  saveSettings,
  saveApiKey,
  clearApiKey,
  whenSecretsReady,
  DEFAULT_SETTINGS,
  PREVIEW_TARGETS,
  type Settings,
  type AccentName,
  type PreviewTarget,
} from './store';
```

- [ ] **Step 4: Add the Output category icon**

In the `ICON` object (the `as const` map), add an `output` entry (curly-braces glyph) after the `advanced` entry:

```typescript
  output:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.4 2.6c-1.2 0-1.7.6-1.7 1.8v1.6c0 .9-.3 1.3-1.1 1.4v1.2c.8.1 1.1.5 1.1 1.4v1.6c0 1.2.5 1.8 1.7 1.8M9.6 2.6c1.2 0 1.7.6 1.7 1.8v1.6c0 .9.3 1.3 1.1 1.4v1.2c-.8.1-1.1.5-1.1 1.4v1.6c0 1.2-.5 1.8-1.7 1.8"/></svg>',
```

- [ ] **Step 5: Add the `langPicker` control factory**

In `src/prefs.ts`, directly after the `accentPicker` factory (before `metricInput`), add:

```typescript
  // The output-language picker: one dot+label button per target, single-selection radio group.
  function langPicker(onSelect: (value: PreviewTarget) => void): { el: HTMLElement; set(value: PreviewTarget): void } {
    const LABELS: Record<PreviewTarget, string> = {
      csharp: 'C#',
      typescript: 'TypeScript',
      python: 'Python',
      php: 'PHP',
    };
    const group = document.createElement('div');
    group.className = 'koi-lang-picker';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Output language');
    const buttons = PREVIEW_TARGETS.map((id) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'koi-lang-opt';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      b.dataset.value = id;
      const dot = document.createElement('span');
      dot.className = 'lang-dot';
      dot.dataset.lang = id;
      dot.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.textContent = LABELS[id];
      b.append(dot, label);
      b.addEventListener('click', () => {
        set(id);
        onSelect(id);
      });
      group.appendChild(b);
      return b;
    });
    const set = (value: PreviewTarget) => {
      for (const b of buttons) b.setAttribute('aria-checked', String(b.dataset.value === value));
    };
    return { el: group, set };
  }
```

- [ ] **Step 6: Build the Output panel**

In `src/prefs.ts`, directly after the Editor panel block (after `const editorPanel = panel(…)`), add:

```typescript
  // --- Output ---------------------------------------------------------------

  const outputLang = langPicker((target) => commit({ previewTarget: target }));

  const outputPanel = panel(
    'output',
    row('Language', 'The language the Generated preview emits.', outputLang.el),
  );
```

- [ ] **Step 7: Register the category and populate it**

In the `categories` array, add the Output entry directly after the `editor` entry:

```typescript
    { id: 'output', label: 'Output', icon: ICON.output, panel: outputPanel },
```

In `populate(s)`, add this line after `formatOnSave.set(s.formatOnSave);`:

```typescript
    outputLang.set(s.previewTarget);
```

- [ ] **Step 8: Add the PHP brand hue and dot mapping**

In `src/styles/themes/_dark.scss`, directly after `--lang-python: #ffd43b;`, add:

```scss
  --lang-php: #777bb4;
```

In `src/styles/abstracts/_variables.scss`, add `php` to the `$languages` map so it becomes:

```scss
$languages: (
  csharp: var(--lang-csharp),
  typescript: var(--lang-typescript),
  python: var(--lang-python),
  php: var(--lang-php),
);
```

- [ ] **Step 9: Add the picker styles**

In `src/styles/components/_settings.scss`, directly before the `/* accent swatch picker */` comment, add:

```scss
/* output-language picker — segmented buttons, each with its language identity dot */
.koi-lang-picker {
  display: inline-flex;
  gap: var(--koi-space-0-5);
  padding: var(--koi-space-0-5);
  border: 1px solid var(--koi-line);
  border-radius: var(--koi-radius);
  background: var(--koi-surface);
}

.koi-lang-opt {
  display: inline-flex;
  align-items: center;
  gap: var(--koi-space-1-5);
  border: none;
  border-radius: var(--koi-radius-sm);
  background: transparent;
  color: var(--koi-muted);
  padding: var(--koi-space-1-25) var(--koi-space-2-5);
  font-family: inherit;
  font-size: var(--koi-text-base);
  cursor: pointer;
  transition: background var(--koi-dur-mid) ease, color var(--koi-dur-mid) ease;
}

.koi-lang-opt:hover {
  color: var(--koi-fg);
}

.koi-lang-opt[aria-checked='true'] {
  background: var(--koi-paper-2);
  color: var(--koi-fg);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.22);
}

.koi-lang-opt:focus-visible {
  outline: 2px solid var(--koi-accent);
  outline-offset: 1px;
}
```

(The `.lang-dot` rule the picker relies on still lives in `_lang-split-button.scss` at this point; Task 4 relocates it here.)

- [ ] **Step 10: Run the tests + typecheck to verify they pass**

Run: `npx vitest run src/prefs.test.ts && npx tsc --noEmit`
Expected: PASS — the three new Output tests pass and typecheck is clean.

- [ ] **Step 11: Commit**

```bash
git add src/prefs.ts src/prefs.test.ts src/styles/components/_settings.scss src/styles/themes/_dark.scss src/styles/abstracts/_variables.scss
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "feat(studio): add Settings → Output language picker"
```

---

### Task 3: Remove the toolbar control and drive the target from Settings

**Files:**
- Modify: `index.html` (remove `.lang-split`, ~37-45)
- Modify: `src/ide.ts` (store import ~23-34; split-button block ~1806-1962; `onChange` ~2335-2342; palette ~2686-2688; keydown ~2749-2760; help rows ~316-318)

**Interfaces:**
- Consumes: `PreviewTarget` from `./store`; `settings.previewTarget` (Task 1); the `#tech-tab-preview` element from `index.html`.
- Produces: a toolbar with no language control; `currentTarget` initialized from and synced to `settings.previewTarget`; the `#tech-tab-preview` label reads `Generated · <name>`.

> This is the integration shell (`ide.ts` is not unit-tested — the store/prefs tests in Tasks 1–2 cover the data + UI). Verification is typecheck + the full regression suite + a production build + a manual smoke.

- [ ] **Step 1: Remove the toolbar split button**

In `index.html`, delete the entire `<div class="lang-split">…</div>` block (the Preview/Run button + caret). The enclosing `<div class="tb-group">` keeps the `#btn-generate-project` button. Delete exactly:

```html
            <div class="lang-split" role="group" aria-label="Destination language">
              <button type="button" id="btn-preview-run" class="tb-primary lang-run" title="Preview C# (⌘1)">
                <span class="lang-dot" data-lang="csharp" aria-hidden="true"></span>
                <span class="lang-run-label" id="lang-current-label">C#</span>
              </button>
              <button type="button" id="btn-lang-menu" class="tb-primary lang-caret" aria-haspopup="menu" aria-expanded="false" aria-label="Choose destination language" title="Choose destination language">
                <svg class="tb-ico lang-caret-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6.5 8 10 12 6.5" /></svg>
              </button>
            </div>
```

- [ ] **Step 2: Import `PreviewTarget` from the store**

In `src/ide.ts`, add `type PreviewTarget,` to the `from './store'` import block (after `type Settings,`):

```typescript
  saveWorkspaceMode,
  type Settings,
  type PreviewTarget,
} from './store';
```

- [ ] **Step 3: Replace the split-button block (metadata, refs, `setTarget`)**

In `src/ide.ts`, replace this region (the comment + `type PreviewTarget` + `LANGS` + `currentTarget` + the four element refs + `setTarget`, currently ~lines 1806-1828):

```typescript
  // Destination-language split button: the main half previews the current target, the caret opens a
  // picker. Previewing also surfaces the preview tab and adopts that target as the new "current".
  type PreviewTarget = 'csharp' | 'typescript' | 'python' | 'php';
  const LANGS: { id: PreviewTarget; label: string; name: string; hint: string }[] = [
    { id: 'csharp', label: 'C#', name: 'C#', hint: '⌘1' },
    { id: 'typescript', label: 'TS', name: 'TypeScript', hint: '⌘2' },
    { id: 'python', label: 'Python', name: 'Python', hint: '⌘3' },
    { id: 'php', label: 'PHP', name: 'PHP', hint: '⌘4' },
  ];
  let currentTarget: PreviewTarget = 'csharp';

  const runBtn = el<HTMLButtonElement>('btn-preview-run');
  const caretBtn = el<HTMLButtonElement>('btn-lang-menu');
  const currentLabel = el<HTMLElement>('lang-current-label');
  const currentDot = runBtn.querySelector<HTMLElement>('.lang-dot')!;

  function setTarget(target: PreviewTarget): void {
    currentTarget = target;
    const meta = LANGS.find((l) => l.id === target)!;
    currentLabel.textContent = meta.label;
    currentDot.dataset.lang = target;
    runBtn.title = `Preview ${meta.name} (${meta.hint})`;
  }
```

with:

```typescript
  // Destination language for the emitted-code preview. The choice lives in Settings → Output
  // (persisted); this keeps a live copy and labels the "Generated" sub-tab with the active language.
  const LANGS: { id: PreviewTarget; name: string }[] = [
    { id: 'csharp', name: 'C#' },
    { id: 'typescript', name: 'TypeScript' },
    { id: 'python', name: 'Python' },
    { id: 'php', name: 'PHP' },
  ];
  let currentTarget: PreviewTarget = settings.previewTarget;

  const previewTabEl = el<HTMLButtonElement>('tech-tab-preview');

  function setTarget(target: PreviewTarget): void {
    currentTarget = target;
    const meta = LANGS.find((l) => l.id === target)!;
    previewTabEl.textContent = `Generated · ${meta.name}`;
  }
```

- [ ] **Step 4: Delete the language popover**

In `src/ide.ts`, delete the entire language-picker popover region — from the comment `// --- language picker popover (mirrors the explorer context menu) ------------` through the end of the `onLangKeydown` function (the `langMenuEl` declaration plus `openLangMenu`, `closeLangMenu`, `onLangDocPointer`, `onLangKeydown`, currently ~lines 1830-1909). None of these are referenced after Step 5.

- [ ] **Step 5: Delete the `preview()` action and the button/caret wiring**

In `src/ide.ts`, replace this region (the `preview()` function plus the run/caret listeners and the init call, currently ~lines 1949-1962):

```typescript
  // Explicit preview action (run button, language menu, ⌘1/2/3, palette): adopt the target, surface
  // the preview tab, and force a re-emit even when it was already shown (e.g. for another target).
  function preview(target: PreviewTarget): void {
    setTarget(target);
    docViewsLoaded.preview = false;
    selectTech('preview');
  }

  runBtn.addEventListener('click', () => void preview(currentTarget));
  caretBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openLangMenu();
  });
  setTarget(currentTarget);
```

with:

```typescript
  // Label the "Generated" sub-tab with the persisted target on boot.
  setTarget(currentTarget);
```

- [ ] **Step 6: Sync the live target when the setting changes**

In `src/ide.ts`, in the `createPreferences({ onChange: (s) => { … } })` handler, add a target-sync block after `output.setLineWrap(s.wordWrap);`:

```typescript
      // Destination language now lives in Settings → Output. Adopt a change to the live target and
      // re-emit the Generated preview if it's the visible sub-view (else it reloads next open).
      if (s.previewTarget !== currentTarget) {
        setTarget(s.previewTarget);
        docViewsLoaded.preview = false;
        if (activeCenter === 'technical' && activeTech === 'preview') void loadPreview();
      }
```

- [ ] **Step 7: Remove the ⌘1–⌘4 keyboard shortcuts**

In `src/ide.ts`, in the global keydown handler, delete these four branches (currently ~lines 2749-2760), so the chain goes straight from the `mod+N` branch to the `mod+,` branch:

```typescript
    } else if (mod && e.key === '1') {
      e.preventDefault();
      void preview('csharp');
    } else if (mod && e.key === '2') {
      e.preventDefault();
      void preview('typescript');
    } else if (mod && e.key === '3') {
      e.preventDefault();
      void preview('python');
    } else if (mod && e.key === '4') {
      e.preventDefault();
      void preview('php');
```

The surrounding branches must remain intact:

```typescript
    } else if (mod && !e.shiftKey && (e.key === 'n' || e.key === 'N')) {
      e.preventDefault();
      void requestNewModel();
    } else if (mod && e.key === ',') {
      e.preventDefault();
      prefs.open();
```

- [ ] **Step 8: Remove the per-language palette commands**

In `src/ide.ts`, in the `getCommands()` array, delete these three entries (currently ~lines 2686-2688). Keep `view-preview` ("Show Emitted Preview"):

```typescript
      { id: 'preview-cs', title: 'Preview C#', hint: 'mod+1', group: 'Preview', run: () => void preview('csharp') },
      { id: 'preview-ts', title: 'Preview TypeScript', hint: 'mod+2', group: 'Preview', run: () => void preview('typescript') },
      { id: 'preview-py', title: 'Preview Python', hint: 'mod+3', group: 'Preview', run: () => void preview('python') },
```

- [ ] **Step 9: Remove the ⌘1–⌘3 keyboard-help rows**

In `src/ide.ts`, in `helpRows()`, delete these three rows (currently ~lines 316-318):

```typescript
    { keys: 'mod+1', description: 'Preview C#' },
    { keys: 'mod+2', description: 'Preview TypeScript' },
    { keys: 'mod+3', description: 'Preview Python' },
```

- [ ] **Step 10: Typecheck + full regression suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: typecheck clean; all test files pass (the previously-green suite plus Tasks 1–2's new tests). If `tsc` reports an unused `el`/symbol or a dangling `preview`/`openLangMenu` reference, you missed a deletion in Steps 4–8 — fix it.

- [ ] **Step 11: Production build**

Run: `npm run build`
Expected: `tsc && vite build` complete with no errors (the prebuild regenerates `src/templates.generated.ts`).

- [ ] **Step 12: Manual smoke (run-studio-web)**

Launch Studio Web (use the `run-studio-web` skill, or `npm run dev` and open the served URL). Verify:
- The toolbar has **no** Preview/Run split button or language caret (New / Open / Generate / Check remain).
- **Settings → Output → Language** shows four dotted options; C# selected by default.
- Switch to **Code** mode → the **"Generated · C#"** sub-tab shows; it emits C#.
- Change the Output language to Python in Settings → the Generated tab relabels to **"Generated · Python"** and re-emits Python.
- Reload the page → the language choice persists.

- [ ] **Step 13: Commit**

```bash
git add index.html src/ide.ts
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "feat(studio): remove toolbar language selector; drive preview target from settings"
```

---

### Task 4: Delete the dead language-toolbar styles

**Files:**
- Delete: `src/styles/components/_lang-picker.scss`
- Delete: `src/styles/components/_lang-split-button.scss`
- Modify: `src/styles/main.scss` (remove the two `@use` lines, ~24-25)
- Modify: `src/styles/components/_settings.scss` (relocate `.lang-dot` + the `@each $languages` loop here)

**Interfaces:**
- Consumes: the `$languages` map (now including `php`, Task 2) for the dot color loop.
- Produces: `.lang-dot` styling lives in `_settings.scss`; no `.lang-split` / `.lang-menu` / `.lang-run` / `.lang-caret` rules remain.

- [ ] **Step 1: Relocate `.lang-dot` into the settings styles**

In `src/styles/components/_settings.scss`, directly after the `.koi-lang-opt:focus-visible { … }` rule added in Task 2, add:

```scss
/* destination-language identity dot — the lead mark on each Output picker option. */
.lang-dot {
  width: 8px;
  height: 8px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--dot, var(--koi-accent));
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dot, var(--koi-accent)) 22%, transparent);
}

@each $name, $hue in a.$languages {
  .lang-dot[data-lang='#{$name}'] { --dot: #{$hue}; }
}
```

- [ ] **Step 2: Delete the dead style files**

```bash
git rm src/styles/components/_lang-split-button.scss src/styles/components/_lang-picker.scss
```

- [ ] **Step 3: Drop their imports from `main.scss`**

In `src/styles/main.scss`, delete these two lines:

```scss
@use './components/lang-split-button';
@use './components/lang-picker';
```

- [ ] **Step 4: Verify no dead references remain**

Run: `grep -rn "lang-split\|lang-menu\|lang-run\|lang-caret\|lang-current-label\|btn-preview-run\|btn-lang-menu" src index.html`
Expected: no output (exit 1). If anything prints, remove the straggler.

- [ ] **Step 5: Production build + full suite**

Run: `npm run build && npx vitest run`
Expected: the SCSS compiles (no missing-import / undefined-`$languages` errors) and all tests stay green.

- [ ] **Step 6: Commit**

```bash
git add src/styles/main.scss src/styles/components/_settings.scss
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "chore(studio): remove dead language-toolbar styles; move .lang-dot to settings"
```

---

## Self-Review

**Spec coverage:**
- Remove toolbar control entirely → Task 3 (Steps 1, 3–5) + Task 4 (style cleanup). ✓
- Persist the language → Task 1. ✓
- New "Output" Settings section → Task 2 (Steps 6–7). ✓
- Segmented dot picker → Task 2 (Step 5 factory + Step 9 styles). ✓
- `Generated · <lang>` tab readout → Task 3 (Step 3 `setTarget`). ✓
- Drop ⌘1–⌘4 + palette language commands, keep "Show Emitted Preview" → Task 3 (Steps 7–9). ✓
- Generate left untouched → not modified in any task. ✓
- PHP dot hue gap (map + `--lang-*` only had 3 langs) → Task 2 (Step 8). ✓
- Tests (store + prefs) → Task 1 (Step 1), Task 2 (Step 1). ✓

**Placeholder scan:** No TBD/TODO; every code step shows the exact code; every command has an expected result. ✓

**Type consistency:** `PreviewTarget` / `PREVIEW_TARGETS` are defined in Task 1 and consumed by name in Tasks 2–3; `setTarget`, `currentTarget`, `previewTabEl`, `LANGS{ id, name }`, `.koi-lang-opt[data-value]`, `#koi-settings-panel-output`, `#tech-tab-preview` are used consistently across tasks. ✓
