# Koine Studio `src/` Feature-Area Reorganization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the ~49 flat top-level modules + the 12 `panels/` components in `tooling/koine-studio/src/` into 13 feature folders, and introduce a `@/` → `src/` path alias, with zero behavior change.

**Architecture:** This is a pure structural refactor. The existing ~89-file test suite plus `tsc` typecheck and `vite build` are the regression net — there are no new behaviors to test, so each step's "test" is *the existing suite + build staying green*. Two one-shot Node codemods do the import rewrites mechanically: one converts every relative specifier to the `@/` alias (run once), the second remaps exact `@/<old>`→`@/<new>` specifiers per move batch. Sequencing the alias **first** means each later file move only touches the *references to* a file, never the moved file's own imports.

**Tech Stack:** TypeScript (bundler module resolution, Preact JSX), Vite 8, Vitest 4 (happy-dom), zustand. Node ESM `.mjs` codemods (the repo already keeps migration scripts under `scripts/`).

## Global Constraints

- **Working directory for all commands:** `tooling/koine-studio/` (the studio package root). All `src/`, `scripts/`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts` paths are relative to it.
- **Verification gate (every commit must pass both):** `npm test` (`vitest run`, ~89 files) **and** `npx tsc -p tsconfig.json` (typecheck; the config has `noEmit: true`, so this is a pure check). Run a full `npm run build` (`tsc && vite build`) after the alias phase (Task 1) and once at the very end (Task 17).
- **Commit identity (workspace rule):** every commit uses `git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "..."`.
- **Co-located tests move with their module.** Vitest globs `src/**/*.test.ts(x)`, so tests in subfolders are still discovered — no `vitest.config.ts` change for that.
- **Stays at `src/` root (never moved):** `main.ts` (the `index.html` entry), `vite-env.d.ts`, `test-setup.ts`, `preactSmoke.tsx`/`.test.tsx`, and the git-ignored generated `templates.generated.ts`.
- **Untouched subtrees:** `src/store/` (+ `slices/`), `src/host/` (+ `browser/`), `src/styles/`, `src/assets/`.
- **No behavior, public API, or generated-output change.** If a snapshot or test value would change, stop — something is wrong.

---

### Task 0: Establish a green baseline

**Files:** none (verification only).

- [ ] **Step 1: Confirm the suite and build are green before touching anything**

Run (from `tooling/koine-studio/`):
```bash
npm test
npx tsc -p tsconfig.json
```
Expected: `npm test` reports all files passed (≈89 test files); `tsc` prints nothing and exits 0.

If either fails on a clean checkout, STOP and report — the plan assumes a green starting point.

---

### Task 1: Introduce the `@/` → `src/` path alias

**Files:**
- Modify: `tsconfig.json` (add `baseUrl` + `paths`)
- Modify: `vite.config.ts` (add `@` to `resolve.alias`)
- Modify: `vitest.config.ts` (add `@` to `resolve.alias`)
- Create: `src/_alias.smoke.test.ts` (temporary alias smoke test, deleted in Task 17)

**Interfaces:**
- Produces: a working `@/*` alias resolvable by `tsc`, Vite, and Vitest. Every later task relies on `@/...` specifiers resolving to `src/...`.

- [ ] **Step 1: Write a failing smoke test that imports through the alias**

Create `src/_alias.smoke.test.ts` (imports a symbol from an UNMOVED module so it stays valid all the way through — `store/hooks.ts` exports `useAppStore`):
```ts
import { describe, it, expect } from 'vitest';
import { useAppStore } from '@/store/hooks';

describe('@/ path alias', () => {
  it('resolves @/ to src/ under vitest', () => {
    expect(typeof useAppStore).toBe('function');
  });
});
```

- [ ] **Step 2: Run it and watch it fail to resolve**

Run:
```bash
npx vitest run src/_alias.smoke.test.ts
```
Expected: FAIL — Vitest cannot resolve `@/store/hooks` (no alias yet).

- [ ] **Step 3: Add the alias to `tsconfig.json`**

In `tsconfig.json`, inside `compilerOptions`, add these two keys (place them right after `"target"`):
```jsonc
"baseUrl": ".",
"paths": { "@/*": ["src/*"] },
```

- [ ] **Step 4: Add the alias to `vite.config.ts`**

At the top of `vite.config.ts`, ensure `fileURLToPath` is imported:
```ts
import { fileURLToPath } from "node:url";
```
Then in the returned config's `resolve.alias` object (the one already holding the `react`/`react-dom` preact aliases), add as the FIRST entry:
```ts
"@": fileURLToPath(new URL("./src", import.meta.url)),
```

- [ ] **Step 5: Add the alias to `vitest.config.ts`**

`vitest.config.ts` does NOT inherit `vite.config.ts`'s resolve config (it re-declares the preact aliases on purpose). At the top, add:
```ts
import { fileURLToPath } from "node:url";
```
Then add to its `resolve.alias` object (alongside the `react` aliases) as the FIRST entry:
```ts
"@": fileURLToPath(new URL("./src", import.meta.url)),
```

- [ ] **Step 6: Run the smoke test — it passes**

Run:
```bash
npx vitest run src/_alias.smoke.test.ts
```
Expected: PASS.

- [ ] **Step 7: Full verification (alias must not break tsc or the bundler)**

Run:
```bash
npm test
npm run build
```
Expected: all tests pass; `npm run build` (`tsc && vite build`) completes with no module-resolution errors.

- [ ] **Step 8: Commit**

```bash
git add tsconfig.json vite.config.ts vitest.config.ts src/_alias.smoke.test.ts
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" \
  commit -m "build(studio): add @/ -> src/ path alias (tsconfig + vite + vitest)"
```

---

### Task 2: Sweep all relative imports to the `@/` alias (no file moves)

**Files:**
- Create: `scripts/relativize-imports.mjs` (one-shot codemod; deleted in Task 17)
- Modify: every `src/**/*.ts(x)` containing an internal relative import (~336 specifiers)

**Interfaces:**
- Produces: a `src/` tree where every internal import is the absolute form `@/<path>`. After this, a file move only requires rewriting *references to* the file (Task 3+), never the file's own imports.

- [ ] **Step 1: Write the codemod**

Create `scripts/relativize-imports.mjs`:
```js
#!/usr/bin/env node
// One-shot migration: rewrite every RELATIVE module specifier under src/ to the '@/<path>' alias.
// Anchored to real module positions (import/export-from, dynamic import(), side-effect import '...',
// and vitest vi.mock/doMock/importActual/importMock) so plain data strings like '../escape.koi' or
// '../evil.cs' are never touched. Run once from tooling/koine-studio/, then delete.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, dirname, posix, sep } from 'node:path';

const SRC = join(process.cwd(), 'src');

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.tsx?$/.test(e.name)) acc.push(p);
  }
  return acc;
}

// group 1 = prefix incl. opening quote; group 2 = relative specifier; group 3 = closing quote
const PATTERNS = [
  /(\bfrom\s*['"])(\.[^'"]*)(['"])/g,                                              // import/export ... from '...'
  /(\bimport\s*\(\s*['"])(\.[^'"]*)(['"])/g,                                       // import('...') (dynamic + type)
  /(\bimport\s*['"])(\.[^'"]*)(['"])/g,                                            // side-effect import '...'
  /(\bvi\.(?:mock|doMock|importActual|importMock)\s*\(\s*['"])(\.[^'"]*)(['"])/g,  // vitest mocks
];

let files = 0, edits = 0;
for (const file of walk(SRC)) {
  const rel = relative(SRC, dirname(file)).split(sep).join('/');
  const base = rel === '' || rel === '.' ? '' : rel;                              // '' for src/*, 'panels', 'host/browser'
  let text = readFileSync(file, 'utf8');
  let changed = false;
  for (const re of PATTERNS) {
    text = text.replace(re, (_m, pre, spec, post) => {
      const resolved = posix.normalize(posix.join(base, spec));                   // './editor'->'editor', '../store/index'->'store/index'
      changed = true; edits++;
      return `${pre}@/${resolved}${post}`;
    });
  }
  if (changed) { writeFileSync(file, text); files++; }
}
console.log(`rewrote ${edits} specifiers across ${files} files`);
```

- [ ] **Step 2: Run the codemod**

Run:
```bash
node scripts/relativize-imports.mjs
```
Expected: prints something like `rewrote ~336 specifiers across ~80 files`.

- [ ] **Step 3: Verify no anchored relative internal import remains**

Run:
```bash
grep -rnE "(\bfrom|\bimport\(|\bimport|vi\.(mock|doMock|importActual|importMock)\()\s*['\"]\.\.?/" src --include=*.ts --include=*.tsx
```
Expected: NO output. (The data strings `'../escape.koi'` / `'../evil.cs'` are not in these positions and must NOT appear here — if they do, the anchoring is wrong.)

Also confirm the data strings survived untouched:
```bash
grep -rn "'../escape.koi'\|'../evil.cs'" src --include=*.ts
```
Expected: still present (3 lines) — these are intentional test data, not imports.

- [ ] **Step 4: Full verification**

Run:
```bash
npm test
npm run build
```
Expected: all tests pass; build clean. (This proves the alias resolves the swept imports across `tsc`, Vitest, and Vite.)

- [ ] **Step 5: Commit**

```bash
git add -A
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" \
  commit -m "refactor(studio): sweep all internal imports to the @/ alias"
```

---

### Task 3: Add the reusable move codemod (exact-literal specifier remap)

**Files:**
- Create: `scripts/move-specifiers.mjs` (reused by every move batch; deleted in Task 17)

**Interfaces:**
- Produces: `node scripts/move-specifiers.mjs '<json-map>'` — rewrites each exact quoted specifier literal `"@/<old>"` → `"@/<new>"` across `src/`. Exact-literal + closing-quote anchoring means `@/store` is remapped while `@/store/index` and `@/store/hooks` are left untouched. Tasks 4–16 each call it with their batch map.

- [ ] **Step 1: Write the codemod**

Create `scripts/move-specifiers.mjs`:
```js
#!/usr/bin/env node
// Rewrite exact '@/<old>' module specifiers to '@/<new>' across src/. Matches only a COMPLETE quoted
// literal ('<old>' or "<old>"), so '@/store' is remapped but '@/store/index' / '@/store/hooks' are not.
// Usage: node scripts/move-specifiers.mjs '{"@/selection":"@/model/selection", ...}'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const map = JSON.parse(process.argv[2] ?? '{}');
const SRC = join(process.cwd(), 'src');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.tsx?$/.test(e.name)) acc.push(p);
  }
  return acc;
}

let edits = 0;
for (const file of walk(SRC)) {
  let text = readFileSync(file, 'utf8');
  let changed = false;
  for (const [oldSpec, newSpec] of Object.entries(map)) {
    const re = new RegExp(`(['"])${esc(oldSpec)}\\1`, 'g');   // '<old>' or "<old>" exactly
    text = text.replace(re, (_m, q) => { changed = true; edits++; return `${q}${newSpec}${q}`; });
  }
  if (changed) writeFileSync(file, text);
}
console.log(`rewrote ${edits} specifiers`);
```

- [ ] **Step 2: Sanity-check the exact-literal behavior on a throwaway fixture**

Run (proves `@/store` is remapped but `@/store/index` is NOT):
```bash
printf "import a from '@/store';\nimport b from '@/store/index';\n" > src/_codemod_probe.test.ts
node scripts/move-specifiers.mjs '{"@/store":"@/settings/persistence"}'
grep -n "@/" src/_codemod_probe.test.ts
```
Expected output:
```
1:import a from '@/settings/persistence';
2:import b from '@/store/index';
```

- [ ] **Step 3: Remove the probe file**

Run:
```bash
rm src/_codemod_probe.test.ts
```

- [ ] **Step 4: Commit the tool**

```bash
git add scripts/move-specifiers.mjs
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" \
  commit -m "build(studio): add reusable @/ specifier move codemod"
```

---

## Tasks 4–16: the 13 move batches

Each batch follows the **identical procedure**; only the file list and the specifier map change. Do leaf folders first and `shell/` last (it pulls in nearly everything). Run **every** batch as its own commit so each is independently green and bisectable.

**Batch procedure (apply to each task below):**

1. Create the folder: `mkdir -p src/<folder>`
2. Move each module with its co-located test using a glob so `.ts`/`.tsx`/`.test.ts`/`.test.tsx` all move and missing tests are simply absent: `git mv src/<name>.* src/<folder>/` (and `git mv src/panels/<Panel>.* src/<folder>/` for folded-in panels). The `<name>.*` glob will NOT grab a same-named directory (it requires a `.`), so `src/store.*` moves `store.ts`/`store.test.ts` but not the `store/` folder.
3. Run the codemod with the batch map: `node scripts/move-specifiers.mjs '<map>'`
4. Verify: `npm test` and `npx tsc -p tsconfig.json` — both green.
5. Commit: `git add -A && git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "refactor(studio): move <folder> modules into src/<folder>/"`

If `npm test` or `tsc` fails in a batch, the map is incomplete or a name collided — fix the map, re-run the codemod (it is idempotent for already-remapped specifiers since the old literal no longer exists), and re-verify before committing.

---

### Task 4: `shared/` — overlay, palette, help, logo, platform

- [ ] **Move + remap + verify + commit**
```bash
mkdir -p src/shared
git mv src/overlay.* src/palette.* src/help.* src/logo.* src/platform.* src/shared/
node scripts/move-specifiers.mjs '{"@/overlay":"@/shared/overlay","@/palette":"@/shared/palette","@/help":"@/shared/help","@/logo":"@/shared/logo","@/platform":"@/shared/platform"}'
npm test && npx tsc -p tsconfig.json
git add -A && git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "refactor(studio): move shared chrome (overlay/palette/help/logo/platform) into src/shared/"
```

### Task 5: `lsp/` — lsp

- [ ] **Move + remap + verify + commit**
```bash
mkdir -p src/lsp
git mv src/lsp.* src/lsp/
node scripts/move-specifiers.mjs '{"@/lsp":"@/lsp/lsp"}'
npm test && npx tsc -p tsconfig.json
git add -A && git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "refactor(studio): move lsp client into src/lsp/"
```

### Task 6: `mcp/` — mcp

- [ ] **Move + remap + verify + commit**
```bash
mkdir -p src/mcp
git mv src/mcp.* src/mcp/
node scripts/move-specifiers.mjs '{"@/mcp":"@/mcp/mcp"}'
npm test && npx tsc -p tsconfig.json
git add -A && git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "refactor(studio): move mcp config into src/mcp/"
```

### Task 7: `editor/` — editor, actions

- [ ] **Move + remap + verify + commit**
```bash
mkdir -p src/editor
git mv src/editor.* src/actions.* src/editor/
node scripts/move-specifiers.mjs '{"@/editor":"@/editor/editor","@/actions":"@/editor/actions"}'
npm test && npx tsc -p tsconfig.json
git add -A && git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "refactor(studio): move editor + in-editor widgets into src/editor/"
```

### Task 8: `diagnostics/` — diagCountGate, diagnosticsSummary + DiagnosticsStripPanel, WorkspaceProblemsBadge

- [ ] **Move + remap + verify + commit**
```bash
mkdir -p src/diagnostics
git mv src/diagCountGate.* src/diagnosticsSummary.* src/diagnostics/
git mv src/panels/DiagnosticsStripPanel.* src/panels/WorkspaceProblemsBadge.* src/diagnostics/
node scripts/move-specifiers.mjs '{"@/diagCountGate":"@/diagnostics/diagCountGate","@/diagnosticsSummary":"@/diagnostics/diagnosticsSummary","@/panels/DiagnosticsStripPanel":"@/diagnostics/DiagnosticsStripPanel","@/panels/WorkspaceProblemsBadge":"@/diagnostics/WorkspaceProblemsBadge"}'
npm test && npx tsc -p tsconfig.json
git add -A && git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "refactor(studio): move diagnostics logic + panels into src/diagnostics/"
```

### Task 9: `export/` — generateProject, generateProjectWizard, sourceZip, share

- [ ] **Move + remap + verify + commit**
```bash
mkdir -p src/export
git mv src/generateProject.* src/generateProjectWizard.* src/sourceZip.* src/share.* src/export/
node scripts/move-specifiers.mjs '{"@/generateProject":"@/export/generateProject","@/generateProjectWizard":"@/export/generateProjectWizard","@/sourceZip":"@/export/sourceZip","@/share":"@/export/share"}'
npm test && npx tsc -p tsconfig.json
git add -A && git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "refactor(studio): move generate/export/share into src/export/"
```

### Task 10: `welcome/` — welcome, templates, about

Two `templates`-related references need care here (verified during Task 2):
- `welcome/templates.ts` keeps `export { TEMPLATES } from '@/templates.generated'` — the **generated** file stays at `src/templates.generated.ts`, and the map below does NOT remap `@/templates.generated` (a different literal from `@/templates`). Leave it.
- The generated `templates.generated.ts` itself contains `import type { Template } from '@/templates'` (the `Template` type lives in `templates.ts`, which moves here). That string is emitted by `scripts/generate-templates.mjs` line ~128 — a `.mjs` file OUTSIDE `src/`, so the move codemod does NOT touch it. You MUST hand-edit the generator to emit `@/welcome/templates`, or the regenerated file (and the `templates.test.ts:127` assertion, which the codemod updates to `@/welcome/templates`) will mismatch and `tsc` will fail to resolve `@/templates`.

- [ ] **Move + remap + update generator + verify + commit**
```bash
mkdir -p src/welcome
git mv src/welcome.* src/templates.* src/about.* src/welcome/
node scripts/move-specifiers.mjs '{"@/welcome":"@/welcome/welcome","@/templates":"@/welcome/templates","@/about":"@/welcome/about"}'
```
Then edit `scripts/generate-templates.mjs`: change the emitted import line from
`"import type { Template } from '@/templates';\n\n"` to
`"import type { Template } from '@/welcome/templates';\n\n"`.

```bash
# regenerate so the on-disk generated file matches, then verify
node scripts/generate-templates.mjs
grep -n "import type { Template }" src/templates.generated.ts   # expect: from '@/welcome/templates'
npm test && npx tsc -p tsconfig.json
git add -A && git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "refactor(studio): move welcome/templates/about into src/welcome/ (+ sync template generator)"
```

After moving, confirm the generated re-export was left alone:
```bash
grep -rn "@/templates.generated" src/welcome/templates.ts
```
Expected: one line, `export { TEMPLATES } from '@/templates.generated';`

### Task 11: `docs/` — adr, docsPanel, docsStore + DocsPanelHost

- [ ] **Move + remap + verify + commit**
```bash
mkdir -p src/docs
git mv src/adr.* src/docsPanel.* src/docsStore.* src/docs/
git mv src/panels/DocsPanelHost.* src/docs/
node scripts/move-specifiers.mjs '{"@/adr":"@/docs/adr","@/docsPanel":"@/docs/docsPanel","@/docsStore":"@/docs/docsStore","@/panels/DocsPanelHost":"@/docs/DocsPanelHost"}'
npm test && npx tsc -p tsconfig.json
git add -A && git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "refactor(studio): move docs (ADR & notes) logic + panel into src/docs/"
```

### Task 12: `ai/` — ai, aiPanel, assistantTools, secrets

Exact-literal mapping keeps `@/ai`→`@/ai/ai` from disturbing `@/aiPanel` (distinct literal).

- [ ] **Move + remap + verify + commit**
```bash
mkdir -p src/ai
git mv src/ai.* src/aiPanel.* src/assistantTools.* src/secrets.* src/ai/
node scripts/move-specifiers.mjs '{"@/ai":"@/ai/ai","@/aiPanel":"@/ai/aiPanel","@/assistantTools":"@/ai/assistantTools","@/secrets":"@/ai/secrets"}'
npm test && npx tsc -p tsconfig.json
git add -A && git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "refactor(studio): move AI assistant + secrets into src/ai/"
```

### Task 13: `diagrams/` — diagrams, diagrams-svg, diagramLayout, canvasView

The `src/diagrams.*` glob matches `diagrams.ts` only (not `diagrams-svg.*`, which lacks the `diagrams.` prefix dot). Move `diagrams-svg.*` separately.

- [ ] **Move + remap + verify + commit**
```bash
mkdir -p src/diagrams
git mv src/diagrams.* src/diagrams-svg.* src/diagramLayout.* src/canvasView.* src/diagrams/
node scripts/move-specifiers.mjs '{"@/diagrams":"@/diagrams/diagrams","@/diagrams-svg":"@/diagrams/diagrams-svg","@/diagramLayout":"@/diagrams/diagramLayout","@/canvasView":"@/diagrams/canvasView"}'
npm test && npx tsc -p tsconfig.json
git add -A && git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "refactor(studio): move diagram canvas/renderer into src/diagrams/"
```

### Task 14: `model/` — selection, inspector, modelIndex, modelOutline, modelTables, activeContext, glossary + 6 panels

The largest batch (7 modules + 6 panels). Exact-literal keeps `@/inspector`→`@/model/inspector` from touching `@/inspectorController` (moves later, in shell/).

- [ ] **Move + remap + verify + commit**
```bash
mkdir -p src/model
git mv src/selection.* src/inspector.* src/modelIndex.* src/modelOutline.* src/modelTables.* src/activeContext.* src/glossary.* src/model/
git mv src/panels/ContextBreadcrumb.* src/panels/EventsPanel.* src/panels/GlossaryPanel.* src/panels/ModelOutlinePanel.* src/panels/PropertiesPanel.* src/panels/RelationshipsPanel.* src/model/
node scripts/move-specifiers.mjs '{"@/selection":"@/model/selection","@/inspector":"@/model/inspector","@/modelIndex":"@/model/modelIndex","@/modelOutline":"@/model/modelOutline","@/modelTables":"@/model/modelTables","@/activeContext":"@/model/activeContext","@/glossary":"@/model/glossary","@/panels/ContextBreadcrumb":"@/model/ContextBreadcrumb","@/panels/EventsPanel":"@/model/EventsPanel","@/panels/GlossaryPanel":"@/model/GlossaryPanel","@/panels/ModelOutlinePanel":"@/model/ModelOutlinePanel","@/panels/PropertiesPanel":"@/model/PropertiesPanel","@/panels/RelationshipsPanel":"@/model/RelationshipsPanel"}'
npm test && npx tsc -p tsconfig.json
git add -A && git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "refactor(studio): move DDD model surfaces + panels into src/model/"
```

### Task 15: `settings/` — prefs, appearance, theme, and the `store.ts`→`persistence.ts` rename ⚠️

**This is the riskiest batch.** `store.ts` (localStorage persistence) is renamed to `settings/persistence.ts`. The bare specifier `@/store` currently resolves to `store.ts`; once that file is gone, `@/store` would silently re-resolve to the `store/` zustand index. The `git mv` rename and the `@/store`→`@/settings/persistence` remap therefore MUST be in this one commit, and a grep must confirm no bare `@/store` literal survives.

- [ ] **Move (glob for prefs/appearance/theme, explicit rename for store) + remap + verify + commit**
```bash
mkdir -p src/settings
git mv src/prefs.* src/appearance.* src/theme.* src/settings/
git mv src/store.ts src/settings/persistence.ts
git mv src/store.test.ts src/settings/persistence.test.ts
node scripts/move-specifiers.mjs '{"@/prefs":"@/settings/prefs","@/appearance":"@/settings/appearance","@/theme":"@/settings/theme","@/store":"@/settings/persistence"}'
```

- [ ] **Assert the store shadow is fully resolved**
```bash
grep -rnE "['\"]@/store['\"]" src --include=*.ts --include=*.tsx
```
Expected: NO output (every bare `@/store` is now `@/settings/persistence`; only `@/store/index`, `@/store/hooks`, `@/store/slices/...` remain, which this grep does not match).

- [ ] **Verify + commit**
```bash
npm test && npx tsc -p tsconfig.json
git add -A && git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "refactor(studio): move settings + rename store.ts -> settings/persistence.ts"
```

### Task 16: `shell/` — ide, editorSession, inspectorController, workspaceController, historyController, ideUtils, dirty, resize, explorer + HistoryControls, UnsavedIndicator, StoreInspector

Run last: `ide.tsx` imports nearly everything, so by now its references already point at the moved feature folders; this batch only relocates the shell files themselves and repoints references to them. After this, `src/panels/` is empty.

- [ ] **Move + remap + verify + commit**
```bash
mkdir -p src/shell
git mv src/ide.* src/editorSession.* src/inspectorController.* src/workspaceController.* src/historyController.* src/ideUtils.* src/dirty.* src/resize.* src/explorer.* src/shell/
git mv src/panels/HistoryControls.* src/panels/UnsavedIndicator.* src/panels/StoreInspector.* src/shell/
node scripts/move-specifiers.mjs '{"@/ide":"@/shell/ide","@/editorSession":"@/shell/editorSession","@/inspectorController":"@/shell/inspectorController","@/workspaceController":"@/shell/workspaceController","@/historyController":"@/shell/historyController","@/ideUtils":"@/shell/ideUtils","@/dirty":"@/shell/dirty","@/resize":"@/shell/resize","@/explorer":"@/shell/explorer","@/panels/HistoryControls":"@/shell/HistoryControls","@/panels/UnsavedIndicator":"@/shell/UnsavedIndicator","@/panels/StoreInspector":"@/shell/StoreInspector"}'
```

- [ ] **Remove the now-empty `panels/` directory**
```bash
rmdir src/panels
```
Expected: succeeds (directory empty). If it errors "not empty", a panel was missed — run `ls src/panels` and reconcile against the batch maps before continuing.

- [ ] **Verify + commit**
```bash
npm test && npx tsc -p tsconfig.json
git add -A && git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "refactor(studio): move IDE shell + explorer + shell panels into src/shell/"
```

---

### Task 17: Cleanup, doc updates, and final full verification

**Files:**
- Delete: `scripts/relativize-imports.mjs`, `scripts/move-specifiers.mjs`, `src/_alias.smoke.test.ts`
- Modify: any `README`/docs/memory that name moved paths (verified by grep below)

- [ ] **Step 1: Remove the one-shot migration tooling and the temporary smoke test**
```bash
git rm scripts/relativize-imports.mjs scripts/move-specifiers.mjs src/_alias.smoke.test.ts
```

- [ ] **Step 2: Find stale path references in docs/config that name moved modules**
```bash
grep -rnE "src/(ide|explorer|lsp|diagrams|aiPanel|inspectorController|workspaceController|modelOutline|store\.ts)" \
  README.md docs/ website/ tooling/koine-studio/README.md 2>/dev/null | grep -v node_modules | head -40
```
For each genuine hit (a path that no longer exists), update it to the new feature-folder path (e.g. `src/ide.tsx` → `src/shell/ide.tsx`, `src/store.ts` → `src/settings/persistence.ts`). Skip matches that refer to the C# compiler's own `Ast/`/`Services/` (unrelated). If there are no studio-source path references, this step is a no-op.

- [ ] **Step 3: Confirm the flat top level is gone and the tree is clean**
```bash
ls tooling/koine-studio/src/*.ts tooling/koine-studio/src/*.tsx 2>/dev/null
```
Expected: only `main.ts`, `vite-env.d.ts`, `test-setup.ts`, `preactSmoke.tsx`, `preactSmoke.test.tsx`, and (if present from a prior build) the git-ignored `templates.generated.ts` — nothing else at the top level.

- [ ] **Step 4: Final full verification (the real gate)**
```bash
cd tooling/koine-studio
npm test
npm run build
```
Expected: every test passes; `tsc && vite build` completes clean.

- [ ] **Step 5: Commit**
```bash
git add -A
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" \
  commit -m "chore(studio): remove reorg codemods + smoke test, refresh doc paths"
```

---

## Self-review notes (for the implementer)

- **Idempotency:** both codemods are safe to re-run — once a specifier is rewritten, its old literal no longer exists, so a second pass is a no-op.
- **If a batch fails `tsc`/`npm test`:** the cause is almost always (a) a specifier the batch map missed, or (b) a name collision. Check `npx tsc` output for the unresolved `@/...` path, add/fix the map entry, re-run the codemod, re-verify. Do not commit red.
- **Snapshots:** no Verify/snapshot file should change — this refactor moves files and rewrites import paths only. A changed snapshot means an accidental behavior edit; revert and investigate.
- **`main.ts` / `index.html`:** untouched on disk; `index.html` still loads `/src/main.ts`. Only `main.ts`'s own import lines change (its `@/ide` reference becomes `@/shell/ide` in Task 16).
```
