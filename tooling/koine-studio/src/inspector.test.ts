import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildNodeIndex, renderInspector, type InspectorHandlers } from './inspector';
import type { Diagram, DiagramNode, DocsResult, SourceSpan } from './lsp';

afterEach(() => {
  document.body.innerHTML = '';
});

const span: SourceSpan = {
  file: 'file:///Ordering.koi',
  line: 3,
  column: 1,
  endLine: 3,
  endColumn: 6,
  offset: 0,
  length: 5,
};

function node(partial: Partial<DiagramNode> & { qualifiedName: string }): DiagramNode {
  return {
    id: partial.qualifiedName,
    label: partial.label ?? partial.qualifiedName.split('.').pop()!,
    kind: 'aggregate-root',
    sourceSpan: span,
    stereotype: 'aggregate root',
    members: [],
    ...partial,
  };
}

const orderNode = (): DiagramNode =>
  node({
    qualifiedName: 'Ordering.Order',
    label: 'Order',
    stereotype: 'aggregate root',
    members: [
      { text: 'id: OrderId', kind: 'field' },
      { text: 'total: Money', kind: 'field' },
      { text: 'addItem(productId: ProductId, qty: int)', kind: 'method' },
      { text: 'confirm()', kind: 'method' },
    ],
  });

const noop: InspectorHandlers = { onGoto: () => {} };

describe('renderInspector', () => {
  test('renders an empty state when nothing is selected', () => {
    const root = renderInspector(null, noop);
    document.body.appendChild(root);
    expect(root.querySelector('.koi-inspector-empty')).not.toBeNull();
  });

  test('renders the header, stereotype, properties and behaviors', () => {
    const root = renderInspector(orderNode(), noop);
    document.body.appendChild(root);
    const text = root.textContent ?? '';
    expect(text).toContain('Order');
    expect(text).toContain('aggregate root');
    expect(text).toContain('Properties');
    expect(text).toContain('id: OrderId');
    expect(text).toContain('total: Money');
    expect(text).toContain('Behaviors');
    expect(text).toContain('addItem(productId: ProductId, qty: int)');
    expect(text).toContain('confirm()');
  });

  test('renders enum values under a Values section', () => {
    const root = renderInspector(
      node({
        qualifiedName: 'Ordering.OrderStatus',
        label: 'OrderStatus',
        kind: 'enum',
        stereotype: null,
        members: [
          { text: 'Draft', kind: 'value' },
          { text: 'Placed', kind: 'value' },
        ],
      }),
      noop,
    );
    document.body.appendChild(root);
    const text = root.textContent ?? '';
    expect(text).toContain('Values');
    expect(text).toContain('Draft');
    expect(text).toContain('Placed');
  });

  test('omits sections that have no members', () => {
    const root = renderInspector(node({ qualifiedName: 'Ordering.Money', kind: 'value-object', members: [] }), noop);
    document.body.appendChild(root);
    const text = root.textContent ?? '';
    expect(text).not.toContain('Properties');
    expect(text).not.toContain('Behaviors');
  });

  test('the header jumps to source when it has a span', () => {
    const onGoto = vi.fn();
    const root = renderInspector(orderNode(), { onGoto });
    document.body.appendChild(root);
    root.querySelector<HTMLButtonElement>('.koi-inspector-name')!.click();
    expect(onGoto).toHaveBeenCalledTimes(1);
    expect(onGoto.mock.calls[0][0]).toEqual(span);
  });
});

describe('buildNodeIndex', () => {
  function docs(diagrams: Diagram[]): DocsResult {
    return { files: [{ path: 'living.md', contents: '', diagrams }] };
  }
  function diagram(nodes: DiagramNode[]): Diagram {
    return { caption: 'd', kind: 'aggregate', mermaid: '', graph: { nodes, edges: [] } };
  }

  test('indexes nodes by qualified name across all diagrams', () => {
    const index = buildNodeIndex(
      docs([
        diagram([node({ qualifiedName: 'Ordering.Order' })]),
        diagram([node({ qualifiedName: 'Shipping.Shipment' })]),
      ]),
    );
    expect(index.get('Ordering.Order')?.label).toBe('Order');
    expect(index.get('Shipping.Shipment')?.label).toBe('Shipment');
  });

  test('prefers the richer node (one carrying members) when a qualified name repeats', () => {
    const bare = node({ qualifiedName: 'Ordering.Order', members: [] });
    const rich = node({ qualifiedName: 'Ordering.Order', members: [{ text: 'id: OrderId', kind: 'field' }] });
    const index = buildNodeIndex(docs([diagram([bare]), diagram([rich])]));
    expect(index.get('Ordering.Order')?.members.length).toBe(1);
  });
});
