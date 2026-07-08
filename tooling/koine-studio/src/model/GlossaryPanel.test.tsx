import { describe, expect, test } from 'vitest';
import { act, render } from '@testing-library/preact';
import { createAppStore } from '@/store/index';
import { GlossaryPanel } from '@/model/GlossaryPanel';
import type { GlossaryEntry, GlossaryModel, Range } from '@/lsp/lsp';
import type { GlossaryHandlers } from '@/model/glossary';
import { axe } from 'vitest-axe';

const range: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

const entry = (name: string, context: string, kind = 'value'): GlossaryEntry => ({
  id: `${context}.${name}`,
  name,
  kind,
  context,
  qualifiedName: `${context}.${name}`,
  doc: null,
  nameRange: range,
});

// A two-context glossary: Sales owns Order, Inv owns Stock. Scoping to "Sales" keeps Order, drops Stock.
const model: GlossaryModel = { entries: [entry('Order', 'Sales'), entry('Stock', 'Inv')] };

const handlers: GlossaryHandlers = { onGoto: () => {}, onSave: () => {} };

describe('GlossaryPanel', () => {
  test('renders every context’s concepts when unscoped, narrows when the active context changes', () => {
    const store = createAppStore();
    const { container } = render(<GlossaryPanel store={store} model={model} handlers={handlers} />);

    // Unscoped → both contexts' concepts present.
    expect(container.textContent).toContain('Order');
    expect(container.textContent).toContain('Stock');

    // Narrowing to Sales re-renders (act() flushes Preact's batched re-render) and drops the Inv concept.
    act(() => store.getState().setActiveContext('Sales'));
    expect(container.textContent).toContain('Order');
    expect(container.textContent).not.toContain('Stock');
  });

  test('scrolls the targeted term into view when a scroll target is given (#1165)', () => {
    const store = createAppStore();
    const scrolled: Element[] = [];
    const orig = Element.prototype.scrollIntoView;
    // happy-dom doesn't implement scrollIntoView; install a spy that records the element it lands on.
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      render(
        <GlossaryPanel store={store} model={model} handlers={handlers} scrollToTerm="Sales.Order" scrollNonce={1} />,
      );
      // The Order entry (data-qn="Sales.Order") is the one scrolled into view — not the whole panel.
      expect(scrolled.some((e) => e.getAttribute('data-qn') === 'Sales.Order')).toBe(true);
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });

  test('has no accessibility violations', async () => {
    const store = createAppStore();
    const { container } = render(<GlossaryPanel store={store} model={model} handlers={handlers} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
