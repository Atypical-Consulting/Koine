import { describe, expect, test } from 'vitest';
import { act, render } from '@testing-library/preact';
import { createAppStore } from '@/store/index';
import { EventsPanel } from '@/panels/EventsPanel';
import type { DiagramEdge, DiagramGraph, DiagramNode, SourceSpan } from '@/lsp/lsp';

const span = (line: number): SourceSpan => ({
  file: 'file:///m.koi',
  line,
  column: 3,
  endLine: line,
  endColumn: 9,
  offset: 0,
  length: 6,
});

const node = (
  id: string,
  label: string,
  kind: string,
  qualifiedName: string,
  sourceSpan: SourceSpan | null = null,
): DiagramNode => ({ id, label, kind, qualifiedName, sourceSpan, stereotype: null, members: [] });

const edge = (from: string, to: string, label: string | null = null): DiagramEdge => ({ from, to, label });

// A merged graph with a domain event in Sales and an integration event in Shipping, so scoping to
// "Sales" keeps the Sales event and drops the Shipping one.
const graph: DiagramGraph = {
  nodes: [
    node('Order', 'Order', 'aggregate-root', 'Sales.Order', span(3)),
    node('OrderPlaced', 'OrderPlaced', 'event', 'Sales.OrderPlaced', span(12)),
    node('ShipDispatched', 'ShipDispatched', 'event', 'Shipping.ShipDispatched', span(40)),
    node('Shipping', 'Shipping', 'aggregate-root', 'Shipping.Shipment', span(30)),
  ],
  edges: [edge('Order', 'OrderPlaced'), edge('Shipping', 'ShipDispatched')],
};

describe('EventsPanel', () => {
  test('lists every context’s events when unscoped, narrows when the active context changes', () => {
    const store = createAppStore();
    const { container } = render(<EventsPanel store={store} graph={graph} handlers={{ goto: () => {} }} />);

    // Unscoped (ALL_CONTEXTS) → both events present.
    expect(container.textContent).toContain('OrderPlaced');
    expect(container.textContent).toContain('ShipDispatched');

    // Narrowing the scope re-renders (act() flushes Preact's batched re-render) and drops the other one.
    act(() => store.getState().setActiveContext('Sales'));
    expect(container.textContent).toContain('OrderPlaced');
    expect(container.textContent).not.toContain('ShipDispatched');
  });
});
