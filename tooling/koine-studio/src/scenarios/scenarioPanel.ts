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
  ScenarioMode,
  ScenarioOperation,
  ScenarioResult,
  ScenarioStep,
  ScenarioTarget,
} from '@/lsp/protocol';
import type { Platform } from '@/host/types';

/** Just the LSP surface the panel needs — keeps it trivially mockable in tests. */
export type ScenarioLsp = Pick<KoineLsp, 'scenarioCatalog' | 'runScenario'>;

/** Just the host capabilities the panel needs (same narrowing idiom as {@link ScenarioLsp}): whether
 *  this host can run the model's emitted code, which is what the executed-mode toggle is gated on. */
export type ScenarioHost = Pick<Platform, 'supportsScenarioExecution'>;

export interface ScenarioPanelOptions {
  container: HTMLElement;
  lsp: ScenarioLsp;
  /** The host platform — asked (never the platform `kind`) whether to offer executed mode (#236). */
  platform: ScenarioHost;
}

export interface ScenarioPanel {
  /** Reload the runnable catalog (call on tab open and after a model edit). */
  refresh(): Promise<void>;
}

const OUTCOME_ICON: Record<string, string> = { passed: '✓', failed: '✗', indeterminate: '?' };

/**
 * How each engine (#236) is labelled on a result, and what that label promises.
 *
 * The promise is OUTCOME-aware, because `mode` alone does not carry one. Every failure on the execution
 * path is reported as `executed` — including ones where nothing was ever emitted, compiled or run (the
 * model has errors, the sandbox child could not be started, the deadline expired). That label is
 * defensible — nothing was interpreted — but "every value shown was really computed" would be a plain
 * falsehood on those runs, so a not-ok result gets wording that claims only what happened.
 */
const MODE_LABEL: Record<ScenarioMode, { text: string; ok: string; failed: string }> = {
  executed: {
    text: 'Executed',
    ok: "Ran this model's generated code, so every value shown was really computed.",
    failed: 'Execution was attempted; this run did not produce values — see the notes below.',
  },
  interpreted: {
    text: 'Interpreted',
    ok: 'Reasoned about the model without running it — a value the interpreter cannot evaluate stays ?.',
    failed:
      'Reasoned about the model without running it; this run did not complete — see the notes below.',
  },
};

export function createScenarioPanel(opts: ScenarioPanelOptions): ScenarioPanel {
  const { container, lsp, platform } = opts;
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

  // Executed mode (#236) is opt-in AND capability-gated: running the model's generated code means
  // emitting, compiling and running it in a sandboxed child process (ADR 0011), which a browser tab has
  // no way to spawn — so the toggle exists only on a host that says it can execute. A plain native
  // checkbox in its own `<label>` (in the tab order, Space-toggled, named by its own text). It defaults
  // OFF, and the choice lives in the checkbox for the session only — the panel is built once and reused,
  // and nothing is written to the settings.
  const execute = platform.supportsScenarioExecution ? executeToggle() : null;

  const runBtn = button('Run scenario', 'koi-scenario-run koi-scenario-run-primary');

  const results = h('div', 'koi-scenario-results');
  results.setAttribute('role', 'status');
  results.setAttribute('aria-live', 'polite');

  container.append(intro, controls, givenField, argsField, ...(execute ? [execute.field] : []), runBtn, results);

  // --- behaviour ----------------------------------------------------------

  function currentTarget(): ScenarioTarget | undefined {
    return catalog.targets.find((t) => t.name === targetSelect.value);
  }

  function currentOperation(): ScenarioOperation | undefined {
    return currentTarget()?.operations.find((o) => o.name === opSelect.value);
  }

  // Rebuild both dropdowns from the catalog, keeping the prior selections when they survive.
  // Returns whether the effective target/operation selection changed, so refresh() can leave the
  // user's hand-edited JSON and the last run's results alone when it didn't.
  function populateTargets(): boolean {
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
    const targetChanged = targetSelect.value !== previous;
    return populateOperations(targetChanged) || targetChanged;
  }

  // Rebuild the operation dropdown for the current target. `rescaffoldGiven` is true only when the
  // target itself changed (new fields ⇒ new given-state shape); switching the operation alone keeps the
  // given-state the user entered and only re-scaffolds the args — and a refresh that keeps both
  // selections re-scaffolds nothing. Returns whether the operation selection changed.
  function populateOperations(rescaffoldGiven: boolean): boolean {
    const previous = opSelect.value;
    opSelect.replaceChildren();
    const target = currentTarget();
    const ops = target?.operations ?? [];
    for (const o of ops) {
      opSelect.append(option(o.name, `${o.name} (${o.kind})`));
    }
    opSelect.value = ops.some((o) => o.name === previous) ? previous : (ops[0]?.name ?? '');
    const opChanged = opSelect.value !== previous;
    if (rescaffoldGiven) scaffoldGiven();
    if (rescaffoldGiven || opChanged) scaffoldArgs();
    return opChanged;
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
    if (execute) execute.input.disabled = off;
  }

  async function refresh(): Promise<void> {
    let loadError: string | null = null;
    try {
      catalog = await lsp.scenarioCatalog();
    } catch (e) {
      catalog = { targets: [] };
      loadError = errorText(e);
    }
    const selectionChanged = populateTargets();
    syncEnabled();
    if (loadError) {
      renderMessage(`Could not load the scenario catalog: ${loadError}`, 'error');
    } else if (disabled()) {
      renderMessage('No runnable commands found. Add a command or factory to an aggregate, then refresh.', 'muted');
    } else if (selectionChanged) {
      // The last run's timeline belongs to a selection that no longer exists — clear it. A refresh
      // that keeps the same target + operation (e.g. re-showing the tab) leaves the results in place.
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
    try {
      // Asking to execute is a REQUEST, not a promise: the backend may still answer with the
      // interpreter (it can't execute, the model has errors, the sandbox timed out), and the rendered
      // label reads the result's own `mode` rather than what was asked here.
      const result = await lsp.runScenario(target.name, op.name, given, args, {
        execute: execute?.input.checked ?? false,
      });
      renderResult(result);
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

    // The timeline's header: what happened, and — truthfully — which engine produced it. The mode comes
    // from the RESULT, so a run that asked to execute but was answered by the interpreter says so.
    const header = h('div', 'koi-scenario-result-header');
    const badge = h('div', `koi-scenario-badge ${result.ok ? 'is-ok' : 'is-rejected'}`);
    badge.textContent = result.ok
      ? `${result.target}.${result.operation} ran`
      : `${result.target}.${result.operation} was rejected`;
    header.append(badge, modeChip(result.mode, result.ok));
    results.append(header);

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

/**
 * The executed-mode opt-in (#236): a native checkbox wrapped in its own `<label>`, so it is keyboard-
 * operable and named by its text with no ARIA at all. Returns both halves — the field to mount, and the
 * input whose `checked` is read at run time (the panel keeps no parallel copy of the state).
 */
function executeToggle(): { field: HTMLLabelElement; input: HTMLInputElement } {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'koi-scenario-execute-input';
  const field = document.createElement('label');
  field.className = 'koi-scenario-execute';
  field.title =
    "Compiles and runs this model's generated code in a sandboxed child process instead of " +
    'interpreting it — slower, but derived values are really computed rather than left indeterminate.';
  const text = h('span', 'koi-scenario-execute-label');
  text.textContent = 'Execute generated code (high fidelity)';
  field.append(input, text);
  return { field, input };
}

/** The engine that produced a result, as a chip on the timeline header — see {@link MODE_LABEL}. */
function modeChip(mode: ScenarioMode, ok: boolean): HTMLElement {
  // `mode` crosses the wire as JSON, so a value a mismatched backend invents is read as the
  // conservative `interpreted` rather than rendering `undefined` under an invented class. An explicit
  // comparison rather than `mode in MODE_LABEL`: `in` walks the PROTOTYPE chain, so a backend answering
  // `"mode": "toString"` would pass the check and then render the literal string "undefined".
  const known: ScenarioMode = mode === 'executed' ? 'executed' : 'interpreted';
  const el = h('span', `koi-scenario-mode is-${known}`);
  el.textContent = MODE_LABEL[known].text;
  // The tooltip is what the label PROMISES, and a failed run promises less — see MODE_LABEL.
  el.title = ok ? MODE_LABEL[known].ok : MODE_LABEL[known].failed;
  return el;
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
