# Computed properties in the visual editor

**Date:** 2026-06-22
**Status:** Approved — ready for implementation plan

## Problem

Computed (derived) properties — fields written as `name: Type = expr` whose initializer
references a sibling member (e.g. `subtotal = unitPrice * quantity`) — are part of the
domain model and emit as get-only C# properties. But they are **invisible** in Koine
Studio's visual editor: neither the SVG class boxes on the Domain Canvas nor the inspector
panel's Properties list show them. A modeler reading the diagram sees an incomplete picture
of an aggregate/value object.

The omission is deliberate but blunt: `DocsEmitter.FieldRows` skips any member for which
`MemberAnalysis.IsDerived` is true, and that single helper (`ClassRows`) is the shared
source of truth for **both** the structured `DiagramGraph` the Studio editor consumes and
the living-docs Mermaid diagrams. So the filter removes computed members everywhere at once.

## Goal

Surface computed properties wherever non-computed fields appear, visually distinguished:

- **Studio visual editor** (SVG canvas rows + inspector Properties list): shown in
  **italic**, interleaved with regular fields in declaration order, **in** the Properties
  list (not a separate compartment).
- **Living-docs Mermaid diagrams**: shown using UML derived-attribute notation — a leading
  `/` on the name (e.g. `+Money /subtotal`).

Non-goals: a separate "Computed" inspector compartment; any editing of computed properties;
changes to `modelTables.ts` (it renders events/relations, not attribute members).

## Approach

Introduce **one** new member classification, `Computed`, at the shared chokepoint. Today
derived members are dropped in `FieldRows`; instead, tag them and let each emit path render
them distinctly. This preserves the "Mermaid and structured graph never drift" invariant —
they continue to walk the same `ClassRows` sequence.

`DiagramMember.kind` is a free-form string that flows verbatim through every wire layer
(`WDiagramMember` source-gen DTO, the LSP `MapMember` dictionary, and the `lsp.ts`
interface). So the new `"computed"` kind **requires no DTO or wire-schema change** — it
rides along the existing field, and the WASM↔LSP↔ts parity test stays green.

## Components & changes

### Compiler — `src/Koine.Compiler/Emit/Docs/`

1. **`DocsEmitter.Aggregates.cs` — `ClassRowKind` enum:** add `Computed` (a third attribute
   kind alongside `Field`/`Value`; rendered above the method divider).
2. **`DocsEmitter.Aggregates.cs` — `FieldRows`:** stop skipping `MemberAnalysis.IsDerived`
   members. Emit each member in declaration order: derived ⇒ `ClassRowKind.Computed`
   (carrying `Type: m.Type`), otherwise `ClassRowKind.Field`. Order is unchanged for the
   non-derived rows; computed rows now appear where declared.
3. **`DocsEmitter.Aggregates.cs` — `EmitClassRows` (Mermaid):** add a `Computed` case that
   renders `+{MermaidRowType} /{name}` — identical to the `Field` case but with a leading
   `/` on the name (UML derived-attribute notation).
4. **`DocsEmitter.Diagrams.cs` — `FormatMember` (structured graph):** add
   `ClassRowKind.Computed => new DiagramMember($"{row.Name}: {RowType(row)}", "computed")`.
   Text format is identical to a field (`name: Type`); only the `kind` differs so the
   frontend can style it. No `/` in the structured-graph text — the editor distinguishes by
   italic, not by prefix.

No change to the `DiagramMember` record, `WDiagramMember`, LSP `MapMember`, or `lsp.ts`.

### Studio frontend — `tooling/koine-studio/src/`

5. **`diagrams-svg.ts`:**
   - `partitionMembers` — treat `'computed'` as an attribute (so it joins `field`/`value`
     above the divider). Box sizing already derives from `partitionMembers`, so it adjusts
     automatically.
   - `appendRow` — accept the member's kind (or a boolean) and tag computed rows with a
     `koi-svg-class-row--computed` modifier class so CSS can italicize them.
6. **`styles/components/_diagrams.scss`:** add
   `.koi-svg-class-row--computed { font-style: italic; }`.
7. **`inspector.ts`:**
   - `InspectorElement.properties` changes from `string[]` to
     `{ text: string; computed: boolean }[]`.
   - `buildInspectorElement` — include both `'field'` and `'computed'` members in
     `properties`, in member order, each tagged with its `computed` flag.
   - The Properties list (`renderInspector` / `appendList`) renders computed items with an
     italic class; non-computed items are unchanged. `behaviors`/`values`/`invariants`
     lists are untouched.
8. **`styles/components/_model.scss`:** italic style for the computed inspector list item.

### Tests

9. **C# `tests/Koine.Compiler.Tests/DiagramGraphTests.cs`:** add (or extend a fixture with)
   a derived member such as `subtotal = unitPrice * quantity`. Assert it surfaces as a
   member with `kind == "computed"` and text `"subtotal: <Type>"`, and that it is **not**
   present among `kind == "field"` members.
10. **C# Mermaid coverage:** assert the derived member renders as `/subtotal` in the emitted
    Mermaid (in `DiagramGraphTests` or the relevant `RDocs`/docs test).
11. **TS `inspector.test.ts`:** a node with a computed member yields a Properties entry
    flagged computed and rendered italic.
12. **TS `diagrams-svg.test.ts`:** a computed member renders as an attribute row carrying the
    `koi-svg-class-row--computed` class.

### Snapshot churn (expected)

Because living-docs is in scope, every generated Mermaid diagram across `templates/`, the
`demo/Pizzeria.Domain` glossary, and website-bound docs that contains a derived field gains a
`/name` row. The corresponding Verify `.verified.txt` snapshots (and any committed
`glossary.md`) must be reviewed and re-accepted — the diff is the review of the generated
output. The WASM↔LSP↔ts parity test should remain green (no schema change).

## Risks & mitigations

- **Mermaid rendering of `/name`:** we snapshot the Markdown, not a rendered SVG, so the
  text is what matters; `/name` is valid attribute text. Standard Mermaid renders it
  literally as the attribute name.
- **`properties` type change ripples into `ide.ts`:** the inspector consumer must adapt to
  the richer item type. Contained to the inspector wiring; surfaced during implementation.
- **Default vs derived distinction:** unchanged — `MemberAnalysis.IsDerived` remains the
  single classifier. A constant default (`status = Draft`) stays a `Field`; only
  sibling-referencing initializers become `Computed`.
