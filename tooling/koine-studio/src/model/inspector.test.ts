import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  buildInspectorElement,
  renameStatusMessage,
  renderInspector,
  renderChangeHistory,
  type InspectorElement,
  type InspectorHandlers,
} from '@/model/inspector';
import type { ChangeEntry } from '@/host/gitHistory';
import type { DiagramNode, GlossaryEntry, ModelMember, Range } from '@/lsp/lsp';
import type { TextEdit, WorkspaceEdit } from '@/lsp/protocol';

afterEach(() => {
  document.body.innerHTML = '';
});

const range: Range = { start: { line: 4, character: 2 }, end: { line: 4, character: 9 } };

const fullElement: InspectorElement = {
  id: 'Sales.Order',
  name: 'Order',
  qualifiedName: 'Sales.Order',
  context: 'Sales',
  kind: 'aggregate',
  stereotype: 'aggregate root',
  description: 'A customer order.',
  properties: [
    { text: 'id: OrderId', computed: false },
    { text: 'total: Money', computed: false },
  ],
  behaviors: ['submit(): void', 'cancel(): void'],
  values: [],
  invariants: ['total >= 0'],
  publishedEvents: ['OrderPlaced'],
  repository: 'OrderRepository',
  nameRange: range,
};

const noop: InspectorHandlers = { onGoto: () => {} };

// Characterization safety net (issue #1162): pins constructKey's end-to-end DOM behaviour — including
// its palette-or-'type' fallback — via the rendered root's dataset.kind. Exercises paths dddKind.test.ts's
// cross-check doesn't cover (e.g. `service`/an unknown kind falling back to `type`).
describe('renderInspector dataset.kind (constructKey) — characterization (issue #1162)', () => {
  test.each([
    ['aggregate', 'aggregate'],
    ['quantity', 'value'],
    ['integration event', 'integration-event'],
    ['service', 'type'],
    ['unknown-kind', 'type'],
  ])('renderInspector(kind: %s).dataset.kind === %s', (kind, expected) => {
    const el = renderInspector({ ...fullElement, kind }, noop);
    expect(el.dataset.kind).toBe(expected);
  });
});

describe('renderInspector', () => {
  test('renders an empty state when nothing is selected', () => {
    const el = renderInspector(null, noop);
    // The padded .koi-inspector root wraps the shared rail empty state (renderRailEmpty — the same
    // builder the Rules/Notes tabs use), so the three tabs share one margin and one markup.
    expect(el.classList.contains('koi-inspector')).toBe(true);
    expect(el.querySelector('.koi-rview-empty')).not.toBeNull();
    expect(el.querySelector('.koi-rview-empty-title')!.textContent).toBe('Properties');
    expect(el.textContent).toMatch(/select an element/i);
  });

  test('renders the header with name and stereotype badge', () => {
    const el = renderInspector(fullElement, noop);
    expect(el.querySelector('.koi-inspector-name')!.textContent).toBe('Order');
    expect(el.querySelector('.koi-inspector-stereotype')!.textContent).toBe('aggregate root');
  });

  test('falls back to the kind when there is no stereotype', () => {
    const el = renderInspector({ ...fullElement, stereotype: null }, noop);
    expect(el.querySelector('.koi-inspector-stereotype')!.textContent).toBe('aggregate');
  });

  test('renders the description in an editable textarea', () => {
    const el = renderInspector(fullElement, noop);
    const desc = el.querySelector<HTMLTextAreaElement>('.koi-inspector-desc')!;
    expect(desc.tagName).toBe('TEXTAREA');
    expect(desc.value).toBe('A customer order.');
  });

  test('renders an editable Name field seeded with the element name', () => {
    const el = renderInspector(fullElement, noop);
    const name = el.querySelector<HTMLInputElement>('.koi-inspector-input')!;
    expect(name.value).toBe('Order');
  });

  test('committing a changed name calls onRename; an unchanged/blank name does not', () => {
    const onRename = vi.fn();
    const el = renderInspector(fullElement, { onGoto: () => {}, onRename });
    document.body.appendChild(el);
    const name = el.querySelector<HTMLInputElement>('.koi-inspector-input')!;
    name.value = 'PurchaseOrder';
    name.dispatchEvent(new Event('blur'));
    expect(onRename).toHaveBeenCalledWith(fullElement, 'PurchaseOrder');

    onRename.mockClear();
    name.value = 'Order'; // back to the original
    name.dispatchEvent(new Event('blur'));
    expect(onRename).not.toHaveBeenCalled();
  });

  test('editing the description calls onSaveDescription on blur', () => {
    const onSaveDescription = vi.fn();
    const el = renderInspector(fullElement, { onGoto: () => {}, onSaveDescription });
    document.body.appendChild(el);
    const desc = el.querySelector<HTMLTextAreaElement>('.koi-inspector-desc')!;
    desc.value = 'An order placed by a customer.';
    desc.dispatchEvent(new Event('blur'));
    expect(onSaveDescription).toHaveBeenCalledWith(fullElement, 'An order placed by a customer.');
  });

  test('lists every property, behavior, invariant, published event, and the repository', () => {
    const el = renderInspector(fullElement, noop);
    const text = el.textContent ?? '';
    for (const s of ['submit(): void', 'cancel(): void', 'total >= 0', 'OrderPlaced', 'OrderRepository']) {
      expect(text).toContain(s);
    }
    // Properties render as a two-column table (name | type), not colon-joined list rows.
    const rows = Array.from(el.querySelectorAll('.koi-inspector-table tr')).map((tr) =>
      Array.from(tr.querySelectorAll('th, td')).map((c) => c.textContent),
    );
    expect(rows).toEqual([
      ['id', 'OrderId'],
      ['total', 'Money'],
    ]);
    // Section headers are present for the populated compartments.
    const headers = Array.from(el.querySelectorAll('.koi-inspector-section-title')).map((n) => n.textContent);
    expect(headers).toEqual(
      expect.arrayContaining(['Properties', 'Behaviors', 'Invariants', 'Published Events', 'Repository']),
    );
  });

  test('renders properties as row-scoped table headers and keeps a colon-less name in the name column', () => {
    const el = renderInspector(
      {
        ...fullElement,
        properties: [
          { text: 'id: OrderId', computed: false },
          { text: 'archived', computed: false },
        ],
      },
      noop,
    );
    const rows = Array.from(el.querySelectorAll<HTMLTableRowElement>('.koi-inspector-table tr'));
    expect(rows.map((tr) => tr.querySelector('th')?.textContent)).toEqual(['id', 'archived']);
    expect(rows.map((tr) => tr.querySelector('th')?.getAttribute('scope'))).toEqual(['row', 'row']);
    expect(rows.map((tr) => tr.querySelector('td')?.textContent)).toEqual(['OrderId', '']);
  });

  test('omits empty compartments', () => {
    const lean: InspectorElement = {
      ...fullElement,
      behaviors: [],
      invariants: [],
      publishedEvents: [],
      repository: null,
    };
    const el = renderInspector(lean, noop);
    const headers = Array.from(el.querySelectorAll('.koi-inspector-section-title')).map((n) => n.textContent);
    expect(headers).toContain('Properties');
    expect(headers).not.toContain('Behaviors');
    expect(headers).not.toContain('Invariants');
    expect(headers).not.toContain('Repository');
  });

  test('clicking the name jumps to its declaration range', () => {
    const onGoto = vi.fn();
    const el = renderInspector(fullElement, { onGoto });
    document.body.appendChild(el);
    el.querySelector<HTMLButtonElement>('.koi-inspector-name')!.click();
    expect(onGoto).toHaveBeenCalledWith(range);
  });
});

describe('buildInspectorElement', () => {
  const entry: GlossaryEntry = {
    id: 'Sales.Order',
    name: 'Order',
    kind: 'aggregate',
    context: 'Sales',
    qualifiedName: 'Sales.Order',
    doc: 'A customer order.',
    nameRange: range,
  };

  const node: DiagramNode = {
    id: 'Order',
    label: 'Order',
    kind: 'aggregate-root',
    qualifiedName: 'Sales.Order',
    sourceSpan: null,
    stereotype: 'aggregate root',
    members: [
      { text: 'id: OrderId', kind: 'field' },
      { text: 'total: Money', kind: 'field' },
      { text: 'submit(): void', kind: 'method' },
    ],
  };

  test('partitions a diagram node’s members into properties and behaviors and carries the stereotype', () => {
    const built = buildInspectorElement(entry, node);
    expect(built.stereotype).toBe('aggregate root');
    expect(built.description).toBe('A customer order.');
    expect(built.properties).toEqual([
      { text: 'id: OrderId', computed: false },
      { text: 'total: Money', computed: false },
    ]);
    expect(built.behaviors).toEqual(['submit(): void']);
  });

  test('works with no diagram node (glossary-only element)', () => {
    const built = buildInspectorElement(entry, undefined);
    expect(built.name).toBe('Order');
    expect(built.stereotype).toBeNull();
    expect(built.properties).toEqual([]);
    expect(built.behaviors).toEqual([]);
    expect(built.invariants).toBeUndefined();
  });

  test('carries the diagram node’s invariants as business rules (undefined when none)', () => {
    const withRules = buildInspectorElement(entry, { ...node, invariants: ['total >= 0', 'lines not empty'] });
    expect(withRules.invariants).toEqual(['total >= 0', 'lines not empty']);
    // An empty invariants array collapses to undefined (so the Properties Invariants compartment hides).
    expect(buildInspectorElement(entry, { ...node, invariants: [] }).invariants).toBeUndefined();
  });

  test('falls back to the structured-model fields for a value object with no diagram node', () => {
    // A value object that isn't drawn as a class node anywhere has no DiagramNode, so its fields live
    // only in the structured model (#91). The inspector must still show them. A model field with an
    // initializer (`value`) is a derived/computed member.
    const moneyEntry: GlossaryEntry = { ...entry, name: 'Money', kind: 'value', qualifiedName: 'Sales.Money', doc: null };
    const modelMembers: ModelMember[] = [
      { kind: 'field', name: 'amount', type: 'Decimal', value: null },
      { kind: 'field', name: 'currency', type: 'Currency', value: null },
      { kind: 'field', name: 'display', type: 'String', value: 'amount + currency' },
    ];
    const built = buildInspectorElement(moneyEntry, undefined, modelMembers);
    expect(built.properties).toEqual([
      { text: 'amount: Decimal', computed: false },
      { text: 'currency: Currency', computed: false },
      { text: 'display: String', computed: true },
    ]);
  });

  test('prefers the diagram node members over the structured model when both are present', () => {
    const modelMembers: ModelMember[] = [{ kind: 'field', name: 'ignored', type: 'X', value: null }];
    const built = buildInspectorElement(entry, node, modelMembers);
    expect(built.properties).toEqual([
      { text: 'id: OrderId', computed: false },
      { text: 'total: Money', computed: false },
    ]);
  });

  test('collects enum values into the values compartment', () => {
    const enumEntry: GlossaryEntry = { ...entry, name: 'Status', kind: 'enum', qualifiedName: 'Sales.Status' };
    const enumNode: DiagramNode = {
      ...node,
      qualifiedName: 'Sales.Status',
      kind: 'enum',
      stereotype: null,
      members: [
        { text: 'Draft', kind: 'value' },
        { text: 'Placed', kind: 'value' },
      ],
    };
    const built = buildInspectorElement(enumEntry, enumNode);
    expect(built.values).toEqual(['Draft', 'Placed']);
  });

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
    const rows = Array.from(el.querySelectorAll<HTMLTableRowElement>('.koi-inspector-table tr'));
    const computedRows = rows.filter((tr) => tr.classList.contains('koi-inspector-row-computed'));
    expect(computedRows.map((tr) => tr.querySelector('th')?.textContent)).toEqual(['subtotal']);
    expect(computedRows[0].querySelector('td')?.textContent).toBe('Int');
    // The plain field row is NOT marked computed.
    const fieldRow = rows.find((tr) => tr.querySelector('th')?.textContent === 'quantity');
    expect(fieldRow?.classList.contains('koi-inspector-row-computed')).toBe(false);
  });
});

describe('property editing (authoring)', () => {
  const editableElement: InspectorElement = {
    ...fullElement,
    properties: [
      { text: 'id: OrderId', computed: false },
      { text: 'total: Money', computed: false },
      { text: 'subtotal: Int', computed: true },
    ],
  };

  function editingHandlers(): InspectorHandlers & Record<string, ReturnType<typeof vi.fn>> {
    return {
      onGoto: vi.fn(),
      onAddProperty: vi.fn(),
      onRemoveProperty: vi.fn(),
      onRenameProperty: vi.fn(),
      onChangeType: vi.fn(),
    } as never;
  }

  test('non-computed rows become editable inputs; a computed row stays read-only', () => {
    const el = renderInspector(editableElement, editingHandlers());
    const editableRows = el.querySelectorAll('.koi-inspector-row-editable');
    expect(editableRows.length).toBe(2); // id, total — NOT the computed subtotal
    // The computed row carries no input (it is an expression, not an editable field).
    const computed = el.querySelector('.koi-inspector-row-computed')!;
    expect(computed.querySelector('input')).toBeNull();
    expect(computed.querySelector('.koi-inspector-prop-name')!.textContent).toBe('subtotal');
  });

  test('committing a changed property name calls onRenameProperty with the old + new names', () => {
    const h = editingHandlers();
    const el = renderInspector(editableElement, h);
    document.body.appendChild(el);
    const firstRow = el.querySelector('.koi-inspector-row-editable')!;
    const nameInput = firstRow.querySelector<HTMLInputElement>('.koi-inspector-prop-name input')!;
    nameInput.value = 'identifier';
    nameInput.dispatchEvent(new Event('blur'));
    expect(h.onRenameProperty).toHaveBeenCalledWith(editableElement, 'id', 'identifier');
  });

  test('committing a changed property type calls onChangeType', () => {
    const h = editingHandlers();
    const el = renderInspector(editableElement, h);
    document.body.appendChild(el);
    const firstRow = el.querySelector('.koi-inspector-row-editable')!;
    const typeInput = firstRow.querySelector<HTMLInputElement>('.koi-inspector-prop-type input')!;
    typeInput.value = 'OrderNumber';
    typeInput.dispatchEvent(new Event('blur'));
    expect(h.onChangeType).toHaveBeenCalledWith(editableElement, 'id', 'OrderNumber');
  });

  test('an unchanged property input does not fire an edit', () => {
    const h = editingHandlers();
    const el = renderInspector(editableElement, h);
    document.body.appendChild(el);
    const nameInput = el.querySelector<HTMLInputElement>('.koi-inspector-row-editable .koi-inspector-prop-name input')!;
    nameInput.dispatchEvent(new Event('blur')); // value untouched
    expect(h.onRenameProperty).not.toHaveBeenCalled();
  });

  test('the delete button calls onRemoveProperty with the property name', () => {
    const h = editingHandlers();
    const el = renderInspector(editableElement, h);
    const del = el.querySelector<HTMLButtonElement>('.koi-inspector-row-editable .koi-inspector-prop-delete')!;
    del.click();
    expect(h.onRemoveProperty).toHaveBeenCalledWith(editableElement, 'id');
  });

  test('the add-property row calls onAddProperty once both fields are filled (and ignores a blank one)', () => {
    const h = editingHandlers();
    const el = renderInspector(editableElement, h);
    const name = el.querySelector<HTMLInputElement>('.koi-inspector-add-name')!;
    const type = el.querySelector<HTMLInputElement>('.koi-inspector-add-type')!;
    const add = el.querySelector<HTMLButtonElement>('.koi-inspector-add-btn')!;

    add.click(); // both empty → no-op
    expect(h.onAddProperty).not.toHaveBeenCalled();

    name.value = 'quantity';
    type.value = 'Int';
    add.click();
    expect(h.onAddProperty).toHaveBeenCalledWith(editableElement, 'quantity', 'Int');
  });

  test('with no editing handlers the Properties table stays read-only (no inputs, no add row)', () => {
    const el = renderInspector(editableElement, { onGoto: () => {} });
    expect(el.querySelector('.koi-inspector-row-editable')).toBeNull();
    expect(el.querySelector('.koi-inspector-prop-input')).toBeNull();
    expect(el.querySelector('.koi-inspector-add-prop')).toBeNull();
  });
});

describe('renderChangeHistory', () => {
  const entries: ChangeEntry[] = [
    { sha: 'a1b2c3d', author: 'Alice Dupont', date: '2026-06-20T10:30:00+02:00', message: 'Add the Rule invariant' },
    { sha: 'e4f5g6h', author: 'Bob', date: '2026-05-01T09:00:00Z', message: 'Introduce Order aggregate' },
  ];

  test('is hidden (null) when history is unavailable or empty', () => {
    expect(renderChangeHistory(null)).toBeNull();
    expect(renderChangeHistory([])).toBeNull();
  });

  test('renders one row per commit, newest first, as author · date over the message', () => {
    const el = renderChangeHistory(entries)!;
    expect(el).not.toBeNull();
    expect(el.querySelector('.koi-inspector-section-title')!.textContent).toBe('Change history');

    const rows = Array.from(el.querySelectorAll('.koi-inspector-history-item'));
    expect(rows.length).toBe(2);
    // The author date is shown as its YYYY-MM-DD calendar day (locale-free), with author and message.
    expect(rows[0].querySelector('.koi-inspector-history-meta')!.textContent).toBe('Alice Dupont · 2026-06-20');
    expect(rows[0].querySelector('.koi-inspector-history-message')!.textContent).toBe('Add the Rule invariant');
    expect(rows[1].querySelector('.koi-inspector-history-meta')!.textContent).toBe('Bob · 2026-05-01');
  });

  test('carries each commit SHA on the row for a later jump-to-commit', () => {
    const el = renderChangeHistory(entries)!;
    const shas = Array.from(el.querySelectorAll('.koi-inspector-history-item')).map((n) => (n as HTMLElement).dataset.sha);
    expect(shas).toEqual(['a1b2c3d', 'e4f5g6h']);
  });
});

describe('renameStatusMessage (#550; #565 follow-up: reads the authoritative signal, not rendered text)', () => {
  // Only the `changes` map — the co-rename OUTCOME (`idCoRename`/`leftBehindIdName`) is set per-test,
  // separately, so each test controls exactly what the authoritative signal says.
  const changesOnly = (...newTexts: string[]): Record<string, TextEdit[]> => ({
    'file:///t.koi': newTexts.map<TextEdit>((newText) => ({ range, newText })),
  });

  test('nothing to flag when the outcome is Applied', () => {
    const edit: WorkspaceEdit = { changes: changesOnly('PurchaseOrder', 'PurchaseOrderId'), idCoRename: 'Applied' };
    expect(renameStatusMessage(fullElement, 'PurchaseOrder', edit)).toBeNull();
  });

  test('flags the left-behind id when the outcome is LeftBehind — same message text as before the #565 follow-up', () => {
    const edit: WorkspaceEdit = { changes: changesOnly('PurchaseOrder'), idCoRename: 'LeftBehind', leftBehindIdName: 'OrderId' };
    const msg = renameStatusMessage(fullElement, 'PurchaseOrder', edit);
    expect(msg).toBe('Renamed Order → PurchaseOrder; id type OrderId left unchanged');
  });

  test('nothing to flag when the outcome is absent (no convention-linked id to begin with)', () => {
    const edit: WorkspaceEdit = { changes: changesOnly('Purchase') };
    expect(renameStatusMessage(fullElement, 'Purchase', edit)).toBeNull();
  });

  test('nothing to flag when the outcome is explicitly null over the wire (not applicable)', () => {
    const edit: WorkspaceEdit = { changes: changesOnly('Purchase'), idCoRename: null };
    expect(renameStatusMessage(fullElement, 'Purchase', edit)).toBeNull();
  });

  test('flags LeftBehind even when the element renders nothing like a convention-linked aggregate root', () => {
    // Neither an 'aggregate root' stereotype nor an `id: <X>Id` property row — the OLD rendered-text
    // heuristic would have bailed out at the very first check. The signal is authoritative: it still
    // flags, and the left-behind name comes straight off the wire field (deliberately NOT
    // `${element.name}Id`), proving the message isn't re-derived from the element at all.
    const notObviouslyARoot: InspectorElement = {
      ...fullElement,
      stereotype: 'entity',
      properties: [{ text: 'total: Money', computed: false }],
    };
    const edit: WorkspaceEdit = { changes: changesOnly('Purchase'), idCoRename: 'LeftBehind', leftBehindIdName: 'LegacyOrderId' };
    const msg = renameStatusMessage(notObviouslyARoot, 'Purchase', edit);
    expect(msg).toBe('Renamed Order → Purchase; id type LegacyOrderId left unchanged');
  });

  test('flags LeftBehind even when `changes` contains a *Id-shaped newText the OLD heuristic would have read as "co-renamed"', () => {
    // The old code derived the decision by scanning `changes` for a `newText === \`${newName}Id\``
    // match — here that exact text ("PurchaseOrderId") IS present, which would have suppressed the
    // warning under the old implementation. The authoritative outcome says LeftBehind, so the warning
    // must still fire: this is the direct proof `changes` is no longer consulted for the decision.
    const edit: WorkspaceEdit = {
      changes: changesOnly('PurchaseOrder', 'PurchaseOrderId'),
      idCoRename: 'LeftBehind',
      leftBehindIdName: 'OrderId',
    };
    const msg = renameStatusMessage(fullElement, 'PurchaseOrder', edit);
    expect(msg).toBe('Renamed Order → PurchaseOrder; id type OrderId left unchanged');
  });
});
