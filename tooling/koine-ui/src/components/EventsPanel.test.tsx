import { describe, expect, test, vi } from 'vitest';
import { act, render } from '@testing-library/preact';
import { axe } from 'vitest-axe';
import {
  EventsPanel,
  type EventFlowNodeView,
  type EventRowView,
  type EventsPanelSlice,
  type FlowRenderer,
} from './EventsPanel';
import { EventsPanel as EventsPanelFromBarrel } from '../index';
import { createTestReadableStore } from '../host/storeTestUtils';
import type { SourceSpan } from './SortableTable';

const span = (line: number): SourceSpan => ({
  file: 'file:///m.koi',
  line,
  column: 3,
  endLine: line,
  endColumn: 9,
  offset: 0,
  length: 6,
});

const erow = (
  name: string,
  qualifiedName: string,
  type: 'domain' | 'integration',
  publishedBy: string,
  context: string,
  when = '',
  rowSpan: SourceSpan | null = null,
): EventRowView => ({ name, qualifiedName, type, publishedBy, context, when, span: rowSpan });

const fnode = (id: string, label: string, kind: EventFlowNodeView['kind'], context: string): EventFlowNodeView => ({
  id,
  label,
  kind,
  context,
});

// A slice for the "All contexts" scope: a Sales domain event and a Shipping one; a host scope change to
// "Sales" narrows both the rows and the flow legend to the Sales event.
const allSlice: EventsPanelSlice = {
  scopeKey: 'all',
  rows: [
    erow('OrderPlaced', 'Sales.OrderPlaced', 'domain', 'Order', 'Sales', '', span(12)),
    erow('ShipDispatched', 'Shipping.ShipDispatched', 'domain', 'Shipping', 'Shipping', '', span(40)),
  ],
  flowNodes: [fnode('n1', 'OrderPlaced', 'domain-event', 'Sales'), fnode('n2', 'ShipDispatched', 'domain-event', 'Shipping')],
};
const salesSlice: EventsPanelSlice = {
  scopeKey: 'Sales',
  rows: [erow('OrderPlaced', 'Sales.OrderPlaced', 'domain', 'Order', 'Sales', '', span(12))],
  flowNodes: [fnode('n1', 'OrderPlaced', 'domain-event', 'Sales')],
};

// A renderFlow spy that records each (host, scopeKey) invocation and hands back a per-call dispose spy.
function makeRenderFlow() {
  const calls: { host: HTMLElement; scopeKey: string; dispose: ReturnType<typeof vi.fn> }[] = [];
  const renderFlow: FlowRenderer = (host, scopeKey) => {
    const dispose = vi.fn();
    calls.push({ host, scopeKey, dispose });
    return { dispose };
  };
  return { renderFlow, calls };
}

const noRender: FlowRenderer = () => ({ dispose: () => {} });

describe('EventsPanel', () => {
  test('exports the same component from the barrel', () => {
    expect(EventsPanelFromBarrel).toBe(EventsPanel);
  });

  test('lists every context’s events, and a host scope change (set) narrows them', () => {
    const store = createTestReadableStore<EventsPanelSlice>(allSlice);
    const { container } = render(<EventsPanel store={store} handlers={{ goto: () => {} }} renderFlow={noRender} />);

    expect(container.textContent).toContain('OrderPlaced');
    expect(container.textContent).toContain('ShipDispatched');

    act(() => store.set(salesSlice));
    expect(container.textContent).toContain('OrderPlaced');
    expect(container.textContent).not.toContain('ShipDispatched');
  });

  test('has no accessibility violations', async () => {
    const store = createTestReadableStore<EventsPanelSlice>(allSlice);
    const { container } = render(<EventsPanel store={store} handlers={{ goto: () => {} }} renderFlow={noRender} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('EventsPanel — Table | Flow toggle (#270)', () => {
  const flowBtn = (c: Element) => c.querySelector('button[data-view="flow"]') as HTMLElement;
  const tableBtn = (c: Element) => c.querySelector('button[data-view="table"]') as HTMLElement;

  test('defaults to the table, switches to the flow canvas, and restores the table', () => {
    const store = createTestReadableStore<EventsPanelSlice>(allSlice);
    const { container } = render(<EventsPanel store={store} handlers={{ goto: () => {} }} renderFlow={noRender} />);

    expect(container.querySelector('.koi-events-mount')).not.toBeNull();
    expect(container.querySelector('.koi-event-flow-mount')).toBeNull();

    act(() => flowBtn(container).click());
    expect(container.querySelector('.koi-event-flow-mount')).not.toBeNull();
    expect(container.querySelector('.koi-events-mount')).toBeNull();

    act(() => tableBtn(container).click());
    expect(container.querySelector('.koi-events-mount')).not.toBeNull();
    expect(container.querySelector('.koi-event-flow-mount')).toBeNull();
  });

  test('switching to Flow invokes the injected renderer with the mount node + scope key; a scope change re-invokes it and disposes the prior; unmount disposes once', () => {
    const { renderFlow, calls } = makeRenderFlow();
    const store = createTestReadableStore<EventsPanelSlice>(allSlice);
    const { container, unmount } = render(
      <EventsPanel store={store} handlers={{ goto: () => {} }} renderFlow={renderFlow} />,
    );

    // Switch to Flow → renderFlow called once with the mount node and the current scope key.
    act(() => flowBtn(container).click());
    expect(calls).toHaveLength(1);
    expect(calls[0].host).toBe(container.querySelector('.koi-event-flow-mount'));
    expect(calls[0].scopeKey).toBe('all');

    // A host scope change re-derives the flow: the prior handle is disposed exactly once and renderFlow
    // is re-invoked with the new scope key.
    act(() => store.set(salesSlice));
    expect(calls[0].dispose).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(calls[1].scopeKey).toBe('Sales');

    // Unmount tears down the live canvas exactly once.
    unmount();
    expect(calls[1].dispose).toHaveBeenCalledTimes(1);
  });

  test('the flow legend tracks the active context (its SR-only text alternative narrows on scope change)', () => {
    const store = createTestReadableStore<EventsPanelSlice>(allSlice);
    const { container } = render(<EventsPanel store={store} handlers={{ goto: () => {} }} renderFlow={noRender} />);
    act(() => flowBtn(container).click());

    const legend = () => container.querySelector('.koi-event-flow-legend')!.textContent;
    expect(legend()).toContain('OrderPlaced');
    expect(legend()).toContain('ShipDispatched');

    act(() => store.set(salesSlice));
    expect(legend()).toContain('OrderPlaced');
    expect(legend()).not.toContain('ShipDispatched');
  });

  test('the flow view has no accessibility violations', async () => {
    const store = createTestReadableStore<EventsPanelSlice>(allSlice);
    const { container } = render(<EventsPanel store={store} handlers={{ goto: () => {} }} renderFlow={noRender} />);
    act(() => flowBtn(container).click());
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('EventsPanel — table', () => {
  test('renders the Event · Type · Published By · Bounded Context · When columns, with an em dash for an undocumented event', () => {
    const store = createTestReadableStore<EventsPanelSlice>(allSlice);
    const { container } = render(<EventsPanel store={store} handlers={{ goto: () => {} }} renderFlow={noRender} />);
    const headers = Array.from(container.querySelectorAll('thead th')).map((th) => th.textContent);
    expect(headers).toEqual(['Event', 'Type', 'Published By', 'Bounded Context', 'When']);
    const firstRow = Array.from(container.querySelectorAll('tbody tr')[0].querySelectorAll('td')).map((td) => td.textContent);
    expect(firstRow).toEqual(['OrderPlaced', 'Domain', 'Order', 'Sales', '—']); // undocumented → em dash
  });

  test('renders an integration event’s Type cell as "Integration", not "Domain"', () => {
    const store = createTestReadableStore<EventsPanelSlice>({
      scopeKey: 'all',
      rows: [erow('OrderShipped', 'Sales.OrderShipped', 'integration', 'Sales', 'Sales', '', span(20))],
      flowNodes: [],
    });
    const { container } = render(<EventsPanel store={store} handlers={{ goto: () => {} }} renderFlow={noRender} />);
    const firstRow = Array.from(container.querySelectorAll('tbody tr')[0].querySelectorAll('td')).map((td) => td.textContent);
    expect(firstRow).toEqual(['OrderShipped', 'Integration', 'Sales', 'Sales', '—']);
  });

  test('a row click invokes goto with the row’s span AND onSelect with the event’s qualifiedName + context', () => {
    const goto = vi.fn();
    const onSelect = vi.fn();
    const orderSpan = span(12);
    const store = createTestReadableStore<EventsPanelSlice>({
      scopeKey: 'all',
      rows: [erow('OrderPlaced', 'Sales.OrderPlaced', 'domain', 'Order', 'Sales', '', orderSpan)],
      flowNodes: [],
    });
    const { container } = render(<EventsPanel store={store} handlers={{ goto, onSelect }} renderFlow={noRender} />);
    (container.querySelectorAll('tbody tr')[0] as HTMLElement).click();
    expect(goto).toHaveBeenCalledWith(orderSpan);
    expect(onSelect).toHaveBeenCalledWith('Sales.OrderPlaced', 'Sales');
  });

  // Regression (#1382 follow-up): rows are keyed on the QUALIFIED event name, not the simple-name label, so
  // same-named events in two contexts keep their own DOM row across a sort and activate their own declaration.
  test('same-named events in two contexts keep their own DOM row across a sort and activate their own declaration', () => {
    const goto = vi.fn();
    const salesSpan = span(12);
    const billingSpan = span(42);
    const store = createTestReadableStore<EventsPanelSlice>({
      scopeKey: 'all',
      rows: [
        erow('OrderPlaced', 'Sales.OrderPlaced', 'domain', 'Order', 'Sales', '', salesSpan),
        erow('OrderPlaced', 'Billing.OrderPlaced', 'domain', 'Invoice', 'Billing', '', billingSpan),
      ],
      flowNodes: [],
    });
    const { container } = render(<EventsPanel store={store} handlers={{ goto }} renderFlow={noRender} />);
    const before = Array.from(container.querySelectorAll('tbody tr'));
    expect(before.map((r) => r.querySelector('td')!.textContent)).toEqual(['OrderPlaced', 'OrderPlaced']);
    expect(before.map((r) => r.querySelectorAll('td')[3].textContent)).toEqual(['Sales', 'Billing']);

    // Sort ascending by Bounded Context: Billing < Sales.
    act(() => container.querySelectorAll('thead th')[3].querySelector('button')!.click());

    const after = Array.from(container.querySelectorAll('tbody tr'));
    expect(after.map((r) => r.querySelectorAll('td')[3].textContent)).toEqual(['Billing', 'Sales']);
    expect(after[0]).toBe(before[1]);
    expect(after[1]).toBe(before[0]);
    (after[0] as HTMLElement).click();
    expect(goto).toHaveBeenCalledWith(billingSpan);
  });

  test('empty input renders the Events-specific empty-state text (no table)', () => {
    const store = createTestReadableStore<EventsPanelSlice>({ scopeKey: 'all', rows: [], flowNodes: [] });
    const { container } = render(<EventsPanel store={store} handlers={{ goto: () => {} }} renderFlow={noRender} />);
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('.koi-table-empty')!.textContent).toBe(
      'No events yet — add a domain or integration event to your model.',
    );
  });
});
