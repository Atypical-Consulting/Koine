import { describe, it, expect, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { createScenarioPanel, type ScenarioHost, type ScenarioLsp } from '@/scenarios/scenarioPanel';
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

// The two host slices the panel is built against (#236): executed mode needs a sandbox child process,
// so only the desktop host offers it. Most specs run on the host that can't, like the browser.
const NO_EXEC: ScenarioHost = { supportsScenarioExecution: false };
const CAN_EXEC: ScenarioHost = { supportsScenarioExecution: true };

const PLACED: ScenarioResult = {
  ok: true,
  target: 'Order',
  operation: 'place',
  mode: 'interpreted',
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
    const panel = createScenarioPanel({ container, lsp, platform: NO_EXEC });
    await panel.refresh();

    const target = container.querySelector<HTMLSelectElement>('.koi-scenario-target')!;
    const op = container.querySelector<HTMLSelectElement>('.koi-scenario-op')!;
    expect(Array.from(target.options).map((o) => o.value)).toEqual(['Order']);
    expect(Array.from(op.options).map((o) => o.value)).toEqual(['place', 'open']);
  });

  it('scaffolds the given-state JSON from the selected target fields', async () => {
    const container = document.createElement('div');
    const panel = createScenarioPanel({ container, lsp: mockLsp(), platform: NO_EXEC });
    await panel.refresh();

    const given = container.querySelector<HTMLTextAreaElement>('.koi-scenario-json')!;
    const scaffold = JSON.parse(given.value);
    expect(scaffold).toEqual({ lines: [], status: '' });
  });

  it('runs the scenario and renders the command → events → invariants timeline', async () => {
    const container = document.createElement('div');
    const lsp = mockLsp();
    const panel = createScenarioPanel({ container, lsp, platform: NO_EXEC });
    await panel.refresh();

    container.querySelector<HTMLButtonElement>('.koi-scenario-run')!.click();
    await flush();

    // Executed mode is opt-in (#236): a plain run asks for the interpreter.
    expect(lsp.runScenario).toHaveBeenCalledWith('Order', 'place', expect.any(Object), expect.any(Object), {
      execute: false,
    });
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
    const panel = createScenarioPanel({ container, lsp, platform: NO_EXEC });
    await panel.refresh();

    container.querySelector<HTMLTextAreaElement>('.koi-scenario-json')!.value = '{ not json';
    container.querySelector<HTMLButtonElement>('.koi-scenario-run')!.click();
    await flush();

    expect(lsp.runScenario).not.toHaveBeenCalled();
    expect(container.querySelector('.koi-scenario-message.is-error')?.textContent).toContain('not valid JSON');
  });

  it('keeps hand-edited given/args JSON and the last results across a refresh that preserves the selection', async () => {
    const container = document.createElement('div');
    const lsp = mockLsp();
    const panel = createScenarioPanel({ container, lsp, platform: NO_EXEC });
    await panel.refresh();

    const [given, args] = Array.from(container.querySelectorAll<HTMLTextAreaElement>('.koi-scenario-json'));
    given.value = '{ "lines": [{ "quantity": 2 }], "status": "Draft" }';
    args.value = '{ "customer": "c-1" }';
    container.querySelector<HTMLButtonElement>('.koi-scenario-run')!.click();
    await flush();

    // The controller re-shows the tab (or a model edit settles) → refresh with an unchanged catalog.
    await panel.refresh();

    expect(given.value).toContain('"quantity": 2');
    expect(args.value).toContain('c-1');
    expect(container.querySelector('.koi-scenario-badge.is-ok')).not.toBeNull();
  });

  it('re-scaffolds given/args and clears stale results when the target vanishes on refresh', async () => {
    const nextCatalog: ScenarioCatalog = {
      targets: [
        {
          name: 'Invoice',
          operations: [{ name: 'issue', kind: 'command', params: [], returns: null }],
          fields: [{ name: 'total', type: 'Decimal', optional: false }],
        },
      ],
    };
    const container = document.createElement('div');
    const scenarioCatalog = vi.fn(async () => CATALOG);
    const lsp = mockLsp({ scenarioCatalog });
    const panel = createScenarioPanel({ container, lsp, platform: NO_EXEC });
    await panel.refresh();

    const [given, args] = Array.from(container.querySelectorAll<HTMLTextAreaElement>('.koi-scenario-json'));
    given.value = '{ "lines": [{ "quantity": 2 }], "status": "Draft" }';
    container.querySelector<HTMLButtonElement>('.koi-scenario-run')!.click();
    await flush();

    scenarioCatalog.mockResolvedValueOnce(nextCatalog);
    await panel.refresh();

    expect(JSON.parse(given.value)).toEqual({ total: 0 });
    expect(JSON.parse(args.value)).toEqual({});
    expect(container.querySelector('.koi-scenario-badge')).toBeNull();
  });

  it('shows an empty-state hint and disables Run when nothing is runnable', async () => {
    const container = document.createElement('div');
    const lsp = mockLsp({ scenarioCatalog: vi.fn(async () => ({ targets: [] })) });
    const panel = createScenarioPanel({ container, lsp, platform: NO_EXEC });
    await panel.refresh();

    expect(container.querySelector<HTMLButtonElement>('.koi-scenario-run')!.disabled).toBe(true);
    expect(container.querySelector('.koi-scenario-message.is-muted')).not.toBeNull();
  });

  it('has no axe violations', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = createScenarioPanel({ container, lsp: mockLsp(), platform: NO_EXEC });
    await panel.refresh();

    expect(await axe(container)).toHaveNoViolations();
    container.remove();
  });

  // --- executed mode (#236): opt-in, capability-gated, truthfully labelled ---------------
  describe('execute generated code', () => {
    it('offers the toggle only on a host that can execute', async () => {
      const browserish = document.createElement('div');
      await createScenarioPanel({ container: browserish, lsp: mockLsp(), platform: NO_EXEC }).refresh();
      expect(browserish.querySelector('.koi-scenario-execute')).toBeNull();

      const desktop = document.createElement('div');
      await createScenarioPanel({ container: desktop, lsp: mockLsp(), platform: CAN_EXEC }).refresh();
      const toggle = desktop.querySelector<HTMLInputElement>('.koi-scenario-execute-input')!;
      expect(toggle).not.toBeNull();
      expect(toggle.checked).toBe(false); // opt-in: default OFF
    });

    it('asks the backend to execute once the toggle is on', async () => {
      const container = document.createElement('div');
      const lsp = mockLsp();
      const panel = createScenarioPanel({ container, lsp, platform: CAN_EXEC });
      await panel.refresh();

      const toggle = container.querySelector<HTMLInputElement>('.koi-scenario-execute-input')!;
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));
      container.querySelector<HTMLButtonElement>('.koi-scenario-run')!.click();
      await flush();

      expect(lsp.runScenario).toHaveBeenCalledWith('Order', 'place', expect.any(Object), expect.any(Object), {
        execute: true,
      });
    });

    it('labels the result with the mode the backend actually used', async () => {
      const executed: ScenarioResult = { ...PLACED, mode: 'executed' };
      const container = document.createElement('div');
      const lsp = mockLsp({ runScenario: vi.fn(async () => executed) });
      const panel = createScenarioPanel({ container, lsp, platform: CAN_EXEC });
      await panel.refresh();

      container.querySelector<HTMLButtonElement>('.koi-scenario-run')!.click();
      await flush();

      const mode = container.querySelector('.koi-scenario-mode')!;
      expect(mode.classList.contains('is-executed')).toBe(true);
      expect(mode.textContent).toContain('Executed');
    });

    it('says "interpreted" when the host degraded the request, whatever the toggle asked for', async () => {
      // The desktop host can fail to execute (the model has errors, the sandbox child timed out); the
      // browser answers `interpreted` outright. Either way the label reports the ENGINE, not the ask.
      const degraded: ScenarioResult = { ...PLACED, notes: ['Execution is not available on this host…'] };
      const container = document.createElement('div');
      const lsp = mockLsp({ runScenario: vi.fn(async () => degraded) });
      const panel = createScenarioPanel({ container, lsp, platform: CAN_EXEC });
      await panel.refresh();

      const toggle = container.querySelector<HTMLInputElement>('.koi-scenario-execute-input')!;
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));
      container.querySelector<HTMLButtonElement>('.koi-scenario-run')!.click();
      await flush();

      const mode = container.querySelector('.koi-scenario-mode')!;
      expect(mode.classList.contains('is-interpreted')).toBe(true);
      expect(mode.textContent).toContain('Interpreted');
    });

    it('is a keyboard-operable checkbox with an accessible name, and stays axe-clean', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const panel = createScenarioPanel({ container, lsp: mockLsp(), platform: CAN_EXEC });
      await panel.refresh();

      const toggle = container.querySelector<HTMLInputElement>('.koi-scenario-execute-input')!;
      // A native checkbox in the tab order — Tab reaches it, Space toggles it, no ARIA needed.
      expect(toggle.type).toBe('checkbox');
      expect(toggle.tabIndex).toBe(0);
      expect(toggle.closest('label')?.textContent).toContain('Execute generated code (high fidelity)');
      toggle.focus();
      expect(document.activeElement).toBe(toggle);

      expect(await axe(container)).toHaveNoViolations();
      container.remove();
    });
  });
});
