import { beforeAll, describe, expect, test, vi } from 'vitest';
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

// Moved from modelTables.test.ts's `renderEventsTable` describe block when #992 task 3 retired that
// pure-DOM builder in favor of the shared SortableTable — these assert the Events table's SPECIFIC
// column set, empty-state text, and the select-to-inspect (`onActivate` → `handlers.onSelect`) wiring;
// generic table behavior (keyboard access, aria-label, sort toggling, spanless rows) is covered once,
// generically, by SortableTable.test.tsx.
describe('EventsPanel — table (moved from modelTables.test.ts)', () => {
  test('renders the Event · Type · Published By · Bounded Context · When columns, with an em dash for an undocumented event', () => {
    const store = createAppStore();
    const { container } = render(<EventsPanel store={store} graph={graph} handlers={{ goto: () => {} }} />);
    const headers = Array.from(container.querySelectorAll('thead th')).map((th) => th.textContent);
    expect(headers).toEqual(['Event', 'Type', 'Published By', 'Bounded Context', 'When']);
    const firstRow = Array.from(container.querySelectorAll('tbody tr')[0].querySelectorAll('td')).map((td) => td.textContent);
    expect(firstRow).toEqual(['OrderPlaced', 'Domain', 'Order', 'Sales', '—']); // undocumented → em dash
  });

  test('renders an integration event’s Type cell as "Integration", not "Domain"', () => {
    // A context node publishing an integration-event node (mirrors extractEvents' classification rule:
    // node.kind === 'integration-event' → type 'integration', publisher resolved from the `publishes` edge).
    const integrationGraph: DiagramGraph = {
      nodes: [
        node('Sales', 'Sales', 'context', 'Sales', span(1)),
        node('evt_OrderShipped', 'Sales.OrderShipped', 'integration-event', 'Sales.OrderShipped', span(20)),
      ],
      edges: [edge('Sales', 'evt_OrderShipped', 'publishes')],
    };
    const store = createAppStore();
    const { container } = render(
      <EventsPanel store={store} graph={integrationGraph} handlers={{ goto: () => {} }} />,
    );
    const firstRow = Array.from(container.querySelectorAll('tbody tr')[0].querySelectorAll('td')).map(
      (td) => td.textContent,
    );
    expect(firstRow).toEqual(['OrderShipped', 'Integration', 'Sales', 'Sales', '—']);
  });

  test('a row click invokes goto with the row’s span AND onSelect with the event’s qualifiedName + context (loads the inspector)', () => {
    const goto = vi.fn();
    const onSelect = vi.fn();
    const store = createAppStore();
    const { container } = render(<EventsPanel store={store} graph={graph} handlers={{ goto, onSelect }} />);
    (container.querySelectorAll('tbody tr')[0] as HTMLElement).click();
    expect(goto).toHaveBeenCalledWith(graph.nodes.find((n) => n.qualifiedName === 'Sales.OrderPlaced')!.sourceSpan);
    expect(onSelect).toHaveBeenCalledWith('Sales.OrderPlaced', 'Sales');
  });

  // Regression (#1382 follow-up): rows are keyed on the QUALIFIED event name, not the simple-name label.
  // Koine allows same-named events in different bounded contexts (per-context uniqueness, R13.2) and the
  // default "All contexts" scope renders them in ONE tbody — with label keys the duplicate sibling keys
  // made a sort cross-wire the rows, so the focused row could activate the OTHER context's declaration.
  test('same-named events in two contexts keep their own DOM row across a sort and activate their own declaration', () => {
    const goto = vi.fn();
    const dupGraph: DiagramGraph = {
      nodes: [
        node('SalesOrder', 'Order', 'aggregate-root', 'Sales.Order', span(3)),
        node('SalesPlaced', 'OrderPlaced', 'event', 'Sales.OrderPlaced', span(12)),
        node('BillingInvoice', 'Invoice', 'aggregate-root', 'Billing.Invoice', span(30)),
        node('BillingPlaced', 'OrderPlaced', 'event', 'Billing.OrderPlaced', span(42)),
      ],
      edges: [edge('SalesOrder', 'SalesPlaced'), edge('BillingInvoice', 'BillingPlaced')],
    };
    const store = createAppStore();
    const { container } = render(<EventsPanel store={store} graph={dupGraph} handlers={{ goto }} />);
    const before = Array.from(container.querySelectorAll('tbody tr'));
    // Both same-named events render, in graph order (Sales first).
    expect(before.map((r) => r.querySelector('td')!.textContent)).toEqual(['OrderPlaced', 'OrderPlaced']);
    expect(before.map((r) => r.querySelectorAll('td')[3].textContent)).toEqual(['Sales', 'Billing']);

    // Sort ascending by Bounded Context: Billing < Sales.
    act(() => container.querySelectorAll('thead th')[3].querySelector('button')!.click());

    const after = Array.from(container.querySelectorAll('tbody tr'));
    expect(after.map((r) => r.querySelectorAll('td')[3].textContent)).toEqual(['Billing', 'Sales']);
    // The qualified keys let Preact match each row to ITS old <tr> — reordered, never cross-wired…
    expect(after[0]).toBe(before[1]);
    expect(after[1]).toBe(before[0]);
    // …so activating the Billing row jumps to BILLING's declaration, not Sales'.
    (after[0] as HTMLElement).click();
    expect(goto).toHaveBeenCalledWith(
      dupGraph.nodes.find((n) => n.qualifiedName === 'Billing.OrderPlaced')!.sourceSpan,
    );
  });

  test('empty input renders the Events-specific empty-state text (no table)', () => {
    const noEvents: DiagramGraph = {
      nodes: [node('Order', 'Order', 'aggregate-root', 'Sales.Order', span(3))],
      edges: [],
    };
    const store = createAppStore();
    const { container } = render(<EventsPanel store={store} graph={noEvents} handlers={{ goto: () => {} }} />);
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('.koi-table-empty')!.textContent).toBe(
      'No events yet — add a domain or integration event to your model.',
    );
  });
});
