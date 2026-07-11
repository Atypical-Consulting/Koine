# Preact migration recipe (Studio chrome)

> Status: **#759 landed** (finishing the #193 foundation). The interactive chrome hosts now render via
> Preact — the right strip, the left rail, and the AI-Chat host were migrated, the export menu was
> consolidated into a tested component, and the capability gate + this recipe were established. The
> remaining imperative DOM is the intentional islands listed under *non-goals* below. This doc stays the
> contract for migrating any future panel and for the gate.

## Why

Studio's interactive chrome was historically rendered three ways at once:

1. **Static markup** in `tooling/koine-studio/index.html` (panel shells — `#leftrail`, `#right-strip`,
   the `rview-*` right-rail hosts, the diagnostics/output tabpanels).
2. **Imperative DOM** — `innerHTML` / `document.createElement` string-assembly in `src/shell/*.ts`
   (e.g. the string builders `leftRailMarkup()` / `rightStripMarkup()`).
3. **Preact islands** — real `.tsx` components rendered with Preact `render()`, subscribing to the
   Zustand store via `useAppStore` (`src/store/hooks.ts`).

The imperative + static halves are where the bugs leak in (drifting `aria-*`/ids hand-maintained in
string markup; unfinished surfaces shipped as empty voids or "Coming soon." placeholders). The
direction is **monotonic toward Preact**: every migrated surface becomes a declarative subscriber of
the store, typed and axe-tested. Coexistence of paradigms *during* the rollout is acceptable.

## The reactive center and the seams (do not move these)

- **Zustand store** (`src/store/index.ts`, `createAppStore()` + the singleton `appStore`) is the
  reactive center. Migrated panels read state through `useAppStore(store, selector)` (`src/store/hooks.ts`)
  instead of querying the DOM and re-templating strings.
- **Host seam** (`src/host/`) stays the imperative I/O boundary (Tauri / browser-WASM). Panels read
  host capabilities **through the store**, never by reaching into `src/host` directly.

## Non-goals — surfaces that STAY imperative

- **CodeMirror** (the editor) and **maxGraph** (the domain canvas, #66) are imperative-by-design
  islands that own and mutate their own DOM/lifecycle. We may wrap them in a thin Preact host that
  mounts/unmounts them, but we do **not** re-render their internals through Preact. Do not "migrate" them.
- The **`src/host/` seam** stays imperative.

> The assistant **`aiPanel`** is no longer on this list: #984 moved its state into the store's `chat`
> slice (`src/store/slices/chat.ts`) and #990 migrated its DOM to Preact components
> (`src/ai/components/AssistantChat.tsx` + `Transcript`/`ChangeSetPanel`/`Composer`/`MdHtml`).
> `src/ai/aiPanel.ts` survives only as the deps-binding + send-effect factory (`createAssistantChat`)
> behind the same `{ focusInput, syncWorkspace, explainSelection }` handle.

## Per-panel recipe (6 steps)

1. **Find the imperative mount.** Locate the `innerHTML` / `createElement` site in `src/shell/*.ts` (or
   the string builder) and the state the panel reads.
2. **Write the story + axe test FIRST (red).** A `Panel.stories.tsx` (`@storybook/preact-vite`, seed
   with `createAppStore()`) and a `Panel.test.tsx` with an `expect(await axe(container)).toHaveNoViolations()`
   assertion. a11y is verified, not hoped for.
3. **Implement `Panel.tsx`.** A Preact component taking `{ store }` (and any callbacks), subscribing via
   `useAppStore(store, selector)`. Move the markup off the string builder into JSX with proper
   `aria-*`/ids. **Preserve every id the controllers query** (or update the controller in the same task).
4. **Replace the imperative mount** with a single `render(<Panel store={appStore} … />, host)` at the
   existing host id. For a panel that *governs* a static index.html element (rather than owning a
   subtree), follow the `UnsavedIndicator` pattern: subscribe in a `useEffect`, drive the host node
   directly, and `return null` — so Preact and the imperative DOM never fight over the same node.
5. **Green.** `npx vitest run --project '!storybook'` (unit + axe). The Storybook/Chromium project runs
   in CI (`.github/workflows/koine-studio.yml`); don't expect it to run headless locally without Chromium.
6. **Commit.** One panel per task/PR; a panel never changes observable behavior (same ids, same affordances).

## Gating incomplete surfaces — `panelGate`

A surface that is not yet ready for users must be **hidden**, not shipped as an empty void or a
"Coming soon." placeholder. Use the capability gate (`src/shell/panelGate.ts`):

```ts
import { panelEnabled } from '@/shell/panelGate';

if (panelEnabled('my-surface')) {
  // render the real panel
}
// otherwise render nothing (hidden) — never a bare placeholder
```

`panelGate` is **default-closed and fail-closed**: a capability is hidden until explicitly enabled, and
a storage failure reads as hidden. In a **dev build** (`isDevMode()`), a gated panel is forced visible so
the developer building it can see it without flipping a flag. It reuses the throw-safe `PersistedFlag`
(`src/shell/localStorageFlag.ts`) — no new storage primitive. Enable a capability for a session with
`panelGate('my-surface').enable()` (writes `koine.studio.panel.my-surface`).

## Machine-enforced conventions — the ESLint gate (#978)

The four load-bearing safety conventions are no longer review-only. A flat-config ESLint gate
(`eslint.config.mjs` in both `tooling/koine-studio` and `tooling/koine-ui`, run by `npm run lint` and
CI-gated in `.github/workflows/koine-studio.yml`'s `studio-web` job) enforces them mechanically for all
new code. It is deliberately narrow — these conventions, **not** a style regime; tsc + review stay
authoritative for style:

- **Void-prefixed floating promises** — `@typescript-eslint/no-floating-promises` / `no-misused-promises`
  (type-checked): a fire-and-forget async call must be `await`ed, `.catch()`-ed, or explicitly `void`-ed.
- **`domById` over bare `getElementById`** — `no-restricted-properties`: look up required chrome through
  `src/shared/domById.ts` so a missing `#id` throws loudly instead of a silent `null`.
- **Escape-before-`innerHTML`** — `no-restricted-syntax` bans the HTML-injection sinks `x.innerHTML =` /
  `x.outerHTML =` / `insertAdjacentHTML(…)`; use `textContent` / `el()` / JSX, or `renderMarkdown` output
  behind a justified disable.
- **react-hooks rules** — `react-hooks/rules-of-hooks` + `exhaustive-deps` (the plugin is source-level, so
  it works on Preact's `preact/hooks` without a compat shim).

### The disable protocol (every escape hatch is justified)

This is a **review convention**, not a lint rule — the gate enforces the four rules above, not the *shape*
of disable comments (no `require-description` rule is configured). Reviewers hold the line on it:

- **Every `eslint-disable` should carry a `-- <reason>` justification** — no bare disables. New directives
  use the same-line `-- reason` form; a few pre-#978 directives (e.g. the `react-hooks/exhaustive-deps`
  ones in `DeckStage.tsx` / `searchController.tsx`) put the reason on the preceding line — that's fine.
- **The `innerHTML` allow-list has two tiers** in `eslint.config.mjs`:
  - **Permanent islands** (`src/editor/**`, `src/diagrams/diagrams-maxgraph.ts`, `src/host/**`) — the
    CodeMirror / maxGraph / host-seam non-goals above; imperative by design, off permanently.
  - **Pending-migration islands** — one entry per already-imperative panel (a few related panels may share
    one entry), **each naming the migration issue that retires it** (the
    self-contained panels welcome/about/generate-project → #991, the model/docs builders → #992; settings
    `prefs.ts` and `inspectorController.tsx` span the arc — the config lists their exact issue set;
    aiPanel's entry was deleted when #990 landed; the explorer's entry was deleted when #989 landed). This
    is a **file-level** allow-list, not a per-file count budget: it freezes the *set of files* permitted to
    use `innerHTML` — any new file, and all non-island prod, stays fully gated — and shrinks as each panel
    migrates. **Shrinking this allow-list to empty is the definition of done for the migration arc.**

## Inventory of imperative islands (grouped)

> **Authoritative inventory:** the `no-restricted-syntax` (`innerHTML`) allow-list in `eslint.config.mjs`
> is now the canonical, CI-checked census of pending-migration islands — one entry per file, each named
> with the issue that retires it (#978). The hand-run grep below stays as a quick cross-check, not the
> source of truth: `grep -rE 'innerHTML|document\.createElement' src/shell | grep -v '\.test\.' | wc -l`.
> The remaining sites are the intentional imperative islands below (CodeMirror, maxGraph, the
> `src/host` seam, and — since #985 split `inspectorController.tsx` into `src/shell/inspector/**` —
> that subfolder's own direct DOM writers: `contextMapPanel.tsx` (the Context Map facet, #146) and
> `surfaceLoaders.tsx` (the Compatibility-check paint and the shared loading/error `docMessage` helper).
> `inspectorController.tsx` itself carries none anymore. Not chrome shells. (The all-files count is
> higher because the migrated panels' tests now seed their hosts via Preact `render`/`createElement`.)

- **Already Preact (reference patterns — do not redo):** `HistoryControls`, `UnsavedIndicator`,
  `CompilingIndicator`, `MobileZoneBar`, `StoreInspector`, `inspectorSheet`; `src/model/PropertiesPanel`,
  `RelationshipsPanel`, `EventsPanel`, `GlossaryPanel` (genuinely JSX since #992 — see below);
  `SourceControlPanel`; `src/docs/DocsPanelHost` (+ `DocsPanels.tsx`'s `AdrPanel`/`NotesPanel` and
  `MdHtml`, also genuinely JSX since #992); the assistant chat —
  `src/ai/components/AssistantChat.tsx` (+ `Transcript`, `ChangeSetPanel`, `Composer`, `MdHtml`) over the
  `chat` slice (#984/#990); the file explorer — `src/shell/ExplorerPanel.tsx` (+ `ExplorerItem`,
  `explorerModel.ts`) over the `uiChrome` slice's `explorerFilter`/`explorerCollapsed` fields (#989); and
  the **five self-contained surfaces migrated in #991** — the **Domain navigator**
  (`src/model/DomainNavigator.tsx`, facade `domainNavigator.ts`, consuming the shared `rovingTreeNav.ts`
  from #1105 rather than re-inlining roving-tabindex), the **Generate Project wizard**
  (`src/export/GenerateProjectWizard.tsx`, facade `generateProjectWizard.ts`), the routed **Home** view
  (`src/welcome/Home.tsx`, facade `welcome.ts` — stays store-free, mounts pre-IDE-boot), the **About**
  panel (`src/settings/About.tsx`, facade `about.ts`), and the **keyboard-shortcuts** table
  (`src/shared/HelpTable.tsx`, facade `help.ts`), each behind its unchanged factory facade so no
  production caller changed. #991 is the **first application of this recipe beyond `src/shell`** — the
  census greps below were written when every island lived in the shell; the recipe applies repo-wide
  across `koine-studio/src` (`src/model`, `src/export`, `src/welcome`, `src/settings`, `src/shared`).
  Two shared conventions this tranche established: (1) a `PascalCase.tsx` component whose facade shares
  its basename in lowercase (`About.tsx`/`about.ts`) must be imported with an **explicit `.tsx`
  extension** — a bare specifier resolves to the `.ts` facade first on a case-insensitive filesystem and
  silently renders `[object Object]`; (2) a `.tsx` panel's static-constant `dangerouslySetInnerHTML`
  (brand mark / hero SVG) carries a per-line `// eslint-disable-next-line no-restricted-syntax -- <reason>`
  (About.tsx is the reference), since the file-level `innerHTML` allow-list does not cover the JSX form.

> **The model/docs panels finished their arc in #992.** `PropertiesPanel`, `RelationshipsPanel` /
> `EventsPanel` (via the shared `SortableTable` component), `GlossaryPanel`, and the Docs pages
> (`DocsPanelHost` mounting `DocsPanels.tsx`'s `AdrPanel`/`NotesPanel`, markdown confined to one
> `MdHtml` component) were listed above even before #992, but each was really a callback-ref bridge
> — a Preact-rendered shell whose ref callback called a pure-DOM `render*(data, handlers) → HTMLElement`
> builder and `replaceChildren`'d the result into the host. #992 (tasks 1, 3, 4, 5) retired every one of
> those builders (`renderInspector`, `renderTable`/`buildRow`, `renderGlossary`/`renderEntry`,
> `docsPanel.ts`'s `renderAdrPanel`/`renderNotesPanel`) in favor of real JSX trees mounted with an
> ordinary `render(<Panel .../>, host)`. One payoff went with the `PropertiesPanel` builder specifically:
> the synthetic `'commit'` `CustomEvent` its old row inputs dispatched (every editable field now takes an
> ordinary `onCommit` callback prop instead) — and the `railEmpty` helper it used for its own empty state
> is gone too. The callback-ref bridge pattern itself is retired for these panels — a callback ref now
> only *captures a host node* for a controller to `render()` into (see `DocsPanelHost.tsx`), never to
> hand off to a string/DOM builder.
>
> **`ModelOutlinePanel`/`ContextBreadcrumb` are gone from this list — not converted, deleted.** Both were
> already dead code before #992 started: mounted nowhere in the live app (imported only by their own
> tests/stories — the left-rail Domain navigator, `domainNavigator.ts`, had already superseded
> `ModelOutlinePanel`, and #923 had already superseded `ContextBreadcrumb`'s top-bar scope `<select>`
> with the status-bar Context segment). Unrelated upstream cleanup deleted both components outright
> before this branch existed — #1180 removed `ModelOutlinePanel.tsx`/`ContextBreadcrumb.tsx` (+ their
> stories/tests) as dead code, and #1189 then removed the DOM builder (`renderModelOutline` in
> `modelOutline.ts`) that #1180's removal had orphaned. `ModelOutlinePanel.tsx` was also where the OTHER
> post-render DOM pass this arc set out to kill lived: a `querySelectorAll('.koi-model-leaf')` +
> `classList.toggle('is-selected', …)` loop re-marking selection after every rebuild. #1180's dead-code
> removal deleted that pass along with the panel — it hadn't been running in the live app for a while.
> So this plan's own task 2, which would have converted `ModelOutlinePanel`/`ContextBreadcrumb` to JSX
> and deleted that cross-highlight pass, found nothing left to do and was a no-op — #992 did not convert
> these two, because there was nothing left to convert. `modelOutline.ts` survives only for the pure
> helpers the Domain navigator (`domainNavigator.ts`, itself out of #992's scope) still imports —
> `constructIcon`, `constructForKind`, `countsByContext` — including the one remaining
> `document.createElement` call in the whole `src/model/*` module set (`constructIcon`), which is fine:
> it's a Domain-navigator leaf icon, not a model/docs panel builder.

- **Migrated in #759:** the **right strip** → `src/shell/RightStrip.tsx`; the **left rail** →
  `src/shell/LeftRail.tsx`; the **AI-Chat host** → `src/shell/AssistantView.tsx` (a thin Preact host
  around the imperative `aiPanel`); the **export menu** → `src/diagrams/ExportMenu.tsx`; the capability
  **gate** → `src/shell/panelGate.ts`. Each renders once into its `index.html` thin-shell host, so the
  controller's captured nodes and the imperative islands mounted into the rail's `#filetree-body` /
  `#rail-domain-pane` hosts are never reconciled away.
- **Resolved by prior work (no longer placeholders):** the right-rail **Rules** / **Notes** tabs were
  retired in #730 (invariants now surface in Properties; model Notes live in the center Deck's Docs
  surface); the **Compatibility** `view-check` paints a real "Check against baseline…" idle state.
- **Stay imperative (non-goals):** **CodeMirror** (the editor, `editorSession`), **maxGraph** (the domain
  canvas, fills `#rail-domain-pane`), the **`src/host/` seam**, and the global export-menu **dismissal**
  seam (`exportMenuDismiss.ts`, a document-level listener). These own and mutate their own DOM/lifecycle;
  do not re-render them through Preact. (The assistant panel left this list with #990 — the lazy SDK load
  survives inside its send effect; `AssistantView` now hosts Studio's Preact `AssistantChat`.)

> The **file explorer** is no longer on this list: #989 replaced the imperative tree and its re-render/
> interaction-deferral machinery (`explorer.ts`, `#filetree-body`) with a keyed Preact `ExplorerPanel`
> (`src/shell/ExplorerPanel.tsx` + `ExplorerItem.tsx` + `explorerModel.ts`) mounted behind a thin
> `createExplorer(cb)` facade (`src/shell/explorer.tsx`). The imperative tree had been a recurring bug
> generator — closed bug #355 (a multi-root inline-create input mis-mounted outside its group) traced to
> state reconstructed by re-querying the DOM after a rebuild instead of being owned by a component — and
> keyed Preact reconciliation makes that whole class of bug structurally impossible: a re-render can no
> longer tear down an open rename input, a mid-drag row, or an open menu. The host contract (`ide.tsx`
> wiring, `ExplorerCallbacks`, the `#filetree-body` mount) was preserved untouched throughout. The other
> islands in this list — CodeMirror, maxGraph, the `src/host/` seam, `exportMenuDismiss.ts` — remain
> unchanged non-goals; this migration doesn't touch them.
