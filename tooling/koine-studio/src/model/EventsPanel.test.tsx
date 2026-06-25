import { beforeAll, describe, expect, test } from 'vitest';
import { act, render } from '@testing-library/preact';
import { createAppStore } from '@/store/index';
import { EventsPanel } from '@/model/EventsPanel';
import type { DiagramEdge, DiagramGraph, DiagramNode, SourceSpan } from '@/lsp/lsp';
import { axe } from 'vitest-axe';

// The Flow view mounts a maxGraph canvas, which reads the container rect on construction; happy-dom
// returns 0, so shim it (as the diagrams-maxgraph suite does) — the Flow assertions are on the synchronously
// rendered mount + its text-alternative legend, never on pixels.
beforeAll(() => {
  Element.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON() {} }) as DOMRect;
});

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

  test('has no accessibility violations', async () => {
    const store = createAppStore();
    const { container } = render(<EventsPanel store={store} graph={graph} handlers={{ goto: () => {} }} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('EventsPanel — Table | Flow toggle (#270)', () => {
  const flowBtn = (c: Element) => c.querySelector('button[data-view="flow"]') as HTMLElement;
  const tableBtn = (c: Element) => c.querySelector('button[data-view="table"]') as HTMLElement;

  test('defaults to the table, switches to the flow canvas, and restores the table', () => {
    const store = createAppStore();
    const { container } = render(<EventsPanel store={store} graph={graph} handlers={{ goto: () => {} }} />);

    // Default: the events table is mounted, no flow canvas.
    expect(container.querySelector('.koi-events-mount')).not.toBeNull();
    expect(container.querySelector('.koi-event-flow-mount')).toBeNull();

    // Switch to Flow: the canvas mount appears, the table is gone.
    act(() => flowBtn(container).click());
    expect(container.querySelector('.koi-event-flow-mount')).not.toBeNull();
    expect(container.querySelector('.koi-events-mount')).toBeNull();

    // Switch back to Table: the table returns, the canvas mount is gone.
    act(() => tableBtn(container).click());
    expect(container.querySelector('.koi-events-mount')).not.toBeNull();
    expect(container.querySelector('.koi-event-flow-mount')).toBeNull();
  });

  test('the flow view re-derives for the active context (its legend tracks the scope)', () => {
    const store = createAppStore();
    const { container } = render(<EventsPanel store={store} graph={graph} handlers={{ goto: () => {} }} />);
    act(() => flowBtn(container).click());

    const legend = () => container.querySelector('.koi-event-flow-legend')!.textContent;
    // Unscoped → both contexts' events are in the flow.
    expect(legend()).toContain('OrderPlaced');
    expect(legend()).toContain('ShipDispatched');

    // Narrowing to Sales re-derives the flow and drops the other context's event.
    act(() => store.getState().setActiveContext('Sales'));
    expect(legend()).toContain('OrderPlaced');
    expect(legend()).not.toContain('ShipDispatched');
  });

  test('the flow view has no accessibility violations', async () => {
    const store = createAppStore();
    const { container } = render(<EventsPanel store={store} graph={graph} handlers={{ goto: () => {} }} />);
    act(() => flowBtn(container).click());
    expect(await axe(container)).toHaveNoViolations();
  });
});
