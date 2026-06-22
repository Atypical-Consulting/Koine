# Koine Studio `src/` feature-area reorganization

**Date:** 2026-06-22
**Status:** Approved (design)
**Scope:** `tooling/koine-studio/src/`

## Problem

`tooling/koine-studio/src/` has ~52 TypeScript modules sitting flat at the top level (89 files
counting co-located `.test.ts(x)`). A few subtrees are already organized by a deliberate convention —
`panels/` (Preact UI panels), `store/` + `store/slices/` (the single zustand app store), `host/` +
`host/browser/` (platform backends), `styles/`, `assets/` — but the bulk of the app's logic, services,
and feature surfaces are an undifferentiated flat list. Finding "everything that touches the AI
assistant" or "everything that touches diagrams" means scanning the whole directory.

All internal imports are **relative paths** (`from './editor'`, `from '../store/index'`); there is no
path alias and no `tsconfig` `paths` mapping. So any move forces relative-import rewrites across the
tree, and `../` depth is fragile against future reorganizations.

## Goal

Group `src/` **by feature area** so that everything touching one product feature — its logic, its
services, and its UI panel(s) — lives together in one folder. Realize this fully (fold the existing
`panels/` components into their feature folders), and introduce a `@/` → `src/` path alias so this
move and all future moves are stable absolute-path edits rather than `../` juggling.

Non-goals: splitting up the large modules (`ide.tsx`, `diagrams-svg.ts`, `inspectorController.tsx`,
`explorer.ts`), changing runtime behavior, or touching the compiler/LSP/`Ast/` C# side. This is a pure
structural move + alias introduction; emitted behavior and the public app are unchanged.

## Target layout

Each module's co-located `.test.ts` / `.test.tsx` moves **with** it. Vitest discovers tests by glob
(`src/**/*.test.ts`, `src/**/*.test.tsx` — see `vitest.config.ts`), so co-located tests in subfolders
keep being found with no config change.

| Folder | Logic modules | Panels folded in (from `panels/`) |
|---|---|---|
| `shell/` | ide, editorSession, inspectorController, workspaceController, historyController, ideUtils, dirty, resize, explorer | HistoryControls, UnsavedIndicator, StoreInspector |
| `editor/` | editor, actions | — |
| `lsp/` | lsp | — |
| `ai/` | ai, aiPanel, assistantTools, secrets | — |
| `mcp/` | mcp | — |
| `diagrams/` | diagrams, diagrams-svg, diagramLayout, canvasView | — |
| `model/` | selection, inspector, modelIndex, modelOutline, modelTables, activeContext, glossary | ContextBreadcrumb, EventsPanel, GlossaryPanel, ModelOutlinePanel, PropertiesPanel, RelationshipsPanel |
| `docs/` | adr, docsPanel, docsStore | DocsPanelHost |
| `diagnostics/` | diagCountGate, diagnosticsSummary | DiagnosticsStripPanel, WorkspaceProblemsBadge |
| `export/` | generateProject, generateProjectWizard, sourceZip, share | — |
| `welcome/` | welcome, templates, about | — |
| `settings/` | prefs, appearance, theme, **persistence** (renamed from `store.ts`) | — |
| `shared/` | overlay, palette, help, logo, platform | — |

**Stay at `src/` root** (these are not features):
- `main.ts` — the entry point referenced by `index.html` (`<script src="/src/main.ts">`); bootstraps
  fonts + `styles/main.scss` and calls `init()` from `ide.tsx`. Moving it would require editing
  `index.html`; keep it at root.
- `vite-env.d.ts` — ambient type declarations.
- `test-setup.ts` — referenced by `vitest.config.ts` as `./src/test-setup.ts`.
- `preactSmoke.tsx` (+ test) — toolchain smoke proving Preact JSX compiles; a build artifact, not a
  feature.

**Untouched** (already well-organized): `store/` (+ `slices/`), `host/` (+ `browser/`), `styles/`,
`assets/`.

### Why `store/slices/` stays centralized

The slices compose into a single zustand store in `store/index.ts`. Scattering them into feature
folders would fight that single-store-composition pattern and gain nothing. The runtime store stays a
cross-cutting concern under `store/`; feature folders consume it via `@/store`.

### Two judgment calls (vetoable)

1. **Rename `store.ts` → `settings/persistence.ts`.** The top-level `store.ts` is the localStorage
   persistence layer (typed settings + recent-folders list). Keeping a file literally named `store.ts`
   directly beside the `store/` zustand folder is a name collision waiting to confuse. Renaming to
   `settings/persistence.ts` removes the ambiguity. (All importers become `@/settings/persistence`.)
2. **`StoreInspector` → `shell/`.** It's a developer panel that renders the zustand store's state — IDE
   dev chrome rather than a product feature, so it lives with the shell rather than getting its own
   `devtools/` folder for one file.

## Path alias `@/` → `src/`

Three config files, all in `tooling/koine-studio/`:

1. `tsconfig.json` — under `compilerOptions`, add:
   ```jsonc
   "baseUrl": ".",
   "paths": { "@/*": ["src/*"] }
   ```
2. `vite.config.ts` — add to the existing `resolve.alias` (next to the preact aliases):
   ```ts
   "@": fileURLToPath(new URL("./src", import.meta.url))
   ```
   (import `fileURLToPath` from `node:url`).
3. `vitest.config.ts` — add the **same** `@` entry to *its* `resolve.alias`. Vitest does not inherit
   `vite.config.ts`'s resolve config (the file already re-declares the preact aliases for exactly this
   reason), so the alias must be repeated here or the test run won't resolve `@/`.

`moduleResolution` is already `bundler` with extensionless imports, so `@/model/selection` resolves the
same way `./selection` does today. No import-extension changes needed.

## Execution — alias first, then move in batches

Sequencing the alias **before** any file move is the key de-risking move: once every internal import is
the absolute form `@/x`, moving a file only requires updating the *references to it*, not the moved
file's own imports. References are location-independent.

**Phase 1 — Introduce alias + sweep imports (no file moves).**
- Add the alias to the three config files.
- Convert every internal relative import across `src/` (`./x`, `../x`, `../../x`) to `@/x`.
- Commit. This phase moves zero files and changes zero behavior — a pure mechanical import rewrite.

**Phase 2 — Move into feature folders, one folder per commit.**
- For each feature folder in the table: create it, `git mv` the modules + their co-located tests + the
  folded-in panels into it, then find/replace the now-absolute references `@/<oldname>` →
  `@/<area>/<file>` across the whole tree.
- One feature folder per commit so each commit is independently green, reviewable, and bisectable.
- Order: leaf/low-fan-in folders first (`shared/`, `lsp/`, `mcp/`, `editor/`, `diagnostics/`,
  `export/`, `welcome/`, `docs/`, `ai/`, `diagrams/`, `model/`, `settings/`), `shell/` last since
  `ide.tsx` imports nearly everything.

**Phase 3 — Cleanup.**
- The `store.ts` → `settings/persistence.ts` rename (Phase 2's `settings/` batch may fold this in).
- Update references to old paths in `README`, `website/` docs, and the auto-memory
  `studio-architecture.md` pointer if it names moved files.

## Verification gate

After **every** commit (Phase 1 and each Phase 2 batch), both must be green:

- `npm test` — `vitest run`, the ~89-file suite.
- `npm run build` — `tsc` (typecheck; `strict` + `noUnusedLocals` + `noUnusedParameters` catch dangling
  imports/symbols) then `vite build`.

A green run at each step proves the move preserved every import edge and the app still type-checks and
bundles. CI runs the same scripts.

## Risks & mitigations

- **Broad import churn** → mitigated by doing the alias sweep first (Phase 1), so moves touch only
  referencing lines, and by one-folder-per-commit batching with a green gate between each.
- **Vitest not inheriting the vite alias** → explicitly add `@` to `vitest.config.ts` (called out
  above); the test suite would otherwise fail to resolve `@/`.
- **`index.html` entry path** → `main.ts` deliberately stays at `src/` root; `index.html` is untouched.
- **`model/` is the largest folder** (13 modules + 6 panels) → acceptable as one coherent area; a
  later `model/glossary/` sub-split is possible but out of scope here.
- **`templates.generated.ts`** (git-ignored, emitted to `src/templates.generated.ts` by
  `scripts/generate-templates.mjs`) → leave the generated file at `src/` root and the generator
  unchanged; `welcome/templates.ts` keeps re-exporting it via `@/templates.generated` (the exact-literal
  move codemod remaps only `@/templates`, never `@/templates.generated`). Do not "fix" this to live
  under `welcome/`.
- **`store.ts` vs `store/` name shadow** → once `store.ts` is renamed, the bare specifier `@/store`
  would silently re-resolve to the `store/` zustand index. The rename `git mv` and the
  `@/store`→`@/settings/persistence` rewrite MUST land in the **same commit**, with a post-commit grep
  asserting no bare `@/store` specifier literal remains. This is the single riskiest step.
