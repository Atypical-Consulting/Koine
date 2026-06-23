# About-into-Settings Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Koine Studio's standalone About modal into the Settings dialog as the last tab, drop the toolbar ⓘ button, and repoint the palette's "About" command to deep-link there.

**Architecture:** Repurpose the About module from a `createModal()`-based dialog factory into a `createAboutPanel()` content factory (`{ el, refresh() }`), moved from `src/welcome/` to `src/settings/`. The Settings dialog (`src/settings/prefs.ts`) wraps that element in a new `panel('about', …)`, appends an `{ id:'about', … }` entry to its `categories` array, refreshes the version chip on open, and gains an optional `open(categoryId?)` deep-link argument. The toolbar button and old modal are then removed and the palette command repointed.

**Tech Stack:** TypeScript, Vite, vitest + happy-dom (Studio frontend only — no .NET, no Verify/Roslyn snapshots). All paths below are relative to `tooling/koine-studio/`.

## Global Constraints

- **Commit identity:** every commit uses the GitHub identity, not the work email:
  `git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "…"`.
- **No About *content* changes:** same monogram, "Koine Studio" wordmark, version chip, tagline, the four links (GitHub/Home/Docs/Blog in that order), and creator credit. Reuse the existing `.koi-about-*` classes verbatim.
- **Each commit leaves the tree green:** `npm test` and `npx tsc --noEmit` both pass after every task. (This is why the new `settings/about.ts` is *added* in Task 1 and the old `welcome/about.ts` is *deleted* in Task 3 — the duplicate exists only between those two tasks so the live modal keeps compiling.)
- **Tab order:** About is the **last** category, after Advanced: Appearance · Editor · Output · Assistant · MCP · Advanced · About.
- Run all commands from `tooling/koine-studio/`.

---

## File Structure

- **Create** `src/settings/about.ts` — the About panel content factory (`createAboutPanel`). One responsibility: build the colophon element + a version-refresh hook.
- **Create** `src/settings/about.test.ts` — unit tests for `createAboutPanel`.
- **Modify** `src/settings/prefs.ts` — add the About tab, the `ICON.about` glyph, the `about.refresh()` on-open call, and the `open(categoryId?)` deep-link.
- **Modify** `src/settings/prefs.test.ts` — add `describe('Settings → About panel')`.
- **Modify** `src/styles/components/_about.scss` — add a `.koi-about` width-capping wrapper rule; retitle the file comment.
- **Modify** `src/shell/ide.tsx` — drop the dialog import/construction/button-listener; repoint the palette command.
- **Modify** `index.html` — remove the `#btn-about` toolbar button.
- **Modify** `src/shell/ide.test.ts` — remove the `#btn-about` node from the inlined `APP_HTML` seed.
- **Delete** `src/welcome/about.ts` — old modal factory, no longer referenced.

---

## Task 1: About panel content factory (`src/settings/about.ts`)

Create the new module beside Settings. The old `src/welcome/about.ts` is left untouched this task so the live modal keeps working (it's deleted in Task 3).

**Files:**
- Create: `src/settings/about.ts`
- Test: `src/settings/about.test.ts`

**Interfaces:**
- Consumes: `getPlatform` from `@/host` (returns the active `Platform`; `appVersion(): Promise<string>`, `openExternal(url): void`), `koineMark` from `@/shared/logo` (returns an SVG monogram string, minting a fresh gradient id per call).
- Produces: `createAboutPanel(): AboutPanel` where `interface AboutPanel { readonly el: HTMLElement; refresh(): void }`. `el` is a `<div class="koi-about">` holding the colophon; `refresh()` re-fetches the version and fills/hides the `.koi-about-chip`. Task 2 consumes both.

- [ ] **Step 1: Write the failing test** — `src/settings/about.test.ts`

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { createAboutPanel } from '@/settings/about';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('About panel', () => {
  it('renders the wordmark and the four project links in order', () => {
    const about = createAboutPanel();
    expect(about.el.classList.contains('koi-about')).toBe(true);
    expect(about.el.querySelector('.koi-about-wordmark')?.textContent).toContain('Koine');
    const labels = [...about.el.querySelectorAll('.koi-about-link-label')].map((n) => n.textContent);
    expect(labels).toEqual(['GitHub', 'Home', 'Docs', 'Blog']);
  });

  it('hides the build chip until refresh(), then fills it with the app version', async () => {
    const about = createAboutPanel();
    const chip = about.el.querySelector<HTMLElement>('.koi-about-chip')!;
    expect(chip.hidden).toBe(true); // hidden until a version resolves
    about.refresh();
    await flush();
    expect(chip.hidden).toBe(false);
    expect(chip.textContent).toMatch(/^v/); // e.g. "v0.0.0" in the test build
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/settings/about.test.ts`
Expected: FAIL — cannot resolve `@/settings/about` (module does not exist yet).

- [ ] **Step 3: Write the module** — `src/settings/about.ts`

This is the existing `src/welcome/about.ts` with the modal removed: content is appended to a `<div class="koi-about">` root, and the modal's `onOpen` version-fetch becomes `refresh()`.

```ts
// About panel for Koine Studio: the app's colophon, shown as the last tab of the Settings dialog.
// Builds the brand monogram, the wordmark + a mono build chip (version from the platform — the
// `app_version` Tauri command on desktop, a build-time constant in the browser), a tagline, a grid of
// links out to the project (GitHub, home, docs, blog), and a creator credit. `refresh()` (re)fetches
// the version each time Settings opens; a failed fetch simply hides the chip. Project links are routed
// through `platform.openExternal` so they open in the system browser on both the desktop and web hosts.
import { getPlatform } from '@/host';
import { koineMark } from '@/shared/logo';

/** A built About panel: the content element plus a hook to refresh the version chip. */
export interface AboutPanel {
  /** The panel content, to drop into a Settings tab panel. */
  readonly el: HTMLElement;
  /** Re-fetch the app version and (re)fill or hide the build chip. Safe to call on every open. */
  refresh(): void;
}

const TAGLINE = 'Write a bounded context once. Generate the code.';

/** Where the project lives. Order here is the on-screen order of the link grid. */
interface ProjectLink {
  label: string;
  hint: string;
  href: string;
  icon: string; // inline 16×16 SVG, drawn in the toolbar's line-icon idiom (filled for GitHub)
}

const LINKS: ProjectLink[] = [
  {
    label: 'GitHub',
    hint: 'Source & issues',
    href: 'https://github.com/Atypical-Consulting/Koine',
    icon: '<svg class="tb-ico" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" stroke="none" d="M8 .2a8 8 0 0 0-2.53 15.6c.4.07.55-.17.55-.38v-1.35c-2.22.48-2.69-1.07-2.69-1.07-.36-.92-.89-1.17-.89-1.17-.72-.5.06-.49.06-.49.8.06 1.22.83 1.22.83.71 1.22 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.77-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.03 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 8 .2z"/></svg>',
  },
  {
    label: 'Home',
    hint: 'Project landing page',
    href: 'https://atypical-consulting.github.io/Koine/',
    icon: '<svg class="tb-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.6 7.6 8 3l5.4 4.6M4 6.4V13h8V6.4"/></svg>',
  },
  {
    label: 'Docs',
    hint: 'Guides & reference',
    href: 'https://atypical-consulting.github.io/Koine/start/what-is-koine/',
    icon: '<svg class="tb-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.6h4.7L12 5.9v7.5H4z"/><path d="M8.4 2.7v3.2h3.2M6.1 8.7h3.8M6.1 10.9h3.8"/></svg>',
  },
  {
    label: 'Blog',
    hint: 'Notes & releases',
    href: 'https://atypical-consulting.github.io/Koine/blog/',
    icon: '<svg class="tb-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.4h10M3 8h10M3 11.6h6"/></svg>',
  },
];

const CREATOR_URL = 'https://github.com/phmatray';

/** Build the About panel content (once) and return it with a version-refresh hook. */
export function createAboutPanel(): AboutPanel {
  const platform = getPlatform();

  const root = document.createElement('div');
  root.className = 'koi-about';

  const logo = document.createElement('div');
  logo.className = 'koi-welcome-logo koi-about-logo'; // shared logo container
  logo.setAttribute('aria-hidden', 'true');
  // koineMark() mints a fresh gradient id, so this monogram never collides with the welcome overlay's
  // copy (a shared id would leave this tile unfilled once the overlay is dismissed to display:none).
  logo.innerHTML = koineMark();

  const wordmark = document.createElement('p');
  wordmark.className = 'koi-about-wordmark';
  wordmark.append('Koine ');
  const studio = document.createElement('span');
  studio.textContent = 'Studio';
  wordmark.append(studio);

  // Mono build chip — filled in by refresh(), hidden until then (and if a fetch fails).
  const chip = document.createElement('span');
  chip.className = 'koi-about-chip';
  chip.hidden = true;

  const tagline = document.createElement('p');
  tagline.className = 'koi-about-tagline';
  tagline.textContent = TAGLINE;

  // Open an external link through the platform (new tab in the browser, OS handoff on desktop)
  // rather than letting the <a> navigate the webview. href stays real for a11y / copy-link / middle-click.
  function openLink(e: MouseEvent, href: string): void {
    e.preventDefault();
    platform.openExternal(href);
  }

  const links = document.createElement('div');
  links.className = 'koi-about-links';
  for (const link of LINKS) {
    const a = document.createElement('a');
    a.className = 'koi-about-link';
    a.href = link.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';

    const icon = document.createElement('span');
    icon.className = 'koi-about-link-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = link.icon;

    const text = document.createElement('span');
    text.className = 'koi-about-link-text';
    const label = document.createElement('span');
    label.className = 'koi-about-link-label';
    label.textContent = link.label;
    const hint = document.createElement('span');
    hint.className = 'koi-about-link-hint';
    hint.textContent = link.hint;
    text.append(label, hint);

    a.append(icon, text);
    a.addEventListener('click', (e) => openLink(e, link.href));
    links.append(a);
  }

  // Creator credit — the one human fact this panel exists to carry.
  const credit = document.createElement('p');
  credit.className = 'koi-about-credit';
  credit.append('The Koine language and this studio are designed & built by ');
  const author = document.createElement('a');
  author.className = 'koi-about-author';
  author.href = CREATOR_URL;
  author.target = '_blank';
  author.rel = 'noopener noreferrer';
  author.textContent = 'Philippe Matray';
  author.addEventListener('click', (e) => openLink(e, CREATOR_URL));
  credit.append(author, '.');

  root.append(logo, wordmark, chip, tagline, links, credit);

  // Fetch the version lazily on each open so a slow/absent command never blocks construction.
  // A failed invoke just leaves the chip hidden rather than surfacing an error.
  function refresh(): void {
    void platform
      .appVersion()
      .then((v) => {
        chip.textContent = v ? `v${v}` : '';
        chip.hidden = !v;
      })
      .catch(() => {
        chip.hidden = true;
      });
  }

  return { el: root, refresh };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/settings/about.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (The old `welcome/about.ts` still compiles; the new module is additive.)

- [ ] **Step 6: Commit**

```bash
git add src/settings/about.ts src/settings/about.test.ts
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "feat(studio): About panel content factory for Settings"
```

---

## Task 2: Add the About tab to Settings (`src/settings/prefs.ts`)

Wire the panel in as the last category, refresh its chip on open, support deep-linking via `open(categoryId?)`, and cap the colophon width in the wider panel.

**Files:**
- Modify: `src/settings/prefs.ts`
- Modify: `src/styles/components/_about.scss`
- Test: `src/settings/prefs.test.ts`

**Interfaces:**
- Consumes: `createAboutPanel` / `AboutPanel` from `@/settings/about` (Task 1). The local `panel(id, ...children)` helper → `<section class="koi-settings-panel" id="koi-settings-panel-{id}" role="tabpanel">`. The local `categories` array, `selectCategory(index)`, `activeIndex`, and `modal.onOpen(...)`.
- Produces: `PrefsHandle.open(categoryId?: string): void` — when `categoryId` matches a category, opens directly on that tab; no-arg calls keep the last-active tab. `ide.tsx` (Task 3) consumes `prefs.open('about')`.

- [ ] **Step 1: Write the failing tests** — append to `src/settings/prefs.test.ts`

Add this block after the existing `describe('Settings → Output panel', …)` block. `flush`, `settle`, `URL`, `openPrefs`, `createPreferences`, `DEFAULT_SETTINGS`, `saveSettings` are already in scope at module level.

```ts
describe('Settings → About panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    saveSettings({ ...DEFAULT_SETTINGS });
  });

  it('renders About as the last category tab with the wordmark and four links', () => {
    openPrefs();
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('.koi-settings-tab')];
    expect(tabs[tabs.length - 1]?.id).toBe('koi-settings-tab-about');
    const panel = document.querySelector('#koi-settings-panel-about')!;
    expect(panel.querySelector('.koi-about-wordmark')?.textContent).toContain('Koine');
    const labels = [...panel.querySelectorAll('.koi-about-link-label')].map((n) => n.textContent);
    expect(labels).toEqual(['GitHub', 'Home', 'Docs', 'Blog']);
  });

  it('open("about") opens directly on the About tab', () => {
    const prefs = createPreferences({
      onChange: () => {},
      mcpEndpoint: async () => URL,
      mcpStop: async () => {},
      mcpHostable: true,
    });
    prefs.open('about');
    const tab = document.querySelector<HTMLButtonElement>('#koi-settings-tab-about')!;
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector<HTMLElement>('#koi-settings-panel-about')!.hidden).toBe(false);
  });

  it('fills the build chip on open', async () => {
    openPrefs();
    await settle();
    const chip = document.querySelector<HTMLElement>('#koi-settings-panel-about .koi-about-chip')!;
    expect(chip.hidden).toBe(false);
    expect(chip.textContent).toMatch(/^v/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/settings/prefs.test.ts -t "About panel"`
Expected: FAIL — no `#koi-settings-tab-about` / `#koi-settings-panel-about` yet, and `prefs.open('about')` rejects the argument (current signature is `open(): void`).

- [ ] **Step 3: Add the import** — top of `src/settings/prefs.ts`, beside the other `@/settings` imports (e.g. right after the `import { ACCENTS, ACCENT_ORDER } from '@/settings/appearance';` line)

```ts
import { createAboutPanel } from '@/settings/about';
```

- [ ] **Step 4: Add the `ICON.about` glyph** — inside the `ICON` object (after the `output:` entry), reusing the circle-ⓘ from the old toolbar button

```ts
  about:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.8"/><path d="M8 7.3v3.4"/><circle cx="8" cy="4.9" r="0.9" fill="currentColor" stroke="none"/></svg>',
```

- [ ] **Step 5: Build the About panel** — in the body of `createPreferences`, just before the `// --- assemble the two-pane layout ---` section (after `advancedPanel` is defined)

```ts
  // --- About ----------------------------------------------------------------

  const about = createAboutPanel();
  const aboutPanel = panel('about', about.el);
```

- [ ] **Step 6: Register the category** — append to the `categories` array as the last entry (after the `advanced` entry)

```ts
    { id: 'about', label: 'About', icon: ICON.about, panel: aboutPanel },
```

- [ ] **Step 7: Refresh the chip on open** — inside the existing `modal.onOpen(() => { … })`, add this line (e.g. right after `populate(s);`)

```ts
    about.refresh();
```

- [ ] **Step 8: Update the handle type** — change the `PrefsHandle` interface's `open` signature

Replace:
```ts
export interface PrefsHandle {
  open(): void;
  close(): void;
}
```
with:
```ts
export interface PrefsHandle {
  /** Open the dialog; pass a category id (e.g. 'about') to land on that tab. */
  open(categoryId?: string): void;
  close(): void;
}
```

- [ ] **Step 9: Add the deep-link wrapper** — replace the final return of `createPreferences`

Replace:
```ts
  return { open: modal.open, close: modal.close };
```
with:
```ts
  // Open on a specific category when asked (e.g. the palette's "About" → 'about'); onOpen's trailing
  // selectCategory(activeIndex) then lands on it. A no-arg open keeps the last-active tab.
  function open(categoryId?: string): void {
    if (categoryId) {
      const i = categories.findIndex((c) => c.id === categoryId);
      if (i >= 0) activeIndex = i;
    }
    modal.open();
  }

  return { open, close: modal.close };
```

- [ ] **Step 10: Cap the colophon width** — `src/styles/components/_about.scss`

Change the top comment from `/* --- about dialog (the app colophon) --- */` to `/* --- About settings panel (the app colophon) --- */`, then add at the top of the file (before `.koi-about-logo`):

```scss
/* The colophon used to live in a narrow modal; inside the wider Settings panel, cap its width and
   centre it so the 2-column link grid and centred text don't stretch the full panel. */
.koi-about {
  max-width: 30rem;
  margin-inline: auto;
  padding-block: var(--koi-space-4);
}
```

- [ ] **Step 11: Run the About tests to verify they pass**

Run: `npx vitest run src/settings/prefs.test.ts -t "About panel"`
Expected: PASS (all three cases).

- [ ] **Step 12: Run the full prefs suite + typecheck (no regressions)**

Run: `npx vitest run src/settings/prefs.test.ts && npx tsc --noEmit`
Expected: PASS — the MCP and Output describes still green; no type errors.

- [ ] **Step 13: Commit**

```bash
git add src/settings/prefs.ts src/settings/prefs.test.ts src/styles/components/_about.scss
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "feat(studio): add About tab to Settings with deep-link open"
```

---

## Task 3: Drop the toolbar button, repoint the palette, delete the old modal

Flip the entry points and remove the now-dead standalone dialog. `index.html`, `ide.tsx`, and `ide.test.ts` must change together: `init()` calls `el('btn-about')`, and the test's `APP_HTML` seed is kept byte-for-byte equivalent to `index.html`.

**Files:**
- Modify: `src/shell/ide.tsx`
- Modify: `index.html`
- Modify: `src/shell/ide.test.ts`
- Delete: `src/welcome/about.ts`

**Interfaces:**
- Consumes: `prefs.open('about')` (Task 2). After this task nothing imports `@/welcome/about`.
- Produces: no new interface — this task removes surface.

- [ ] **Step 1: Repoint the palette command** — `src/shell/ide.tsx`

Replace:
```ts
      { id: 'about', title: 'About Koine Studio', group: 'Help', run: () => about.open() },
```
with:
```ts
      { id: 'about', title: 'About Koine Studio', group: 'Help', run: () => prefs.open('about') },
```

- [ ] **Step 2: Remove the button listener** — `src/shell/ide.tsx`

Delete this line:
```ts
  el<HTMLButtonElement>('btn-about').addEventListener('click', () => about.open());
```

- [ ] **Step 3: Remove the dialog construction** — `src/shell/ide.tsx`

Delete this line:
```ts
  const about = createAboutDialog();
```

- [ ] **Step 4: Remove the import** — `src/shell/ide.tsx`

Delete this line:
```ts
import { createAboutDialog } from '@/welcome/about';
```

- [ ] **Step 5: Remove the toolbar button** — `index.html`

Delete the whole `#btn-about` button block from `.toolbar-right` (the gear `#btn-prefs` stays):
```html
          <button type="button" id="btn-about" class="icon-btn" title="About Koine Studio" aria-label="About">
            <svg class="tb-ico" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="5.8" />
              <path d="M8 7.3v3.4" />
              <circle cx="8" cy="4.9" r="0.9" fill="currentColor" stroke="none" />
            </svg>
          </button>
```

- [ ] **Step 6: Sync the test seed** — `src/shell/ide.test.ts`

Delete this line from the `APP_HTML` constant (keeps the seed byte-for-byte equivalent to `index.html`):
```ts
          <button type="button" id="btn-about" class="icon-btn">about</button>
```

- [ ] **Step 7: Delete the old modal module**

```bash
git rm src/welcome/about.ts
```

- [ ] **Step 8: Verify nothing still references the old module or button**

Run: `grep -rn "createAboutDialog\|welcome/about\|btn-about" src index.html`
Expected: no matches (empty output).

- [ ] **Step 9: Run the ide suite + typecheck**

Run: `npx vitest run src/shell/ide.test.ts && npx tsc --noEmit`
Expected: PASS — `init()` no longer looks up `btn-about`, and no dangling import.

- [ ] **Step 10: Run the full test suite**

Run: `npm test`
Expected: PASS — entire Studio vitest suite green.

- [ ] **Step 11: Commit**

```bash
git add -A
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "feat(studio): drop About toolbar button, route palette to Settings → About"
```

---

## Final verification

- [ ] From `tooling/koine-studio/`: `npm test` and `npx tsc --noEmit` both green.
- [ ] `grep -rn "createAboutDialog\|btn-about\|welcome/about" src index.html` → empty.
- [ ] Manual smoke (optional, via the run-studio-web skill): open Settings, confirm **About** is the last rail tab and shows the monogram, wordmark, version chip, four links, and credit; run the palette's **About Koine Studio** command and confirm it opens Settings on the About tab; confirm the toolbar no longer shows the ⓘ button next to the gear.

## Notes

- The `welcome/` folder keeps its other modules (`welcome.ts`, `templates.ts`, …); only `about.ts` leaves it.
- `__APP_VERSION__` resolves to a real version in the build and falls back to `'0.0.0'` under vitest, so the chip is non-empty (`/^v/`) in the panel/refresh tests.
- No keyboard shortcut is added for About; it inherits Settings' `mod+,` plus the palette command.
