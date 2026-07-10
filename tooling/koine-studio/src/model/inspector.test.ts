import { describe, expect, test } from 'vitest';
import { buildInspectorElement, formatHistoryDate, renameStatusMessage, type InspectorElement } from '@/model/inspector';
import type { DiagramNode, GlossaryEntry, ModelMember, Range } from '@/lsp/lsp';
import type { TextEdit, WorkspaceEdit } from '@/lsp/protocol';

// The presentation layer (the pure-DOM `renderInspector`/`renderChangeHistory` builders and their
// tests) moved to `PropertiesPanel.test.tsx` as real JSX (#992) — this file now pins only the
// wire-decoupled pure layer that survives: the glossary/diagram-node join, the rename-status message,
// and the change-history date formatter.

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

  test('includes computed members in properties, flagged', () => {
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

describe('formatHistoryDate', () => {
  test('strips an ISO-8601 timestamp down to its YYYY-MM-DD calendar day', () => {
    expect(formatHistoryDate('2026-06-20T10:30:00+02:00')).toBe('2026-06-20');
    expect(formatHistoryDate('2026-05-01T09:00:00Z')).toBe('2026-05-01');
  });

  test('passes a non-ISO-shaped value through unchanged', () => {
    expect(formatHistoryDate('not-a-date')).toBe('not-a-date');
  });
});
