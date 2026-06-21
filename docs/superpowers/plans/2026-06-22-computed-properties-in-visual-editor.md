# Computed Properties in the Visual Editor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make computed (derived) properties visible — in italic — in Koine Studio's visual editor (SVG canvas + inspector) and as UML `/name` derived rows in the living-docs Mermaid diagrams.

**Architecture:** Add one member classification, `Computed`, at the single shared chokepoint (`DocsEmitter.ClassRows`/`FieldRows`). Derived members are currently dropped there; instead tag them and let each emit path render them distinctly. The `DiagramMember.kind` string flows verbatim through every wire layer, so `"computed"` needs no DTO/schema change.

**Tech Stack:** C# / .NET 10 (`Koine.Compiler`), xUnit v3 + Shouldly + Verify (C# tests), TypeScript + Vitest + happy-dom (`tooling/koine-studio`), SCSS.

## Global Constraints

- Commit identity: `git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "..."`.
- `Ast/` stays target-agnostic — no C# concepts leak in. This work touches `Emit/Docs/` only on the compiler side.
- Verify snapshots are reviewed, not blindly overwritten — the diff IS the review of generated output.
- `dotnet format --verify-no-changes` must pass before the branch is ready (CI gate).
- CSS class naming follows the existing convention (`koi-svg-class-box`, `koi-svg-class-title`): a variant is a second space-separated class with a `-suffix`, not BEM `--`.

---

### Task 1: Compiler — classify derived members as `Computed` and emit them

**Files:**
- Modify: `src/Koine.Compiler/Emit/Docs/DocsEmitter.Aggregates.cs` (enum at 135-140; `EmitClassRows` at 95-121; `FieldRows` at 242-252; doc comments at 168-170, 241)
- Modify: `src/Koine.Compiler/Emit/Docs/DocsEmitter.Diagrams.cs` (`FormatMember` at 263-269)
- Test: `tests/Koine.Compiler.Tests/DiagramGraphTests.cs`

**Interfaces:**
- Consumes: `MemberAnalysis.IsDerived(Member, IEnumerable<string>)` (unchanged classifier).
- Produces: a new `ClassRowKind.Computed`; structured-graph members for derived fields now carry `kind == "computed"` with text `"{name}: {type}"`; Mermaid renders derived fields as `+{type} /{name}`.

- [ ] **Step 1: Write the failing test**

Add to `tests/Koine.Compiler.Tests/DiagramGraphTests.cs` (inside the `DiagramGraphTests` class, e.g. after the enum-values test ~line 230):

```csharp
[Fact]
public void Derived_member_surfaces_as_a_computed_member_distinct_from_fields()
{
    const string source = """
        context Sales {
          aggregate Cart root Cart {
            value Line {
              quantity: Int
              unitPrice: Int
              subtotal: Int = quantity * unitPrice
            }

            entity Cart identified by CartId {
              lines: List<Line>
            }
          }
        }
        """;
    var (model, diagnostics) = new KoineCompiler().Parse(new[] { new SourceFile("sales.koi", source) });
    diagnostics.ShouldBeEmpty();

    DiagramDescriptor aggregate = new DocsEmitter().EmitDiagrams(model!)["docs/Sales.md"]
        .First(d => d.Kind == "aggregate");

    DiagramNode line = aggregate.Graph.Nodes.First(n => n.Kind == "value-object" && n.Label == "Line");

    // The derived field is present, classified "computed", with source-like text — and it is
    // NOT also reported as a plain field.
    line.Members!.ShouldContain(m => m.Kind == "computed" && m.Text == "subtotal: Int");
    line.Members!.ShouldNotContain(m => m.Kind == "field" && m.Text.StartsWith("subtotal"));

    // Mermaid uses UML derived-attribute notation: a leading '/' on the name.
    aggregate.Mermaid.ShouldContain("/subtotal");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test --filter "FullyQualifiedName~DiagramGraphTests.Derived_member_surfaces_as_a_computed_member_distinct_from_fields"`
Expected: FAIL — the derived `subtotal` is currently filtered out, so neither the `computed` member nor `/subtotal` exists. (Compilation of the test itself fails first because `ClassRowKind.Computed` is not referenced anywhere yet — that's fine; it will pass once Steps 3-6 land. The assertion is the real gate.)

- [ ] **Step 3: Add the `Computed` enum value**

In `DocsEmitter.Aggregates.cs`, change the enum (135-140):

```csharp
    internal enum ClassRowKind
    {
        Field,
        Computed,
        Method,
        Value
    }
```

Update its doc comment (130-134) so it reads: "…an attribute (`field`/`computed`, incl. the synthetic version/id rows), an operation (`method`…), or an enum value (`value`)…".

- [ ] **Step 4: Stop dropping derived members in `FieldRows`**

Replace `FieldRows` (242-252) with:

```csharp
    /// <summary>The field rows of a member list, in declaration order: a derived/computed member
    /// (its initializer references a sibling) becomes a <see cref="ClassRowKind.Computed"/> row,
    /// every other member a <see cref="ClassRowKind.Field"/> row.</summary>
    private static IEnumerable<ClassRow> FieldRows(IReadOnlyList<Member> members)
    {
        var names = new HashSet<string>(members.Select(m => m.Name), StringComparer.Ordinal);
        foreach (Member m in members)
        {
            ClassRowKind kind = MemberAnalysis.IsDerived(m, names)
                ? ClassRowKind.Computed
                : ClassRowKind.Field;
            yield return new ClassRow(m.Name, kind, Type: m.Type);
        }
    }
```

Also update the `ClassRows` doc comment (168-170): change "Derived members are skipped via the same `MemberAnalysis.IsDerived` rule." to "Derived members are surfaced as `Computed` rows (same `MemberAnalysis.IsDerived` rule), not skipped."

- [ ] **Step 5: Render the `Computed` row in both emit paths**

In `DocsEmitter.Aggregates.cs` `EmitClassRows`, add a case after the `Field` case (after line 103):

```csharp
                case ClassRowKind.Computed:
                    sb.Append("        +").Append(MermaidRowType(row)).Append(" /").Append(row.Name).Append('\n');
                    break;
```

In `DocsEmitter.Diagrams.cs` `FormatMember` (263-269), add a `Computed` arm:

```csharp
    private static DiagramMember FormatMember(ClassRow row) => row.Kind switch
    {
        ClassRowKind.Field => new DiagramMember($"{row.Name}: {RowType(row)}", "field"),
        ClassRowKind.Computed => new DiagramMember($"{row.Name}: {RowType(row)}", "computed"),
        ClassRowKind.Method => new DiagramMember(FormatMethod(row), "method"),
        ClassRowKind.Value => new DiagramMember(row.Name, "value"),
        _ => new DiagramMember(row.Name, "field")
    };
```

- [ ] **Step 6: Run the new test to verify it passes**

Run: `dotnet test --filter "FullyQualifiedName~DiagramGraphTests.Derived_member_surfaces_as_a_computed_member_distinct_from_fields"`
Expected: PASS

- [ ] **Step 7: Run the DiagramGraph suite (catches the local snapshot)**

Run: `dotnet test --filter "FullyQualifiedName~DiagramGraphTests"`
Expected: PASS. The big `Diagram_graphs_snapshot` fixture has no derived member, so its `.verified.txt` is unchanged. (Cross-template/doc snapshots are handled in Task 4.)

- [ ] **Step 8: Commit**

```bash
git add src/Koine.Compiler/Emit/Docs/DocsEmitter.Aggregates.cs src/Koine.Compiler/Emit/Docs/DocsEmitter.Diagrams.cs tests/Koine.Compiler.Tests/DiagramGraphTests.cs
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "feat(docs): surface derived members as computed rows (/name in Mermaid, kind=computed in graph)"
```

---

### Task 2: Studio canvas — render computed rows in italic

**Files:**
- Modify: `tooling/koine-studio/src/diagrams-svg.ts` (`partitionMembers` at 134-139; `appendRow` at 348-356; its two call sites at 319 and 331)
- Modify: `tooling/koine-studio/src/styles/components/_diagrams.scss` (after the `.koi-svg-class-row` block, ~232)
- Test: `tooling/koine-studio/src/diagrams-svg.test.ts`

**Interfaces:**
- Consumes: `DiagramMember { text: string; kind: string }` from `lsp.ts`; the `"computed"` kind from Task 1.
- Produces: computed members partitioned as attributes; each computed row carries the `koi-svg-class-row-computed` class.

- [ ] **Step 1: Write the failing test**

Add to `tooling/koine-studio/src/diagrams-svg.test.ts` (near the compartmented-class-box test ~line 461):

```ts
test('renders a computed member as an italic attribute row', () => {
  const container = document.createElement('div');
  renderDiagram(
    container,
    diagram({
      nodes: [
        mkNode({
          id: 'line',
          label: 'Line',
          kind: 'value-object',
          qualifiedName: 'Sales.Line',
          stereotype: 'value object',
          members: [
            { text: 'quantity: Int', kind: 'field' },
            { text: 'subtotal: Int', kind: 'computed' },
          ],
        }),
      ],
      edges: [],
    }),
  );

  const node = container.querySelector('.koi-svg-node')!;
  // Computed members live in the attribute compartment (above the divider), so a value object
  // with only fields + computed members has NO method divider — exactly one divider.
  expect(node.querySelectorAll('.koi-svg-class-divider').length).toBe(1);

  const computed = node.querySelector('.koi-svg-class-row-computed');
  expect(computed).not.toBeNull();
  expect(computed!.textContent).toBe('subtotal: Int');
});
```

(Use the same `renderDiagram` / `mkNode` / `diagram` helpers the surrounding tests use — check the top of the file for their exact names and mirror an existing class-box test's call shape.)

- [ ] **Step 2: Run test to verify it fails**

Run (from `tooling/koine-studio`): `npx vitest run src/diagrams-svg.test.ts -t "computed member"`
Expected: FAIL — `.koi-svg-class-row-computed` is null (computed is currently filtered out of attributes and rows carry no variant class).

- [ ] **Step 3: Include `computed` in the attribute compartment**

In `diagrams-svg.ts`, change `partitionMembers` (135-138):

```ts
function partitionMembers(members: DiagramMember[]): { attributes: DiagramMember[]; methods: DiagramMember[] } {
  const attributes = members.filter((m) => m.kind === 'field' || m.kind === 'value' || m.kind === 'computed');
  const methods = members.filter((m) => m.kind === 'method');
  return { attributes, methods };
}
```

- [ ] **Step 4: Tag computed rows in `appendRow`**

Replace `appendRow` (348-356) so it takes the member and applies the variant class:

```ts
/** One left-aligned member row inside a compartment; computed members render italic. */
function appendRow(g: SVGGElement, member: DiagramMember, y: number, _w: number): void {
  const row = svgEl('text');
  row.setAttribute(
    'class',
    member.kind === 'computed' ? 'koi-svg-class-row koi-svg-class-row-computed' : 'koi-svg-class-row',
  );
  row.setAttribute('x', String(CLASS_PADDING_X));
  row.setAttribute('y', String(y));
  row.textContent = member.text;
  g.appendChild(row);
}
```

Update its two call sites in `drawClassBox`:
- Line 319: `appendRow(g, m, y, w);` (in the `for (const m of attributes)` loop)
- Line 331: `appendRow(g, m, y, w);` (in the `for (const m of methods)` loop)

- [ ] **Step 5: Add the italic style**

In `tooling/koine-studio/src/styles/components/_diagrams.scss`, after the `.koi-svg-class-row { … }` block (ends ~line 232) add:

```scss
.koi-svg-class-row-computed {
  font-style: italic;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run (from `tooling/koine-studio`): `npx vitest run src/diagrams-svg.test.ts`
Expected: PASS (the new test and all existing diagram tests).

- [ ] **Step 7: Commit**

```bash
git add tooling/koine-studio/src/diagrams-svg.ts tooling/koine-studio/src/diagrams-svg.test.ts tooling/koine-studio/src/styles/components/_diagrams.scss
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "feat(studio): render computed properties italic on the visual canvas"
```

---

### Task 3: Studio inspector — list computed properties in italic

**Files:**
- Modify: `tooling/koine-studio/src/inspector.ts` (`InspectorElement.properties` at 28-29; `buildInspectorElement` at 59-74; `renderInspector` at 94; add `appendProperties`)
- Modify: `tooling/koine-studio/src/styles/components/_model.scss` (after `.koi-inspector-item`, ~336)
- Test: `tooling/koine-studio/src/inspector.test.ts`

**Interfaces:**
- Consumes: `DiagramMember` with `"field"` and `"computed"` kinds.
- Produces: `InspectorElement.properties: { text: string; computed: boolean }[]`; the Properties list renders computed items with the `koi-inspector-item-computed` class.

- [ ] **Step 1: Update existing tests + add the failing computed test**

In `tooling/koine-studio/src/inspector.test.ts`:

Change the `fullElement` fixture (line 24) from:
```ts
  properties: ['id: OrderId', 'total: Money'],
```
to:
```ts
  properties: [
    { text: 'id: OrderId', computed: false },
    { text: 'total: Money', computed: false },
  ],
```

Change the `buildInspectorElement` assertion (line 158) from:
```ts
    expect(built.properties).toEqual(['id: OrderId', 'total: Money']);
```
to:
```ts
    expect(built.properties).toEqual([
      { text: 'id: OrderId', computed: false },
      { text: 'total: Money', computed: false },
    ]);
```

(Line 166 `expect(built.properties).toEqual([])` stays as-is.)

Add a new test in the `buildInspectorElement` describe block:
```ts
test('includes computed members in properties, flagged and rendered italic', () => {
  const computedNode: DiagramNode = {
    ...node,
    members: [
      { text: 'quantity: Int', kind: 'field' },
      { text: 'subtotal: Int', kind: 'computed' },
    ],
  };
  const built = buildInspectorElement(entry, computedNode);
  expect(built.properties).toEqual([
    { text: 'quantity: Int', computed: false },
    { text: 'subtotal: Int', computed: true },
  ]);

  const el = renderInspector(built, { onGoto: () => {} });
  const computedItem = el.querySelector('.koi-inspector-item-computed');
  expect(computedItem).not.toBeNull();
  expect(computedItem!.textContent).toBe('subtotal: Int');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `tooling/koine-studio`): `npx vitest run src/inspector.test.ts`
Expected: FAIL — `built.properties` is still `string[]`, and `.koi-inspector-item-computed` does not exist.

- [ ] **Step 3: Change the `properties` type**

In `inspector.ts`, change the interface field (28-29):

```ts
  /** Attribute rows (`name: Type`); `computed` marks a derived, get-only property. */
  properties: { text: string; computed: boolean }[];
```

- [ ] **Step 4: Populate computed in `buildInspectorElement`**

Change the `properties` line (69) to:

```ts
    properties: members
      .filter((m) => m.kind === 'field' || m.kind === 'computed')
      .map((m) => ({ text: m.text, computed: m.kind === 'computed' })),
```

- [ ] **Step 5: Render the Properties list with italic computed items**

In `renderInspector`, replace the Properties line (94):
```ts
  appendList(root, 'Properties', element.properties);
```
with:
```ts
  appendProperties(root, element.properties);
```

Add this function next to `appendList` (after line 226):

```ts
/** Append the Properties compartment; computed (derived) properties render italic. A no-op when empty. */
function appendProperties(root: HTMLElement, items: { text: string; computed: boolean }[]): void {
  if (!items.length) return;
  const section = document.createElement('section');
  section.className = 'koi-inspector-section';

  const h = document.createElement('h5');
  h.className = 'koi-inspector-section-title';
  h.textContent = 'Properties';
  section.appendChild(h);

  const ul = document.createElement('ul');
  ul.className = 'koi-inspector-list';
  for (const item of items) {
    const li = document.createElement('li');
    li.className = item.computed ? 'koi-inspector-item koi-inspector-item-computed' : 'koi-inspector-item';
    li.textContent = item.text;
    ul.appendChild(li);
  }
  section.appendChild(ul);
  root.appendChild(section);
}
```

- [ ] **Step 6: Add the italic style**

In `tooling/koine-studio/src/styles/components/_model.scss`, after the `.koi-inspector-item { … }` block (ends ~line 336) add:

```scss
.koi-inspector-item-computed {
  font-style: italic;
}
```

- [ ] **Step 7: Run test to verify it passes**

Run (from `tooling/koine-studio`): `npx vitest run src/inspector.test.ts`
Expected: PASS

- [ ] **Step 8: Run the full Studio test + typecheck**

Run (from `tooling/koine-studio`): `npx vitest run && npx tsc --noEmit`
Expected: PASS — confirms the `properties` type change broke no other consumer (`ide.ts` only builds/renders, never reads `.properties`).

- [ ] **Step 9: Commit**

```bash
git add tooling/koine-studio/src/inspector.ts tooling/koine-studio/src/inspector.test.ts tooling/koine-studio/src/styles/components/_model.scss
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "feat(studio): list computed properties italic in the inspector"
```

---

### Task 4: Accept living-docs snapshot churn and verify end-to-end

**Files:**
- Modify (accept): `tests/Koine.Compiler.Tests/**/Snapshots/*.verified.txt` and `tests/Koine.Compiler.Tests/Conformance/Snapshots/*.verified.txt` that now contain a `/name` derived row.
- Modify (regenerate): `demo/Pizzeria.Domain/glossary.md` if the demo build rewrites it with derived rows.

**Interfaces:**
- Consumes: the Task 1 compiler change (derived members now emit `/name` in Mermaid).
- Produces: a green `dotnet test` across the whole suite with reviewed snapshots.

- [ ] **Step 1: Run the full C# suite to surface snapshot diffs**

Run: `dotnet test`
Expected: FAILURES limited to Verify snapshot tests whose fixtures/templates contain a derived field (e.g. RDocs tests, `TemplatesValidationTests`-adjacent docs snapshots). Each failure writes a `.received.txt`.

- [ ] **Step 2: Review every received diff**

Run: `find tests -name "*.received.txt"`
For each, diff it against its `.verified.txt` and confirm the ONLY change is the appearance of `+<type> /<name>` derived rows (and member-count/ordering shifts from those rows). Reject anything else — an unexpected diff means a real regression, not churn.

```bash
for f in $(find tests -name "*.received.txt"); do echo "=== $f ==="; diff "${f%.received.txt}.verified.txt" "$f"; done
```

- [ ] **Step 3: Accept the reviewed snapshots**

For each reviewed `.received.txt`, replace its `.verified.txt`:

```bash
for f in $(find tests -name "*.received.txt"); do mv "$f" "${f%.received.txt}.verified.txt"; done
```

- [ ] **Step 4: Rebuild the demo (regenerates the glossary/diagrams end-to-end)**

Run: `dotnet build demo/Pizzeria.Domain`
Expected: BUILD SUCCEEDED. If `git status` shows `demo/Pizzeria.Domain/glossary.md` changed, review the diff (same `/name` rule) and keep it.

- [ ] **Step 5: Run the full suite again to confirm green**

Run: `dotnet test`
Expected: PASS (all snapshots now match).

- [ ] **Step 6: Run the format gate**

Run: `dotnet format --verify-no-changes`
Expected: no changes. If it reports changes, run `dotnet format` and include them.

- [ ] **Step 7: Commit**

```bash
git add -A
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "test: accept living-docs snapshots showing computed (/name) properties"
```

---

## Self-Review

**Spec coverage:**
- Compiler: new `Computed` kind, `FieldRows` no longer drops derived, Mermaid `/name`, graph `"computed"` → Task 1. ✓
- No DTO/wire change → confirmed in Task 1 interfaces (kind string flows verbatim); Task 3 Step 8 typecheck guards it. ✓
- Studio canvas italic → Task 2. ✓
- Studio inspector italic, in Properties list (not separate section), declaration order → Task 3 (single ordered `properties` list, `field`+`computed` filtered in member order). ✓
- Mermaid living-docs snapshot churn reviewed/accepted → Task 4. ✓
- WASM↔LSP↔ts parity stays green → no schema change; covered by full `dotnet test` in Task 4. ✓

**Placeholder scan:** none — every code/edit step shows concrete content. The one soft spot (helper names in Task 2 test) is flagged with explicit instruction to mirror existing tests.

**Type consistency:** `properties: { text: string; computed: boolean }[]` defined in Task 3 Step 3 and used consistently in Steps 1/4/5 and the inspector test. `appendRow(g, member, y, _w)` signature in Task 2 Step 4 matches both updated call sites. `koi-svg-class-row-computed` (Task 2) and `koi-inspector-item-computed` (Task 3) class names are used consistently in their test, code, and SCSS.
