# Visual-editor Construct Palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a toolbar of DDD-construct buttons to Koine Studio's Visual editor so a modeller can insert an Entity, Value Object, Aggregate, Event, or Enum into the active bounded context with one click.

**Architecture:** A persistent Preact leaf panel (`CanvasPalette`) sits above the domain canvas inside `#center-visual`; the canvas now renders into an inner `#diagram-host`. Each enabled button calls an `onAdd(kind)` callback that ide.tsx turns into an `addType` structured edit carrying the construct kind in `StructuredEdit.Type`; the server's `TryAddType` switches the inserted, re-validating `.koi` skeleton on that kind. The legacy floating "＋ Add a type" button is removed in favour of the palette.

**Tech Stack:** C# (.NET 10, `Koine.Compiler`), TypeScript + Preact + Zustand (`tooling/koine-studio`), Vitest + @testing-library/preact + vitest-axe, Storybook, SCSS, xUnit v3 + Shouldly + Roslyn meta-test.

## Global Constraints

- **Target-agnostic core:** no C# concept leaks into `Ast/`; the skeleton change lives in `Services/`.
- **Dual-backend parity:** the edit uses the existing `StructuredEdit.Type` field already on the wire — no new serialized field; the WASM host and desktop LSP share `ModelRoundTripService`, so parity holds automatically.
- **Back-compatible:** an `addType` edit with `Type == null` must still emit the value-object skeleton (the old behaviour).
- **No `TreatWarningsAsErrors`** is set — do not add it.
- **Commit identity:** `git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "…"`.
- **CI format gate:** `dotnet format --verify-no-changes` must pass; Studio code must pass `npx tsc --noEmit` / `npm test`.
- **Labels are English**, matching the current app shell.
- All `.koi` skeletons must **re-validate** — the round-trip rejects anything that doesn't, so a green test proves the construct compiles.

**Build/test commands:**
- C#: from repo root — `dotnet test --filter "FullyQualifiedName~ModelRoundTripTests"`
- Studio: from `tooling/koine-studio` — `npm test -- src/diagrams/CanvasPalette.test.tsx` (single file) or `npm test` (all)

---

### Task 1: Server — `addType` emits a skeleton per construct kind

**Files:**
- Modify: `src/Koine.Compiler/Services/ModelRoundTripService.Edit.cs` (`TryAddType`, ~line 404-440)
- Modify: `src/Koine.Compiler/Services/StructuredEdit.cs` (`AddType` XML doc, ~line 52-57)
- Test: `tests/Koine.Compiler.Tests/ModelRoundTripTests.cs`

**Interfaces:**
- Consumes: the existing `StructuredEdit(Kind, Target, Name, Type, Value)` record; `Type` carries the construct keyword (`"entity" | "value" | "aggregate" | "event" | "enum"`; `null` ⇒ value).
- Produces: `ModelRoundTripService.EmitKoine` / `ApplyEdit` insert the matching skeleton. No signature change.

- [ ] **Step 1: Write the failing tests**

Add these to `tests/Koine.Compiler.Tests/ModelRoundTripTests.cs` after the existing `EmitKoine_add_type_*` tests (~line 326):

```csharp
[Fact]
public void EmitKoine_add_entity_emits_an_identified_entity_skeleton()
{
    var edit = new StructuredEdit(StructuredEditKind.AddType, "Ordering", Name: "Customer", Type: "entity");
    EmitResult result = ModelRoundTripService.EmitKoine(Files(Sample), edit);

    result.Diagnostics.ShouldBeEmpty();
    result.Koine.ShouldNotBeNull();
    result.Koine!.ShouldContain("entity Customer identified by CustomerId");
}

[Fact]
public void EmitKoine_add_event_emits_an_event_skeleton()
{
    var edit = new StructuredEdit(StructuredEditKind.AddType, "Ordering", Name: "OrderShipped", Type: "event");
    EmitResult result = ModelRoundTripService.EmitKoine(Files(Sample), edit);

    result.Diagnostics.ShouldBeEmpty();
    result.Koine!.ShouldContain("event OrderShipped");
}

[Fact]
public void EmitKoine_add_enum_emits_an_enum_skeleton()
{
    var edit = new StructuredEdit(StructuredEditKind.AddType, "Ordering", Name: "Priority", Type: "enum");
    EmitResult result = ModelRoundTripService.EmitKoine(Files(Sample), edit);

    result.Diagnostics.ShouldBeEmpty();
    result.Koine!.ShouldContain("enum Priority");
}

[Fact]
public void EmitKoine_add_aggregate_emits_a_self_contained_aggregate_with_a_root_entity()
{
    var edit = new StructuredEdit(StructuredEditKind.AddType, "Ordering", Name: "Shipment", Type: "aggregate");
    EmitResult result = ModelRoundTripService.EmitKoine(Files(Sample), edit);

    result.Diagnostics.ShouldBeEmpty();
    result.Koine!.ShouldContain("aggregate Shipment root ShipmentRoot");
    result.Koine!.ShouldContain("entity ShipmentRoot identified by ShipmentRootId");
}

[Fact]
public void EmitKoine_add_type_with_null_kind_still_emits_a_value_skeleton()
{
    // Back-compat: the old bare "+" button sends no Type.
    var edit = new StructuredEdit(StructuredEditKind.AddType, "Ordering", Name: "Discount");
    EmitResult result = ModelRoundTripService.EmitKoine(Files(Sample), edit);

    result.Koine!.ShouldContain("value Discount");
}

[Fact]
public void ApplyEdit_add_entity_yields_a_compiling_model()
{
    var edit = new StructuredEdit(StructuredEditKind.AddType, "Ordering", Name: "Customer", Type: "entity");
    ModelEditResult result = ModelRoundTripService.ApplyEdit(Files(Sample), edit);

    result.Edits.Count.ShouldBe(1);
    result.Diagnostics.ShouldBeEmpty();
    var edited = Splice(Sample, result.Edits[0].Range, result.Edits[0].NewText);
    var (model, diags) = new KoineCompiler().Parse(new[] { new SourceFile("t.koi", edited) });
    diags.Where(d => d.Severity == DiagnosticSeverity.Error).ShouldBeEmpty();
    model.ShouldNotBeNull();
}

[Fact]
public void ApplyEdit_add_aggregate_yields_a_compiling_model()
{
    var edit = new StructuredEdit(StructuredEditKind.AddType, "Ordering", Name: "Shipment", Type: "aggregate");
    ModelEditResult result = ModelRoundTripService.ApplyEdit(Files(Sample), edit);

    result.Diagnostics.ShouldBeEmpty();
    var edited = Splice(Sample, result.Edits[0].Range, result.Edits[0].NewText);
    var (model, diags) = new KoineCompiler().Parse(new[] { new SourceFile("t.koi", edited) });
    diags.Where(d => d.Severity == DiagnosticSeverity.Error).ShouldBeEmpty();
    model.ShouldNotBeNull();
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet test --filter "FullyQualifiedName~ModelRoundTripTests"`
Expected: the new `add_entity`/`add_event`/`add_enum`/`add_aggregate` tests FAIL (they currently get a `value` skeleton, so `entity Customer…` etc. is absent); `add_type_with_null_kind` and the `Discount` value tests PASS.

- [ ] **Step 3: Switch the skeleton on the construct kind**

In `src/Koine.Compiler/Services/ModelRoundTripService.Edit.cs`, replace the single-skeleton line in `TryAddType` (currently:)

```csharp
        var nl = NewlineOf(source);
        var typeIndent = new string(' ', Math.Max(0, ctx.Span.Column - 1) + 2);
        // A value object with a single String field is the minimal valid type; the author refines it.
        var skeleton = $"value {edit.Name} {{{nl}{typeIndent}  name: String{nl}{typeIndent}}}";
```

with:

```csharp
        var nl = NewlineOf(source);
        var typeIndent = new string(' ', Math.Max(0, ctx.Span.Column - 1) + 2);
        var body = typeIndent + "  "; // members sit one level inside the type's braces
        // A minimal, re-validating skeleton per construct; null kind ⇒ value (the old bare "+" button).
        // The aggregate nests its own root entity so it is self-contained and always validates.
        var skeleton = edit.Type switch
        {
            "entity" => $"entity {edit.Name} identified by {edit.Name}Id {{{nl}{body}name: String{nl}{typeIndent}}}",
            "event" => $"event {edit.Name} {{{nl}{body}occurredAt: Instant{nl}{typeIndent}}}",
            "enum" => $"enum {edit.Name} {{{nl}{body}First{nl}{body}Second{nl}{typeIndent}}}",
            "aggregate" => $"aggregate {edit.Name} root {edit.Name}Root {{{nl}{body}entity {edit.Name}Root identified by {edit.Name}RootId {{{nl}{body}  name: String{nl}{body}}}{nl}{typeIndent}}}",
            _ => $"value {edit.Name} {{{nl}{body}name: String{nl}{typeIndent}}}",
        };
```

- [ ] **Step 4: Update the `AddType` XML doc**

In `src/Koine.Compiler/Services/StructuredEdit.cs`, replace the `AddType` summary (~line 52-56) with:

```csharp
    /// <summary>
    /// Add a new type to a context: <c>Target</c> = the context name, <c>Name</c> = the new type's name,
    /// <c>Type</c> = the construct kind (<c>value</c> | <c>entity</c> | <c>aggregate</c> | <c>event</c> |
    /// <c>enum</c>; <c>null</c> ⇒ <c>value</c>). Inserts a minimal, valid skeleton the author then refines
    /// (an aggregate nests its own root entity so it is self-contained); an illegal name (duplicate / not an
    /// identifier) is rejected by re-validation.
    /// </summary>
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `dotnet test --filter "FullyQualifiedName~ModelRoundTripTests"`
Expected: PASS (all, including the pre-existing duplicate-name rejection and unknown-context no-op).

- [ ] **Step 6: Commit**

```bash
git add src/Koine.Compiler/Services/ModelRoundTripService.Edit.cs src/Koine.Compiler/Services/StructuredEdit.cs tests/Koine.Compiler.Tests/ModelRoundTripTests.cs
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "feat(compiler): addType emits a skeleton per DDD construct kind"
```

---

### Task 2: `CanvasPalette` leaf panel (isolated) + styles + story

**Files:**
- Create: `tooling/koine-studio/src/diagrams/CanvasPalette.tsx`
- Create: `tooling/koine-studio/src/diagrams/CanvasPalette.test.tsx`
- Create: `tooling/koine-studio/src/diagrams/CanvasPalette.stories.tsx`
- Modify: `tooling/koine-studio/src/styles/components/_diagrams-maxgraph.scss` (append palette rules)

**Interfaces:**
- Consumes: `StoreApi<AppState>` (the `activeContext` slice), `isAllContexts` from `@/model/activeContext`, `AddNodeKind` from `@/diagrams/diagramContract`.
- Produces: `export function CanvasPalette(props: { store: StoreApi<AppState>; onAdd: (kind: AddNodeKind) => void })` — a `role="toolbar"` of construct buttons; enabled construct buttons call `props.onAdd(kind)`; disabled when the active scope is `ALL_CONTEXTS`; a static set of disabled "coming soon" buttons.

- [ ] **Step 1: Write the failing test**

Create `tooling/koine-studio/src/diagrams/CanvasPalette.test.tsx`:

```tsx
import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/preact';
import { createAppStore } from '@/store/index';
import { CanvasPalette } from '@/diagrams/CanvasPalette';
import { axe } from 'vitest-axe';

const btn = (c: Element, kind: string) => c.querySelector(`[data-kind="${kind}"]`) as HTMLButtonElement;

describe('CanvasPalette', () => {
  test('renders the five round-trip constructs plus the coming-soon buttons', () => {
    const { container } = render(<CanvasPalette store={createAppStore()} onAdd={() => {}} />);
    for (const kind of ['entity', 'value', 'aggregate', 'event', 'enum']) {
      expect(btn(container, kind)).not.toBeNull();
    }
    // Coming-soon buttons are present and disabled.
    const soon = container.querySelectorAll('.koi-palette-btn--soon');
    expect(soon.length).toBe(6);
    soon.forEach((b) => expect((b as HTMLButtonElement).disabled).toBe(true));
  });

  test('construct buttons are disabled under "All contexts" and enabled once a context is active', () => {
    const store = createAppStore();
    const { container } = render(<CanvasPalette store={store} onAdd={() => {}} />);
    expect(btn(container, 'entity').disabled).toBe(true);
    act(() => store.getState().setActiveContext('Ordering'));
    expect(btn(container, 'entity').disabled).toBe(false);
  });

  test('clicking an enabled construct calls onAdd with its kind', () => {
    const store = createAppStore();
    act(() => store.getState().setActiveContext('Ordering'));
    const onAdd = vi.fn();
    const { container } = render(<CanvasPalette store={store} onAdd={onAdd} />);
    fireEvent.click(btn(container, 'aggregate'));
    expect(onAdd).toHaveBeenCalledWith('aggregate');
  });

  test('has no accessibility violations', async () => {
    const store = createAppStore();
    act(() => store.getState().setActiveContext('Ordering'));
    const { container } = render(<CanvasPalette store={store} onAdd={() => {}} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `tooling/koine-studio`): `npm test -- src/diagrams/CanvasPalette.test.tsx`
Expected: FAIL — `Cannot find module '@/diagrams/CanvasPalette'`.

- [ ] **Step 3: Write the panel**

Create `tooling/koine-studio/src/diagrams/CanvasPalette.tsx`:

```tsx
import type { StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { AppState } from '@/store/index';
import { isAllContexts } from '@/model/activeContext';
import type { AddNodeKind } from '@/diagrams/diagramContract';

// The DDD constructs that round-trip to `.koi` via the addType seam (server Task 1). `data-kind` drives
// the swatch colour (the matching --koi-ddd-* token) in SCSS, so a button reads as the node it creates.
const CONSTRUCTS: { kind: AddNodeKind; label: string }[] = [
  { kind: 'entity', label: 'Entity' },
  { kind: 'value', label: 'Value Object' },
  { kind: 'aggregate', label: 'Aggregate' },
  { kind: 'event', label: 'Event' },
  { kind: 'enum', label: 'Enum' },
];

// Not yet wired to a model edit — shown disabled so the toolbar matches the agreed mockup and each can be
// enabled later without moving the others. Relation points the modeller at the existing connect gesture.
const COMING_SOON: { label: string; tooltip: string }[] = [
  { label: 'Service', tooltip: 'Coming soon' },
  { label: 'Rule', tooltip: 'Coming soon' },
  { label: 'Repository', tooltip: 'Coming soon' },
  { label: 'Relation', tooltip: 'Drag from one node to another to connect' },
  { label: 'Note', tooltip: 'Coming soon' },
  { label: 'Group', tooltip: 'Coming soon' },
];

// The construct palette above the domain canvas. Subscribes to the active-context slice so the
// round-trip buttons enable only when a single bounded context is the target (adding into "All
// contexts" has no unambiguous home). Controller-free: clicks call the injected onAdd callback.
export function CanvasPalette(props: { store: StoreApi<AppState>; onAdd: (kind: AddNodeKind) => void }) {
  const scope = useStore(props.store, (s) => s.activeContext);
  const enabled = !isAllContexts(scope);
  return (
    <div class="koi-canvas-palette" role="toolbar" aria-label="Add domain construct">
      {CONSTRUCTS.map((c) => (
        <button
          type="button"
          class="koi-palette-btn"
          data-kind={c.kind}
          key={c.kind}
          title={enabled ? `Add ${c.label}` : 'Select a bounded context first'}
          aria-label={`Add ${c.label}`}
          disabled={!enabled}
          onClick={() => props.onAdd(c.kind)}
        >
          <span class="koi-palette-swatch" aria-hidden="true" />
          <span class="koi-palette-label">{c.label}</span>
        </button>
      ))}
      <span class="koi-palette-sep" aria-hidden="true" />
      {COMING_SOON.map((c) => (
        <button
          type="button"
          class="koi-palette-btn koi-palette-btn--soon"
          key={c.label}
          title={c.tooltip}
          aria-label={`${c.label} (coming soon)`}
          disabled
        >
          <span class="koi-palette-swatch" aria-hidden="true" />
          <span class="koi-palette-label">{c.label}</span>
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/diagrams/CanvasPalette.test.tsx`
Expected: PASS (all four tests).

- [ ] **Step 5: Add the styles**

Append to `tooling/koine-studio/src/styles/components/_diagrams-maxgraph.scss`:

```scss
/* The construct palette above the domain canvas (CanvasPalette.tsx). A horizontal toolbar; each
   construct button carries a swatch coloured by its DDD token (matching the node it creates). */
.koi-canvas-palette {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  flex-wrap: wrap;
  padding: 0.375rem 0.5rem;
  border-bottom: 1px solid var(--koi-border, #2a2f3a);
  background: var(--koi-surface, #1b1f27);
}

.koi-palette-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.25rem 0.5rem;
  border: 1px solid transparent;
  border-radius: 0.375rem;
  background: transparent;
  color: var(--koi-text, #d7dce4);
  font-size: 0.8125rem;
  cursor: pointer;

  &:hover:not(:disabled) {
    background: var(--koi-surface-hover, rgba(255, 255, 255, 0.06));
    border-color: var(--koi-border, #2a2f3a);
  }

  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
}

.koi-palette-swatch {
  width: 0.625rem;
  height: 0.625rem;
  border-radius: 2px;
  background: var(--koi-ddd-repository); /* neutral default (coming-soon buttons) */
  flex: 0 0 auto;
}

/* Tie each construct button's swatch to its DDD concept colour. */
.koi-palette-btn[data-kind='entity'] .koi-palette-swatch { background: var(--koi-ddd-entity); }
.koi-palette-btn[data-kind='value'] .koi-palette-swatch { background: var(--koi-ddd-value); }
.koi-palette-btn[data-kind='aggregate'] .koi-palette-swatch { background: var(--koi-ddd-aggregate); }
.koi-palette-btn[data-kind='event'] .koi-palette-swatch { background: var(--koi-ddd-event); }
.koi-palette-btn[data-kind='enum'] .koi-palette-swatch { background: var(--koi-ddd-enum); }

.koi-palette-sep {
  width: 1px;
  align-self: stretch;
  margin: 0.125rem 0.25rem;
  background: var(--koi-border, #2a2f3a);
}
```

- [ ] **Step 6: Add the Storybook story**

Create `tooling/koine-studio/src/diagrams/CanvasPalette.stories.tsx`:

```tsx
import type { Meta, StoryObj } from '@storybook/preact-vite';
import { CanvasPalette } from '@/diagrams/CanvasPalette';
import { createAppStore } from '@/store/index';

// The construct palette. The round-trip buttons enable only when a single bounded context is active;
// each story seeds a fresh createAppStore() so the active-scope state doesn't bleed between stories.
const meta = {
  title: 'Panels/CanvasPalette',
  component: CanvasPalette,
  parameters: { layout: 'fullscreen' },
  args: { store: createAppStore(), onAdd: () => {} },
} satisfies Meta<typeof CanvasPalette>;

export default meta;
type Story = StoryObj<typeof meta>;

/** "All contexts" active: the construct buttons are disabled (no unambiguous target). */
export const NoContext: Story = {};

/** A single bounded context active: the construct buttons are enabled. */
export const ContextActive: Story = {
  render: (args) => {
    const store = createAppStore();
    store.getState().setActiveContext('Ordering');
    return <CanvasPalette {...args} store={store} />;
  },
};
```

- [ ] **Step 7: Run the full Studio test + lint**

Run: `npm test -- src/diagrams/CanvasPalette.test.tsx && npx tsc --noEmit`
Expected: PASS, no lint errors.

- [ ] **Step 8: Commit**

```bash
git add tooling/koine-studio/src/diagrams/CanvasPalette.tsx tooling/koine-studio/src/diagrams/CanvasPalette.test.tsx tooling/koine-studio/src/diagrams/CanvasPalette.stories.tsx tooling/koine-studio/src/styles/components/_diagrams-maxgraph.scss
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "feat(studio): CanvasPalette construct toolbar panel"
```

---

### Task 3: Integrate — inner canvas host, mount the palette, wire the add path

**Files:**
- Modify: `tooling/koine-studio/index.html` (~line 172, inside `#center-visual`)
- Modify: `tooling/koine-studio/src/styles/components/_center.scss` (~line 101, `#center-visual`)
- Modify: `tooling/koine-studio/src/shell/inspectorController.tsx` (render target + deps + mount)
- Modify: `tooling/koine-studio/src/shell/ide.tsx` (`applyDiagramAddType` + `onAddConstruct` dep)
- Modify (test DOM mirrors): `tooling/koine-studio/src/shell/ide.test.ts` (`APP_HTML` ~line 294) and `tooling/koine-studio/src/shell/inspectorController.test.ts` (`APP_HTML` ~line 54, `makeDeps` ~line 209)
- Test: `tooling/koine-studio/src/shell/inspectorController.test.ts` (the add-path test)

> **Why both test files change:** the controller reads `el('diagram-host')` at construction and `el('canvas-palette-host')` at mount; `el()` throws on a missing id. Both `ide.test.ts` and `inspectorController.test.ts` seed an `APP_HTML` mirror of index.html with an *empty* `#center-visual`, so both must gain the two inner hosts or every controller/ide test throws at boot.

**Interfaces:**
- Consumes: `CanvasPalette` (Task 2), `AddNodeKind`, the server `addType` `Type` field (Task 1).
- Produces: `InspectorControllerDeps.onAddConstruct(kind: AddNodeKind): void`; ide.tsx `applyDiagramAddType(detail?: { kind: AddNodeKind })`. The diagram renders into `#diagram-host`; the palette is mounted into `#canvas-palette-host`.

- [ ] **Step 1: Restructure the Visual tabpanel DOM**

In `tooling/koine-studio/index.html`, replace the self-closing Visual section (line 172):

```html
            <section id="center-visual" class="center-host" role="tabpanel" aria-label="Visual"></section>
```

with:

```html
            <section id="center-visual" class="center-host" role="tabpanel" aria-label="Visual">
              <div id="canvas-palette-host"></div>
              <div id="diagram-host"></div>
            </section>
```

- [ ] **Step 2: Lay out the palette above the canvas**

In `tooling/koine-studio/src/styles/components/_center.scss`, replace the `#center-visual` rule (~line 101):

```scss
#center-visual {
  overflow: hidden;
}
```

with:

```scss
#center-visual {
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* The canvas fills the space under the construct palette; position:relative anchors the maxGraph
   overlay controls (zoom / fit / auto-arrange), which are absolutely positioned within the host. */
#diagram-host {
  flex: 1 1 auto;
  min-height: 0;
  position: relative;
  overflow: hidden;
}
```

- [ ] **Step 3a: Update the test DOM mirrors so `el()` resolves the new hosts**

In **both** `tooling/koine-studio/src/shell/ide.test.ts` (APP_HTML ~line 294) and `tooling/koine-studio/src/shell/inspectorController.test.ts` (APP_HTML ~line 54), replace the empty Visual section:

```html
          <section id="center-visual" class="center-host" role="tabpanel"></section>
```

with (matching the Step 1 index.html change):

```html
          <section id="center-visual" class="center-host" role="tabpanel">
            <div id="canvas-palette-host"></div>
            <div id="diagram-host"></div>
          </section>
```

Then in `inspectorController.test.ts`, add `onAddConstruct` to the `makeDeps` defaults (after `onApplyStructuredEdit: vi.fn(),` ~line 229):

```typescript
    onAddConstruct: vi.fn(),
```

- [ ] **Step 3: Point the diagram render + messages at the inner host**

In `tooling/koine-studio/src/shell/inspectorController.tsx`, change the diagram render target from `#center-visual` to `#diagram-host`. At line 278:

```typescript
  const diagramsView = el('center-visual');
```

becomes:

```typescript
  const diagramsView = el('diagram-host');
```

(That single rename redirects the selection cross-highlight query at ~line 801, the `docMessage(diagramsView, …)` calls at ~916 and ~931, and `renderDiagrams(diagramsView, …)` at ~928 — all of which already read `diagramsView`. The separate `centerVisualEl = el('center-visual')` at ~line 961, used for `hidden` toggling, is unchanged and still toggles the whole Visual section.)

- [ ] **Step 4: Add the `onAddConstruct` dependency to the controller**

In `tooling/koine-studio/src/shell/inspectorController.tsx`, first add the `AddNodeKind` import next to the other `@/diagrams` imports (near line 43-49):

```typescript
import type { AddNodeKind } from '@/diagrams/diagramContract';
```

Then, in the `InspectorControllerDeps` interface, add after `onApplyStructuredEdit` (~line 154):

```typescript
  /** Insert a new DDD construct of the given kind into the active context (the palette's add path). */
  onAddConstruct(kind: AddNodeKind): void;
```

- [ ] **Step 5: Mount the palette once during controller setup**

In `tooling/koine-studio/src/shell/inspectorController.tsx`, add the import next to the other panel imports (near line 60-61):

```typescript
import { CanvasPalette } from '@/diagrams/CanvasPalette';
```

Then, just after the center-host refs are taken (after `const centerVisualEl = el('center-visual');` ~line 961), mount the palette once:

```typescript
  // The construct palette is store-driven (active-context gating) and model-independent, so it mounts
  // once here rather than per diagram reload. Clicks route through the injected onAddConstruct callback.
  render(<CanvasPalette store={appStore} onAdd={(kind) => deps.onAddConstruct(kind)} />, el('canvas-palette-host'));
```

- [ ] **Step 6: Extend `applyDiagramAddType` to honour the construct kind**

In `tooling/koine-studio/src/shell/ide.tsx`, add the `AddNodeKind` import next to the `@/diagrams/diagramContract` imports (near line 49) — keep any existing names on that import:

```typescript
import type { AddNodeKind } from '@/diagrams/diagramContract';
```

Replace `applyDiagramAddType` (lines ~707-718) with:

```typescript
  // Adding a node = inserting a new construct skeleton into the active context (addType). The canvas
  // doesn't know the contexts, so the target is the active scope; the kind comes from the palette button
  // (defaulting to value) and the user names the type.
  const ADD_DEFAULT_NAME: Record<AddNodeKind, string> = {
    value: 'NewValue',
    entity: 'NewEntity',
    aggregate: 'NewAggregate',
    event: 'NewEvent',
    enum: 'NewEnum',
  };

  async function applyDiagramAddType(detail?: { kind: AddNodeKind }): Promise<void> {
    const scope = activeContext.get();
    if (isAllContexts(scope)) {
      setStatus('Pick a bounded context (top-left) before adding a type', 'error');
      return;
    }
    const kind = detail?.kind ?? 'value';
    const name = window.prompt(`New ${kind} in ${scope}:`, ADD_DEFAULT_NAME[kind])?.trim();
    if (!name) return;
    // The AddNodeKind string IS the construct keyword the server's TryAddType switches on (StructuredEdit.Type).
    await applyStructuredEdit({ kind: 'addType', target: scope, name, type: kind }, `Added ${name} to ${scope}`);
  }
```

- [ ] **Step 7: Pass `onAddConstruct` into the controller**

In `tooling/koine-studio/src/shell/ide.tsx`, in the deps object passed to the controller, add next to `onApplyStructuredEdit` (~line 481):

```typescript
    onAddConstruct: (kind) => void applyDiagramAddType({ kind }),
```

- [ ] **Step 8: Write the controller-level wiring test**

The mounted palette routes a click to `deps.onAddConstruct(kind)`. Add to `tooling/koine-studio/src/shell/inspectorController.test.ts` (it already builds the controller via `createInspectorController(makeDeps(makeLsp(), over))` and renders the real DOM under happy-dom):

```typescript
describe('createInspectorController — construct palette', () => {
  test('clicking an enabled palette button calls onAddConstruct with its kind', () => {
    const onAddConstruct = vi.fn();
    const deps = makeDeps(makeLsp(), { onAddConstruct });
    // Set a single active context BEFORE mounting so the palette's first render is already enabled
    // (no async re-render to await — the initial useStore read sees 'Ordering').
    deps.store.getState().setActiveContext('Ordering');
    createInspectorController(deps);
    const btn = el('canvas-palette-host').querySelector<HTMLButtonElement>('[data-kind="entity"]')!;
    expect(btn.disabled).toBe(false);
    btn.click();
    expect(onAddConstruct).toHaveBeenCalledWith('entity');
  });

  test('palette construct buttons are disabled under "All contexts"', () => {
    const deps = makeDeps(makeLsp()); // createAppStore() defaults to ALL_CONTEXTS
    createInspectorController(deps);
    const btn = el('canvas-palette-host').querySelector<HTMLButtonElement>('[data-kind="entity"]')!;
    expect(btn.disabled).toBe(true);
  });
});
```

This, with Task 2's panel test (button → `onAdd('entity')`) and Task 1's server test (`type: 'entity'` → entity skeleton), covers the full client→server chain. The ide.tsx one-liner `onAddConstruct: (kind) => applyDiagramAddType({ kind })` → `applyStructuredEdit({ …, type: kind })` is exercised end-to-end by the optional manual smoke at the end of the plan.

- [ ] **Step 9: Run the test to verify it fails, then passes after the wiring**

Run: `npm test -- src/shell/inspectorController.test.ts`
Expected: PASS once Steps 3a-7 are in place (the test fails first — `el('canvas-palette-host')` is empty — until the palette is mounted).

- [ ] **Step 10: Run the full Studio suite + lint**

Run: `npm test && npx tsc --noEmit`
Expected: PASS. (Existing diagram render tests still pass — they render into a bare container, unaffected by the `#diagram-host` rename in the IDE shell.)

- [ ] **Step 11: Commit**

```bash
git add tooling/koine-studio/index.html tooling/koine-studio/src/styles/components/_center.scss tooling/koine-studio/src/shell/inspectorController.tsx tooling/koine-studio/src/shell/ide.tsx tooling/koine-studio/src/shell/ide.test.ts tooling/koine-studio/src/shell/inspectorController.test.ts
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "feat(studio): mount construct palette above the canvas and wire the add path"
```

---

### Task 4: Remove the redundant floating "＋ Add a type" button + event

**Files:**
- Modify: `tooling/koine-studio/src/diagrams/diagrams-maxgraph.ts` (drop the add-type button + import)
- Modify: `tooling/koine-studio/src/diagrams/diagrams-maxgraph.test.ts` (update button-count + drop the add-type assertions/test)
- Modify: `tooling/koine-studio/src/shell/ide.tsx` (drop the `DIAGRAM_ADD_TYPE_EVENT` listener + import)
- Modify: `tooling/koine-studio/src/diagrams/diagramContract.ts` (remove the now-unused event + detail)

**Interfaces:**
- Consumes: nothing new.
- Produces: the palette (Task 3) is the single add affordance; `DIAGRAM_ADD_TYPE_EVENT` and `DiagramAddNodeDetail` are removed; `AddNodeKind` stays (used by the palette + ide).

- [ ] **Step 1: Update the maxGraph renderer tests first (TDD: assert the new shape)**

In `tooling/koine-studio/src/diagrams/diagrams-maxgraph.test.ts`, in the editing-controls test (~line 442), change the button count from 5 to 4 and remove the "Add a type" assertion:

```typescript
    expect(container.querySelectorAll('.koi-canvas-btn')).toHaveLength(4);
    expect(container.querySelector('.koi-canvas--editing')).not.toBeNull();
    expect(container.querySelector('[aria-label="Auto-arrange layout"]')).not.toBeNull();
```

Then delete the entire `test('the Add-a-type button bubbles DIAGRAM_ADD_TYPE (bare, no detail)', …)` block (~lines 448-465), including its `addEventListener('koi-diagram-add-type', …)`.

- [ ] **Step 2: Run the tests to verify they now fail against the current renderer**

Run: `npm test -- src/diagrams/diagrams-maxgraph.test.ts`
Expected: FAIL — the renderer still emits 5 buttons including "Add a type", so the updated count/assertion fail.

- [ ] **Step 3: Remove the add-type button from the renderer**

In `tooling/koine-studio/src/diagrams/diagrams-maxgraph.ts`, in the `if (isDiagramEditing())` block (~line 674-686), delete the `button('＋', 'Add a type', …)` entry so only the auto-arrange button remains:

```typescript
  if (isDiagramEditing()) {
    host.classList.add('koi-canvas--editing');
    controls.append(
      button('⟲', 'Auto-arrange layout', () => {
        // Clear the saved positions, then ask ide.tsx to re-render — it lays out fresh from an empty store.
        activeLayoutStore().clear();
        host.dispatchEvent(new CustomEvent(DIAGRAM_RELAYOUT_EVENT, { bubbles: true }));
      }),
    );
  }
```

Then remove `DIAGRAM_ADD_TYPE_EVENT` from the import block at the top of the file (~line 17).

- [ ] **Step 4: Remove the dead listener + import in ide.tsx**

In `tooling/koine-studio/src/shell/ide.tsx`, delete the listener line (~line 616):

```typescript
  diagramsView.addEventListener(DIAGRAM_ADD_TYPE_EVENT, () => void applyDiagramAddType());
```

Then remove `DIAGRAM_ADD_TYPE_EVENT` from the `@/diagrams/diagramContract` import (~line 49). (`applyDiagramAddType` is still called via the `onAddConstruct` dep from Task 3, so it is not dead.)

- [ ] **Step 5: Remove the unused contract members**

In `tooling/koine-studio/src/diagrams/diagramContract.ts`, delete the `DIAGRAM_ADD_TYPE_EVENT` const (~line 94) and the `DiagramAddNodeDetail` interface (~line 104-108), and trim the now-stale doc comment above them. **Keep** `export type AddNodeKind = …` — it is used by `CanvasPalette` and ide.tsx. Update the comment on `AddNodeKind` to drop the event reference, e.g.:

```typescript
/** The DDD constructs the canvas palette can author. Mirrors the construct keyword the compiler's
 *  `addType` edit carries in `StructuredEdit.Type`. */
export type AddNodeKind = 'aggregate' | 'entity' | 'value' | 'enum' | 'event';
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- src/diagrams/diagrams-maxgraph.test.ts && npm test`
Expected: PASS — the renderer emits 4 buttons; no reference to `DIAGRAM_ADD_TYPE_EVENT` remains; the full suite is green.

- [ ] **Step 7: Typecheck + lint (catch any dangling reference)**

Run (from `tooling/koine-studio`): `npx tsc --noEmit`
Expected: no unused-import or undefined-symbol errors.

- [ ] **Step 8: Commit**

```bash
git add tooling/koine-studio/src/diagrams/diagrams-maxgraph.ts tooling/koine-studio/src/diagrams/diagrams-maxgraph.test.ts tooling/koine-studio/src/shell/ide.tsx tooling/koine-studio/src/diagrams/diagramContract.ts
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "refactor(studio): drop the legacy floating add-type button for the palette"
```

---

## Final verification

- [ ] From repo root: `dotnet test --filter "FullyQualifiedName~ModelRoundTripTests"` — green.
- [ ] From repo root: `dotnet format --verify-no-changes` — no diff (CI format gate).
- [ ] From `tooling/koine-studio`: `npm test && npx tsc --noEmit` — green.
- [ ] Manual smoke (optional, via run-studio-web): open the Visual tab, select a context, click **Entity** → name it → a green entity node appears and the `.koi` gains an `entity … identified by …Id` block; under "All contexts" the construct buttons are disabled.

## Self-review notes (coverage map)

- Spec "enabled round-trip buttons" → Task 2 (panel) + Task 1 (skeletons) + Task 3 (wiring).
- Spec "disabled coming-soon" → Task 2 `COMING_SOON`.
- Spec "Relation = existing gesture" → Task 2 (Relation disabled with the connect-gesture tooltip).
- Spec "context gating" → Task 2 (activeContext subscription) + the gating test.
- Spec "persistent panel above an inner canvas host" → Task 3 Steps 1-3.
- Spec "server Type-carried construct" + back-compat → Task 1.
- Spec "remove floating +" → Task 4.
- Spec "tests: per-kind round-trip, palette render/dispatch/gate/axe, story, ide integration" → Tasks 1, 2, 3.
