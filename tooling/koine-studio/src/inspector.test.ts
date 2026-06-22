import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  buildInspectorElement,
  renderInspector,
  type InspectorElement,
  type InspectorHandlers,
} from './inspector';
import type { DiagramNode, GlossaryEntry, Range } from './lsp';

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

describe('renderInspector', () => {
  test('renders an empty state when nothing is selected', () => {
    const el = renderInspector(null, noop);
    expect(el.classList.contains('koi-inspector-empty')).toBe(true);
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
