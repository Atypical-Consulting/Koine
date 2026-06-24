// The interactive scenario runner panel (#149). It lets a modeller exercise the domain without
// leaving Studio: pick an aggregate command/factory, supply a starting state and arguments, run it,
// and read the `command → events → invariant-checks` timeline. It is backend-agnostic — the two LSP
// calls it makes (`scenarioCatalog`, `runScenario`) route to the CLI `koine lsp` child or the
// in-browser WASM export identically (see lsp.ts). Pure native DOM + the shared `--koi-*` tokens,
// matching the other panels (e.g. ai/aiPanel.ts).

import type { KoineLsp } from '@/lsp/lsp';
import type {
  ScenarioCatalog,
  ScenarioField,
  ScenarioInvariantCheck,
  ScenarioOperation,
  ScenarioResult,
  ScenarioStep,
  ScenarioTarget,
} from '@/lsp/protocol';

/** Just the LSP surface the panel needs — keeps it trivially mockable in tests. */
export type ScenarioLsp = Pick<KoineLsp, 'scenarioCatalog' | 'runScenario'>;

export interface ScenarioPanelOptions {
  container: HTMLElement;
  lsp: ScenarioLsp;
  /** Optional status-bar nudge (mirrors the other panels' setStatus injection). */
  setStatus?: (message: string) => void;
}

export interface ScenarioPanel {
  /** Reload the runnable catalog (call on tab open and after a model edit). */
  refresh(): Promise<void>;
}

const OUTCOME_ICON: Record<string, string> = { passed: '✓', failed: '✗', indeterminate: '?' };

export function createScenarioPanel(opts: ScenarioPanelOptions): ScenarioPanel {
  const { container, lsp } = opts;
  container.classList.add('koi-scenario');
  container.replaceChildren();

  let catalog: ScenarioCatalog = { targets: [] };

  // --- chrome -------------------------------------------------------------
  const intro = h('p', 'koi-scenario-intro');
  intro.textContent =
    'Exercise the domain: pick an aggregate command, give it a starting state and arguments, and ' +
    'run it to see the events it emits and whether the invariants still hold.';

  const controls = h('div', 'koi-scenario-controls');

  const targetSelect = document.createElement('select');
  targetSelect.className = 'koi-scenario-target';
  const targetField = labelled('Aggregate / entity', targetSelect);

  const opSelect = document.createElement('select');
  opSelect.className = 'koi-scenario-op';
  const opField = labelled('Command / factory', opSelect);

  const refreshBtn = button('Refresh', 'koi-scenario-refresh');
  refreshBtn.title = 'Reload the runnable commands from the current model';

  controls.append(targetField, opField, refreshBtn);

  const givenArea = document.createElement('textarea');
  givenArea.className = 'koi-scenario-json';
  givenArea.rows = 6;
  givenArea.spellcheck = false;
  givenArea.setAttribute('aria-label', 'Given state as JSON');
  const givenField = labelled('Given state (JSON)', givenArea);

  const argsArea = document.createElement('textarea');
  argsArea.className = 'koi-scenario-json';
  argsArea.rows = 3;
  argsArea.spellcheck = false;
  argsArea.setAttribute('aria-label', 'Arguments as JSON');
  const argsField = labelled('Arguments (JSON)', argsArea);

  const runBtn = button('Run scenario', 'koi-scenario-run koi-scenario-run-primary');

  const results = h('div', 'koi-scenario-results');
  results.setAttribute('role', 'status');
  results.setAttribute('aria-live', 'polite');

  container.append(intro, controls, givenField, argsField, runBtn, results);

  // --- behaviour ----------------------------------------------------------

  function currentTarget(): ScenarioTarget | undefined {
    return catalog.targets.find((t) => t.name === targetSelect.value);
  }

  function currentOperation(): ScenarioOperation | undefined {
    return currentTarget()?.operations.find((o) => o.name === opSelect.value);
  }

  function populateTargets(): void {
    const previous = targetSelect.value;
    targetSelect.replaceChildren();
    for (const t of catalog.targets) {
      targetSelect.append(option(t.name, t.name));
    }
    // Keep the prior selection if it survived the refresh; otherwise select the first target explicitly
    // (don't rely on the implicit first-option default, which not every DOM honours).
    targetSelect.value = catalog.targets.some((t) => t.name === previous)
      ? previous
      : (catalog.targets[0]?.name ?? '');
    populateOperations(true);
  }

  // Rebuild the operation dropdown for the current target. `rescaffoldGiven` is true only when the
  // target itself changed (new fields ⇒ new given-state shape); switching the operation alone keeps the
  // given-state the user entered and only re-scaffolds the args.
  function populateOperations(rescaffoldGiven: boolean): void {
    const previous = opSelect.value;
    opSelect.replaceChildren();
    const target = currentTarget();
    const ops = target?.operations ?? [];
    for (const o of ops) {
      opSelect.append(option(o.name, `${o.name} (${o.kind})`));
    }
    opSelect.value = ops.some((o) => o.name === previous) ? previous : (ops[0]?.name ?? '');
    if (rescaffoldGiven) scaffoldGiven();
    scaffoldArgs();
  }

  // Prefill the given-state editor with the selected target's fields, so the user edits a shape rather
  // than typing one from scratch. Called on a target change (and the initial load).
  function scaffoldGiven(): void {
    const target = currentTarget();
    if (target) givenArea.value = JSON.stringify(scaffoldFields(target.fields), null, 2);
  }

  // Prefill the args editor with the selected operation's parameters. Called on a target or operation change.
  function scaffoldArgs(): void {
    const op = currentOperation();
    argsArea.value = op && op.params.length > 0 ? JSON.stringify(scaffoldParams(op.params), null, 2) : '{}';
  }

  function disabled(): boolean {
    return catalog.targets.length === 0;
  }

  function syncEnabled(): void {
    const off = disabled();
    targetSelect.disabled = off;
    opSelect.disabled = off;
    runBtn.disabled = off;
    givenArea.disabled = off;
    argsArea.disabled = off;
  }

  async function refresh(): Promise<void> {
    let loadError: string | null = null;
    try {
      catalog = await lsp.scenarioCatalog();
    } catch (e) {
      catalog = { targets: [] };
      loadError = errorText(e);
    }
    populateTargets();
    syncEnabled();
    if (loadError) {
      renderMessage(`Could not load the scenario catalog: ${loadError}`, 'error');
    } else if (disabled()) {
      renderMessage('No runnable commands found. Add a command or factory to an aggregate, then refresh.', 'muted');
    } else {
      results.replaceChildren();
    }
  }

  async function run(): Promise<void> {
    const target = currentTarget();
    const op = currentOperation();
    if (!target || !op) {
      renderMessage('Pick an aggregate and a command first.', 'muted');
      return;
    }

    let given: Record<string, unknown>;
    let args: Record<string, unknown>;
    try {
      given = parseObject(givenArea.value, 'Given state');
      args = parseObject(argsArea.value, 'Arguments');
    } catch (e) {
      renderMessage(errorText(e), 'error');
      return;
    }

    runBtn.disabled = true;
    opts.setStatus?.(`Running ${target.name}.${op.name}…`);
    try {
      const result = await lsp.runScenario(target.name, op.name, given, args);
      renderResult(result);
      opts.setStatus?.(result.ok ? `${target.name}.${op.name} ran` : `${target.name}.${op.name} was rejected`);
    } catch (e) {
      renderMessage(`The scenario failed to run: ${errorText(e)}`, 'error');
    } finally {
      runBtn.disabled = disabled();
    }
  }

  targetSelect.addEventListener('change', () => populateOperations(true));
  opSelect.addEventListener('change', scaffoldArgs);
  refreshBtn.addEventListener('click', () => void refresh());
  runBtn.addEventListener('click', () => void run());

  // --- rendering ----------------------------------------------------------

  function renderResult(result: ScenarioResult): void {
    results.replaceChildren();

    const badge = h('div', `koi-scenario-badge ${result.ok ? 'is-ok' : 'is-rejected'}`);
    badge.textContent = result.ok
      ? `${result.target}.${result.operation} ran`
      : `${result.target}.${result.operation} was rejected`;
    results.append(badge);

    if (result.steps.length > 0) {
      results.append(sectionTitle('Timeline'));
      const timeline = h('ul', 'koi-scenario-timeline');
      for (const step of result.steps) timeline.append(renderStep(step));
      results.append(timeline);
    }

    const stateKeys = Object.keys(result.resultingState);
    if (stateKeys.length > 0) {
      results.append(sectionTitle('Resulting state'));
      const dl = h('dl', 'koi-scenario-state');
      for (const key of stateKeys) {
        const dt = h('dt');
        dt.textContent = key;
        const dd = h('dd');
        dd.textContent = result.resultingState[key];
        dl.append(dt, dd);
      }
      results.append(dl);
    }

    if (result.result !== null) {
      const r = h('p', 'koi-scenario-return');
      r.textContent = `result = ${result.result}`;
      results.append(r);
    }

    if (result.invariants.length > 0) {
      results.append(sectionTitle('Invariants'));
      const list = h('ul', 'koi-scenario-invariants');
      for (const inv of result.invariants) list.append(renderInvariant(inv));
      results.append(list);
    }

    if (result.notes.length > 0) {
      results.append(sectionTitle('Notes'));
      const notes = h('ul', 'koi-scenario-notes');
      for (const note of result.notes) {
        const li = h('li');
        li.textContent = note;
        notes.append(li);
      }
      results.append(notes);
    }
  }

  function renderStep(step: ScenarioStep): HTMLElement {
    const li = h('li', `koi-scenario-step koi-scenario-step-${step.kind}`);
    switch (step.kind) {
      case 'requires': {
        li.classList.add(`is-${step.outcome}`);
        const icon = h('span', 'koi-scenario-icon');
        icon.textContent = OUTCOME_ICON[step.outcome] ?? '?';
        const text = h('span', 'koi-scenario-step-text');
        text.textContent = step.message ?? step.condition;
        li.append(icon, text, codeChip(step.condition));
        break;
      }
      case 'transition': {
        const text = h('span', 'koi-scenario-step-text');
        text.textContent = step.isInitialization
          ? `${step.field} ← ${step.to}`
          : `${step.field}: ${step.from ?? '∅'} → ${step.to}`;
        li.append(tag('set'), text);
        break;
      }
      case 'emit': {
        const text = h('span', 'koi-scenario-step-text');
        text.textContent = step.event;
        li.append(tag('event'), text);
        const argEntries = Object.entries(step.args);
        if (argEntries.length > 0) {
          const chips = h('span', 'koi-scenario-args');
          for (const [k, v] of argEntries) chips.append(codeChip(`${k}: ${v}`));
          li.append(chips);
        }
        break;
      }
      case 'result': {
        const text = h('span', 'koi-scenario-step-text');
        text.textContent = `result = ${step.value}`;
        li.append(tag('result'), text);
        break;
      }
    }
    return li;
  }

  function renderInvariant(inv: ScenarioInvariantCheck): HTMLElement {
    const li = h('li', `koi-scenario-invariant is-${inv.outcome}`);
    const icon = h('span', 'koi-scenario-icon');
    icon.textContent = OUTCOME_ICON[inv.outcome] ?? '?';
    const text = h('span', 'koi-scenario-step-text');
    text.textContent = inv.message ?? inv.condition;
    li.append(icon, text, codeChip(inv.condition));
    return li;
  }

  function renderMessage(message: string, kind: 'muted' | 'error'): void {
    results.replaceChildren();
    const p = h('p', `koi-scenario-message is-${kind}`);
    p.textContent = message;
    results.append(p);
  }

  // The first catalog load is driven by the caller via refresh() when the tab is first shown (the
  // controller's ensureTechLoaded), so the panel does not self-fetch on construction — that would
  // double-fetch and race the caller's refresh.
  return { refresh };
}

// --- small DOM + value helpers -------------------------------------------

function h<K extends keyof HTMLElementTagNameMap>(tagName: K, className?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tagName);
  if (className) el.className = className;
  return el;
}

function button(text: string, className: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = text;
  return b;
}

function option(value: string, label: string): HTMLOptionElement {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  return o;
}

function labelled(text: string, control: HTMLElement): HTMLLabelElement {
  const label = document.createElement('label');
  label.className = 'koi-scenario-field';
  const span = h('span', 'koi-scenario-field-label');
  span.textContent = text;
  label.append(span, control);
  return label;
}

function sectionTitle(text: string): HTMLElement {
  const el = h('h3', 'koi-scenario-section');
  el.textContent = text;
  return el;
}

function codeChip(text: string): HTMLElement {
  const el = h('code', 'koi-scenario-chip');
  el.textContent = text;
  return el;
}

function tag(text: string): HTMLElement {
  const el = h('span', `koi-scenario-tag koi-scenario-tag-${text}`);
  el.textContent = text;
  return el;
}

/** A placeholder value for a field/param of a given declared type, for the JSON scaffold. */
function scaffoldValue(type: string, optional: boolean): unknown {
  if (optional) return null;
  if (type.startsWith('List<') || type.startsWith('Set<')) return [];
  if (type.startsWith('Map<')) return {};
  if (type === 'Int' || type === 'Decimal') return 0;
  if (type === 'Bool') return false;
  return '';
}

function scaffoldFields(fields: ScenarioField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f.name] = scaffoldValue(f.type, f.optional);
  return out;
}

function scaffoldParams(params: { name: string; type: string }[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of params) out[p.name] = scaffoldValue(p.type, false);
  return out;
}

function parseObject(text: string, what: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    throw new Error(`${what} is not valid JSON.`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${what} must be a JSON object (e.g. { "field": value }).`);
  }
  return value as Record<string, unknown>;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
