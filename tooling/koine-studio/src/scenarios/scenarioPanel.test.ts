import { describe, it, expect, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { createScenarioPanel, type ScenarioLsp } from '@/scenarios/scenarioPanel';
import type { ScenarioCatalog, ScenarioResult } from '@/lsp/protocol';

const CATALOG: ScenarioCatalog = {
  targets: [
    {
      name: 'Order',
      operations: [
        { name: 'place', kind: 'command', params: [], returns: null },
        {
          name: 'open',
          kind: 'factory',
          params: [{ name: 'customer', type: 'CustomerId' }],
          returns: null,
        },
      ],
      fields: [
        { name: 'lines', type: 'List<OrderLine>', optional: false },
        { name: 'status', type: 'OrderStatus', optional: false },
      ],
    },
  ],
};

const PLACED: ScenarioResult = {
  ok: true,
  target: 'Order',
  operation: 'place',
  steps: [
    { kind: 'requires', message: 'only a draft order can be placed', condition: 'status == Draft', outcome: 'passed' },
    { kind: 'transition', field: 'status', from: 'Draft', to: 'Placed', isInitialization: false },
    { kind: 'emit', event: 'OrderPlaced', args: { orderId: '<OrderId>', lineCount: '1' } },
  ],
  resultingState: { status: 'Placed', lines: '[{quantity: 1}]' },
  invariants: [{ message: 'every line needs a positive quantity', condition: 'lines.all(...)', outcome: 'passed' }],
  result: null,
  notes: [],
};

function mockLsp(overrides: Partial<ScenarioLsp> = {}): ScenarioLsp {
  return {
    scenarioCatalog: vi.fn(async () => CATALOG),
    runScenario: vi.fn(async () => PLACED),
    ...overrides,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('scenarioPanel', () => {
  it('populates the target + operation dropdowns from the catalog', async () => {
    const container = document.createElement('div');
    const lsp = mockLsp();
    const panel = createScenarioPanel({ container, lsp });
    await panel.refresh();

    const target = container.querySelector<HTMLSelectElement>('.koi-scenario-target')!;
    const op = container.querySelector<HTMLSelectElement>('.koi-scenario-op')!;
    expect(Array.from(target.options).map((o) => o.value)).toEqual(['Order']);
    expect(Array.from(op.options).map((o) => o.value)).toEqual(['place', 'open']);
  });

  it('scaffolds the given-state JSON from the selected target fields', async () => {
    const container = document.createElement('div');
    const panel = createScenarioPanel({ container, lsp: mockLsp() });
    await panel.refresh();

    const given = container.querySelector<HTMLTextAreaElement>('.koi-scenario-json')!;
    const scaffold = JSON.parse(given.value);
    expect(scaffold).toEqual({ lines: [], status: '' });
  });

  it('runs the scenario and renders the command → events → invariants timeline', async () => {
    const container = document.createElement('div');
    const lsp = mockLsp();
    const panel = createScenarioPanel({ container, lsp });
    await panel.refresh();

    container.querySelector<HTMLButtonElement>('.koi-scenario-run')!.click();
    await flush();

    expect(lsp.runScenario).toHaveBeenCalledWith('Order', 'place', expect.any(Object), expect.any(Object));
    const results = container.querySelector('.koi-scenario-results')!;
    expect(results.querySelector('.koi-scenario-badge.is-ok')).not.toBeNull();
    expect(results.textContent).toContain('OrderPlaced');
    expect(results.textContent).toContain('only a draft order can be placed');
    // The emitted-event payload and resulting state are shown.
    expect(results.textContent).toContain('lineCount: 1');
    expect(results.querySelector('.koi-scenario-state')).not.toBeNull();
  });

  it('reports invalid given-state JSON instead of calling the backend', async () => {
    const container = document.createElement('div');
    const lsp = mockLsp();
    const panel = createScenarioPanel({ container, lsp });
    await panel.refresh();

    container.querySelector<HTMLTextAreaElement>('.koi-scenario-json')!.value = '{ not json';
    container.querySelector<HTMLButtonElement>('.koi-scenario-run')!.click();
    await flush();

    expect(lsp.runScenario).not.toHaveBeenCalled();
    expect(container.querySelector('.koi-scenario-message.is-error')?.textContent).toContain('not valid JSON');
  });

  it('shows an empty-state hint and disables Run when nothing is runnable', async () => {
    const container = document.createElement('div');
    const lsp = mockLsp({ scenarioCatalog: vi.fn(async () => ({ targets: [] })) });
    const panel = createScenarioPanel({ container, lsp });
    await panel.refresh();

    expect(container.querySelector<HTMLButtonElement>('.koi-scenario-run')!.disabled).toBe(true);
    expect(container.querySelector('.koi-scenario-message.is-muted')).not.toBeNull();
  });

  it('has no axe violations', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = createScenarioPanel({ container, lsp: mockLsp() });
    await panel.refresh();

    expect(await axe(container)).toHaveNoViolations();
    container.remove();
  });
});
