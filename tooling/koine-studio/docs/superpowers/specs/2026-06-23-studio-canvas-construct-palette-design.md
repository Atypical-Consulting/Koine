# Koine Studio — Visual-editor construct palette

**Date:** 2026-06-23
**Status:** Approved (design)
**Area:** `tooling/koine-studio` (Visual tab / domain canvas) + `src/Koine.Compiler` (model round-trip)

## Problem

The Visual editor (the maxGraph domain canvas) can already author a model — drag-to-connect,
rename, delete, and a single floating **"＋ Add a type"** button that inserts a *value-object*
skeleton into the active context. But there is no way to add the other DDD constructs (entity,
aggregate, event, enum, …) from the canvas. The agreed mockup shows a **toolbar of construct
buttons** across the top of the Visual tab (Entité, Objet valeur, Agrégat, Service, Événement,
Règle, Dépôt, Relation, Note, Grouper, Plus).

This adds that toolbar — a **construct palette** — wired so the round-trippable constructs actually
insert valid `.koi` and the rest hold their place as visible "coming soon" affordances.

## Scope (decided)

**Enabled, round-tripping buttons (day one):** Entity · Value Object · Aggregate · Event · Enum.
Each inserts a minimal, *re-validating* skeleton into the active bounded context and round-trips to
`.koi` through the existing `addType` seam.

**Disabled "coming soon" buttons (visible, muted, explanatory tooltip):** Service · Rule ·
Repository · Note · Group. They fill out the mockup layout without faking behavior, so adding them
later is purely additive.

**Relation:** rendered disabled with a tooltip pointing at the existing gesture ("drag from one node
to another to connect"). It is *not* a new code path — drag-to-connect already exists.

**Labels:** English, to match the current app shell (`Visual` / `Code` / `Documentation` tabs are
English; the French mockup is illustrative). Localization is deferred.

### Explicitly out of scope (YAGNI)

Drag-and-drop placement; Note/Group canvas-only annotations; nested Rule/Repository insertion (these
live *inside* an aggregate, not as free nodes); an overflow "Plus" menu. The disabled buttons reserve
their layout slots so each can be turned on independently later.

## Current state (what we build on)

- `diagramContract.ts` **already declares the contract** for this feature but nothing uses it yet:
  - `DIAGRAM_ADD_TYPE_EVENT` — the bubbling "add a type" event.
  - `AddNodeKind = 'aggregate' | 'entity' | 'value' | 'enum' | 'event'`.
  - `DiagramAddNodeDetail { kind: AddNodeKind; context?: string }` — the event detail.
- `diagrams-maxgraph.ts` renders a floating **"＋ Add a type"** button (editing only) that dispatches
  `DIAGRAM_ADD_TYPE_EVENT` *bare* (no detail).
- `ide.tsx#applyDiagramAddType()` handles that event: reads the active scope, prompts for a name,
  and calls `applyStructuredEdit({ kind: 'addType', target: scope, name })`.
- `applyStructuredEdit()` is the shared round-trip write path (`lsp.applyModelEdit` → patch buffer on
  success, surface the rejecting `KOIxxxx` and roll back on failure).
- Server `ModelRoundTripService.Edit.cs#TryAddType()` always emits a **value-object** skeleton; the
  flat `StructuredEdit` record (`Kind, Target, Name, Type, Value`) has a free `Type` field.
- `#center-visual` is the Visual tabpanel; `loadDiagrams()` / `docMessage()` render into it and wipe
  it via `innerHTML`. The diagram-authoring event listeners in `ide.tsx` bind to `#center-visual` and
  rely on event **bubbling**.

## Architecture

### Placement — persistent panel above an inner canvas host

`#center-visual` is restructured from "the canvas is the whole tabpanel" into:

```
#center-visual            (Visual tabpanel — persistent)
 ├─ <CanvasPalette/> host (the construct toolbar — mounted once, survives reloads)
 └─ #diagram-host         (the canvas — what renderDiagrams/docMessage wipe & render into)
```

The renderer, `docMessage`, and the selection cross-highlight `querySelectorAll` are pointed at
`#diagram-host` instead of `#center-visual`. The ide.tsx authoring listeners stay bound to
`#center-visual` — events from both the palette and the canvas still bubble up to them, so that
wiring is unchanged.

Rejected alternative — *renderer-owned floating toolbar*: cheaper, but it disappears on the
empty-state/error views (so you couldn't add your first node), couples the palette to the renderer,
and rebuilds on every reload. The persistent panel matches the mockup and the house leaf-panel
pattern (Storybook + vitest-axe).

### `CanvasPalette` leaf panel (`src/diagrams/CanvasPalette.tsx`)

A small Preact panel — a horizontal toolbar of buttons, each a DDD-colored glyph + English label.

- **Button model:** a static list of `{ kind, label, color, enabled, tooltip }`. Enabled kinds map
  to `AddNodeKind`; disabled kinds carry a "Coming soon" / gesture-hint tooltip.
- **Colors** reuse the canvas DDD palette so a button matches the node it creates: entity `#34d399`,
  value `#5aa9f0`, aggregate `#8b87f5`, event `#f472b6`, enum `#fbbf24`. (Source of truth is
  `abstracts/_ddd.scss` / `DDD_HEX` in `diagrams-maxgraph.ts`; share, don't duplicate.)
- **Dispatch:** clicking an enabled button dispatches `DIAGRAM_ADD_TYPE_EVENT` with
  `DiagramAddNodeDetail { kind }` on its host (so it bubbles to `#center-visual`). This reuses the
  documented contract end-to-end — exactly one handler path.
- **Context gating:** the panel subscribes to the `activeContext` store slice. When the active scope
  is a single bounded context, the round-trip buttons are enabled; when it is "All contexts", they
  are disabled with a "Select a context first" tooltip (replacing today's click-then-error).
- **Accessibility:** semantic `<button>`s with `aria-label`s, a labelled toolbar container
  (`role="toolbar"`), keyboard-focusable; disabled buttons use the real `disabled` attribute. Passes
  vitest-axe.

### Server — `TryAddType` learns the construct kind

`StructuredEditKind.AddType` stays the single edit kind; the construct is carried in the existing free
`StructuredEdit.Type` field (`null` ⇒ `value`, fully back-compatible with the old bare button). The
allowed values mirror `AddNodeKind`: `value` | `entity` | `aggregate` | `event` | `enum`.

`TryAddType` switches the inserted skeleton on `edit.Type` (all inserted at the same context-level
position the current code computes). Each skeleton is the minimal form that **re-validates** (the
round-trip rejects anything that doesn't), so a green test proves the emitted construct compiles:

| Kind        | Skeleton |
|-------------|----------|
| `value`     | `value Name { name: String }` *(unchanged)* |
| `entity`    | `entity Name identified by NameId { name: String }` |
| `aggregate` | `aggregate Name root NameRoot { entity NameRoot identified by NameRootId { name: String } }` |
| `event`     | `event Name { occurredAt: Instant }` |
| `enum`      | `enum Name { First, Second }` |

The aggregate skeleton **nests its own root entity** so it is self-contained and always validates
(an aggregate's `root` must name an existing entity). `NameId` / `NameRootId` are the auto-generated
default-Guid identity types (no explicit declaration needed, matching the starter templates).

`StructuredEditKind.AddType`'s XML doc is updated to describe the `Type`-carried construct selector.

### Client wiring (`ide.tsx`)

- `applyDiagramAddType(detail?: DiagramAddNodeDetail)` gains the optional detail. It maps
  `detail.kind` → the construct keyword, prompts for a name pre-filled with a kind default
  (`NewEntity`, `NewValue`, `NewAggregate`, `NewEvent`, `NewEnum`), and calls
  `applyStructuredEdit({ kind: 'addType', target: scope, name, type: construct }, …)`. A missing
  detail still defaults to `value` (back-compat).
- The `DIAGRAM_ADD_TYPE_EVENT` listener reads `(e as CustomEvent<DiagramAddNodeDetail>).detail` and
  forwards it.
- The floating **"＋ Add a type"** button is removed from `diagrams-maxgraph.ts` (the palette
  replaces it). Zoom / fit / auto-arrange stay as floating canvas controls.
- `CanvasPalette` is mounted into its host during the center-pane setup (alongside the other panel
  mounts in `inspectorController` / `ide.tsx`).

## Data flow (add an Entity)

```
click "Entity"  →  CanvasPalette dispatches DIAGRAM_ADD_TYPE_EVENT { kind: 'entity' }
                →  (bubbles to #center-visual)  ide.tsx applyDiagramAddType(detail)
                →  prompt name ("NewEntity")    →  applyStructuredEdit({kind:'addType',
                                                       target: ctx, name, type:'entity'})
                →  lsp.applyModelEdit  →  server TryAddType emits entity skeleton, re-validates
                →  success: patch buffer  →  onDocEdited  →  canvas + inspector re-render
                   failure: KOIxxxx in status bar, nothing applied (rolled back)
```

## Testing

**Server (`tests/Koine.Compiler.Tests/`):** a round-trip test per construct kind — apply an
`addType` with each `Type`, assert the inserted `.koi` and that the whole model still re-validates;
the existing Verify snapshots + Roslyn compile/execute meta-test prove the emitted C# is real. Cover
the back-compat path (`Type == null` ⇒ value) and rejection (duplicate name still returns `KOIxxxx`).

**Client (`tooling/koine-studio`, vitest):**
- `CanvasPalette` renders the enabled + disabled buttons with correct labels/colors.
- Clicking an enabled button dispatches `DIAGRAM_ADD_TYPE_EVENT` with the right `{ kind }` detail;
  a disabled button dispatches nothing.
- Context gating: enabled with a single context active, disabled under "All contexts".
- vitest-axe: no a11y violations.
- A Storybook story for the panel (per the leaf-panel convention).
- `ide.tsx` integration: `applyDiagramAddType({kind})` issues an `addType` edit carrying the mapped
  `type`, and a bare/undefined detail still defaults to value.

## Files touched

- `src/Koine.Compiler/Services/StructuredEdit.cs` — XML doc for `AddType`'s `Type` selector.
- `src/Koine.Compiler/Services/ModelRoundTripService.Edit.cs` — `TryAddType` skeleton switch.
- `tooling/koine-studio/index.html` — `#diagram-host` inside `#center-visual` (+ palette host).
- `tooling/koine-studio/src/diagrams/CanvasPalette.tsx` (new) + story + test.
- `tooling/koine-studio/src/diagrams/diagramContract.ts` — minor doc touch-ups if needed (contract
  already present).
- `tooling/koine-studio/src/diagrams/diagrams-maxgraph.ts` — drop the floating "＋ Add a type".
- `tooling/koine-studio/src/shell/inspectorController.tsx` — render/`docMessage`/selection-query at
  `#diagram-host`; mount the palette.
- `tooling/koine-studio/src/shell/ide.tsx` — `applyDiagramAddType(detail)` + listener forwarding.
- Styles: a `.koi-canvas-palette` rule (DDD swatches, disabled state) in the canvas/model SCSS.
- New `R##`/Studio tests as above.

## Risks & mitigations

- **Skeleton must re-validate.** The aggregate's nested-root form and the auto-generated identity
  types are the subtle ones — covered by a per-kind round-trip test (TDD: write the failing test
  first).
- **Inner-host refactor.** Pointing the renderer at `#diagram-host` is mechanical; the bubbling-based
  ide.tsx listeners are unaffected. Guard with the existing diagram render tests.
- **Dual-backend parity.** The change is server-side skeleton logic + an extra field already on the
  wire (`Type`); the WASM host and desktop LSP share the same `ModelRoundTripService`, so parity holds.
```
