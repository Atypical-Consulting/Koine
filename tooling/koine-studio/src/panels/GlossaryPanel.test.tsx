import { describe, expect, test } from 'vitest';
import { act, render } from '@testing-library/preact';
import { createAppStore } from '@/store/index';
import { GlossaryPanel } from '@/panels/GlossaryPanel';
import type { GlossaryEntry, GlossaryModel, Range } from '@/lsp';
import type { GlossaryHandlers } from '@/glossary';

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
});
