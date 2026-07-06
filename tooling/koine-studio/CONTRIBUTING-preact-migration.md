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
    one entry), **each naming the migration issue that retires it** (explorer → #989, the
    self-contained panels welcome/about/generate-project → #991, the model/docs builders → #992; settings
    `prefs.ts` and `inspectorController.tsx` span the arc — the config lists their exact issue set;
    aiPanel's entry was deleted when #990 landed). This
    is a **file-level** allow-list, not a per-file count budget: it freezes the *set of files* permitted to
    use `innerHTML` — any new file, and all non-island prod, stays fully gated — and shrinks as each panel
    migrates. **Shrinking this allow-list to empty is the definition of done for the migration arc.**

## Inventory of imperative islands (grouped)

> **Authoritative inventory:** the `no-restricted-syntax` (`innerHTML`) allow-list in `eslint.config.mjs`
> is now the canonical, CI-checked census of pending-migration islands — one entry per file, each named
> with the issue that retires it (#978). The hand-run grep below stays as a quick cross-check, not the
> source of truth: `grep -rE 'innerHTML|document\.createElement' src/shell | grep -v '\.test\.' | wc -l`.
> The remaining sites are the intentional imperative islands below (CodeMirror, the file explorer,
> maxGraph, the `src/host` seam, and inspectorController's direct DOM writes) —
> not chrome shells. (The all-files count is higher because the migrated panels' tests now seed their
> hosts via Preact `render`/`createElement`.)

- **Already Preact (reference patterns — do not redo):** `HistoryControls`, `UnsavedIndicator`,
  `CompilingIndicator`, `MobileZoneBar`, `StoreInspector`, `inspectorSheet`; `src/model/PropertiesPanel`,
  `RelationshipsPanel`, `EventsPanel`, `GlossaryPanel`, `ModelOutlinePanel`, `ContextBreadcrumb`,
  `SourceControlPanel`; `src/docs/DocsPanelHost`; the assistant chat —
  `src/ai/components/AssistantChat.tsx` (+ `Transcript`, `ChangeSetPanel`, `Composer`, `MdHtml`) over the
  `chat` slice (#984/#990).
- **Migrated in #759:** the **right strip** → `src/shell/RightStrip.tsx`; the **left rail** →
  `src/shell/LeftRail.tsx`; the **AI-Chat host** → `src/shell/AssistantView.tsx` (a thin Preact host
  around the imperative `aiPanel`); the **export menu** → `src/diagrams/ExportMenu.tsx`; the capability
  **gate** → `src/shell/panelGate.ts`. Each renders once into its `index.html` thin-shell host, so the
  controller's captured nodes and the imperative islands mounted into the rail's `#filetree-body` /
  `#rail-domain-pane` hosts are never reconciled away.
- **Resolved by prior work (no longer placeholders):** the right-rail **Rules** / **Notes** tabs were
  retired in #730 (invariants now surface in Properties; model Notes live in the center Deck's Docs
  surface); the **Compatibility** `view-check` paints a real "Check against baseline…" idle state.
- **Stay imperative (non-goals):** **CodeMirror** (the editor, `editorSession`), the **file explorer**
  (`explorer.ts`, fills `#filetree-body`), **maxGraph** (the domain canvas, fills `#rail-domain-pane`),
  the **`src/host/` seam**, and the global export-menu **dismissal** seam (`exportMenuDismiss.ts`, a
  document-level listener). These own and mutate their own DOM/lifecycle; do not re-render them through
  Preact. (The assistant panel left this list with #990 — the lazy SDK load survives inside its send
  effect; `AssistantView` now hosts Studio's Preact `AssistantChat`.)
