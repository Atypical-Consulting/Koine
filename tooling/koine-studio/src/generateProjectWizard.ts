// "Generate Project" wizard: a multi-step assistant that turns the active model into a downloadable
// project archive. It reuses the shared modal chrome (overlay.ts) and the pure bundling core
// (generateProject.ts); all I/O is injected so the wizard stays decoupled from the LSP client and
// the host. Flow: pick a target language → choose artifacts → name the project → generate + save.
import { createModal } from './overlay';
import type { EmitPreviewResult } from './lsp';
import {
  buildProjectZip,
  canGenerate,
  defaultProjectName,
  isValidProjectName,
} from './generateProject';

type Target = 'csharp' | 'typescript';
type StatusKind = 'info' | 'error' | 'success';

/** Everything the wizard needs from the rest of the app, injected so it can be wired to any host. */
export interface GenerateProjectDeps {
  /** Compile the active model to the given target and return its emitted files / diagnostics. */
  emitPreview(target: Target): Promise<EmitPreviewResult>;
  /** The ubiquitous-language glossary for the active model, as markdown. */
  glossary(): Promise<{ markdown: string }>;
  /**
   * Save the generated archive bytes to a host destination (download / native save dialog).
   * Resolves `true` when the bytes were delivered and `false` when the user cancelled a native
   * save dialog, so the wizard only reports success on a real save.
   */
  saveZip(defaultName: string, data: Uint8Array): Promise<boolean>;
}

export interface GenerateProjectHandle {
  open(): void;
  close(): void;
}

// Steps, named so the navigation/render logic never hinges on bare magic numbers.
const STEP = { Language: 0, Artifacts: 1, Name: 2, Generate: 3 } as const;
const STEP_LABELS = ['Language', 'Artifacts', 'Name', 'Generate'] as const;
const LAST_STEP = STEP.Generate;
const NAME_ERR_ID = 'koi-gen-name-err';

const TARGETS: { value: Target; title: string; blurb: string }[] = [
  { value: 'csharp', title: 'C#', blurb: 'Idiomatic, self-contained .NET source (value objects, aggregates, CQRS, …).' },
  { value: 'typescript', title: 'TypeScript', blurb: 'The TypeScript emitter output for the same model.' },
];

interface WizardState {
  step: number;
  target: Target;
  includeCsproj: boolean;
  includeGlossary: boolean;
  projectName: string;
  nameEdited: boolean;
  preview: EmitPreviewResult | null;
  previewTarget: Target | null;
  busy: boolean;
  status: string | null; // transient banner text (progress / error / cancel)
  statusKind: StatusKind;
  done: boolean;
}

function initialState(): WizardState {
  return {
    step: STEP.Language,
    target: 'csharp',
    includeCsproj: true,
    includeGlossary: false,
    projectName: '',
    nameEdited: false,
    preview: null,
    previewTarget: null,
    busy: false,
    status: null,
    statusKind: 'info',
    done: false,
  };
}

/** Build the Generate-Project wizard once and return an imperative `{ open, close }` handle. */
export function createGenerateProject(deps: GenerateProjectDeps): GenerateProjectHandle {
  const modal = createModal({ title: 'Generate Project', ariaLabel: 'Generate a project from the model' });

  let state = initialState();
  // Synchronous re-entrancy guard: set before any await so a double-click on Next/Generate can't
  // start a second navigation or a second download.
  let navigating = false;
  // Session epoch: bumped on every open(). In-flight async work captures the epoch and discards its
  // result (no state mutation, no render) if the user closed + reopened the wizard meanwhile — the
  // pending closure would otherwise corrupt the fresh session's state.
  let epoch = 0;

  function setStatus(text: string, kind: StatusKind): void {
    state.status = text;
    state.statusKind = kind;
  }
  function clearStatus(): void {
    state.status = null;
    state.statusKind = 'info';
  }

  // --- chrome built once; content + status + footer re-rendered per state change -----
  const wizard = document.createElement('div');
  wizard.className = 'koi-wizard';

  const stepsEl = document.createElement('ol');
  stepsEl.className = 'koi-wizard-steps';
  stepsEl.setAttribute('aria-label', 'Progress');
  for (const label of STEP_LABELS) {
    const li = document.createElement('li');
    li.className = 'koi-wizard-step';
    li.textContent = label;
    stepsEl.appendChild(li);
  }

  // The visual status banner (shown/hidden freely) and a separate, always-present visually-hidden
  // live region. Announcements ride the persistent region — toggling a banner's `hidden`/`role` in
  // the same update that adds text is unreliable for screen readers.
  const statusBanner = document.createElement('p');
  statusBanner.className = 'koi-wizard-banner';
  statusBanner.hidden = true;

  const announcer = document.createElement('span');
  announcer.className = 'koi-sr-only';
  announcer.setAttribute('aria-live', 'polite');

  const contentEl = document.createElement('div');
  contentEl.className = 'koi-wizard-content';

  const footerEl = document.createElement('div');
  footerEl.className = 'koi-wizard-footer';

  wizard.append(stepsEl, statusBanner, announcer, contentEl, footerEl);
  modal.body.appendChild(wizard);

  // --- emit caching ---------------------------------------------------------
  // Compile the chosen target (once per target) so the Name step can default from the emitted
  // namespace and the Generate step can bundle without re-compiling. Surfaces emit failures as a
  // status banner; never throws to the caller.
  async function ensurePreview(): Promise<void> {
    if (state.preview && state.previewTarget === state.target) return;
    const myEpoch = epoch;
    const target = state.target; // capture: a switch mid-compile must not re-tag this result
    state.busy = true;
    setStatus('Compiling the model…', 'info');
    render();
    try {
      const res = await deps.emitPreview(target);
      if (myEpoch !== epoch) return; // wizard was closed + reopened — drop the stale result
      state.preview = res;
      state.previewTarget = target; // key by the compiled target, not the (possibly switched) live one
      if (res.error) setStatus('Emit error: ' + res.error, 'error');
      else if (!res.files.length) setStatus('No files were emitted — fix the model’s diagnostics first.', 'error');
      else clearStatus();
      if (!state.nameEdited) state.projectName = defaultProjectName(res.files);
    } catch (e) {
      if (myEpoch !== epoch) return;
      state.preview = null;
      state.previewTarget = null;
      setStatus('Compile request failed: ' + String(e), 'error');
    } finally {
      if (myEpoch === epoch) {
        state.busy = false;
        render();
      }
    }
  }

  // --- navigation -----------------------------------------------------------
  async function next(): Promise<void> {
    if (state.done) {
      modal.close();
      return;
    }
    if (state.busy || navigating) return;
    navigating = true;
    try {
      if (state.step === STEP.Generate) {
        await generate();
        return;
      }
      // Compile when leaving the Language step so Artifacts/Name/Generate reflect real output, and
      // hold the user here (don't advance) when the model can't emit.
      if (state.step === STEP.Language) {
        await ensurePreview();
        if (!state.preview || state.preview.error || !state.preview.files.length) {
          render();
          return;
        }
      }
      state.step = Math.min(state.step + 1, LAST_STEP);
      render();
    } finally {
      navigating = false;
    }
  }

  function back(): void {
    if (state.busy || state.step === STEP.Language) return;
    clearStatus();
    state.step -= 1;
    render();
  }

  async function generate(): Promise<void> {
    const myEpoch = epoch;
    await ensurePreview();
    if (myEpoch !== epoch) return;
    if (!state.preview || !canGenerate(state.preview, state.projectName)) {
      render();
      return;
    }
    state.busy = true;
    setStatus('Generating the archive…', 'info');
    render();
    try {
      let glossary: string | null = null;
      if (state.includeGlossary) {
        try {
          glossary = (await deps.glossary()).markdown;
        } catch {
          glossary = null; // a glossary failure shouldn't sink the whole download
        }
      }
      const bytes = await buildProjectZip(state.preview.files, {
        projectName: state.projectName,
        includeCsproj: state.target === 'csharp' && state.includeCsproj,
        glossary,
      });
      const saved = await deps.saveZip(`${state.projectName}.zip`, bytes);
      if (myEpoch !== epoch) return;
      if (saved) {
        state.done = true;
        clearStatus();
      } else {
        setStatus('Save cancelled — nothing was written.', 'info');
      }
    } catch (e) {
      if (myEpoch !== epoch) return;
      setStatus('Could not generate the project: ' + String(e), 'error');
    } finally {
      if (myEpoch === epoch) {
        state.busy = false;
        render();
      }
    }
  }

  // --- per-step content -----------------------------------------------------
  function buildLanguageStep(): HTMLElement {
    const group = document.createElement('div');
    group.className = 'koi-wizard-options';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Target language');
    for (const t of TARGETS) {
      const option = document.createElement('label');
      option.className = 'koi-wizard-option' + (state.target === t.value ? ' selected' : '');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'koi-gen-target';
      input.value = t.value;
      input.checked = state.target === t.value;
      input.disabled = state.busy; // can't switch target mid-compile (closes the stale-result race)
      input.addEventListener('change', () => {
        if (state.busy || state.target === t.value) return;
        state.target = t.value;
        // A new target invalidates the cached emit (and the C#-only csproj toggle).
        state.preview = null;
        state.previewTarget = null;
        clearStatus();
        render();
        // Re-rendering replaced the radio the user just operated; keep focus on the selection.
        contentEl
          .querySelector<HTMLInputElement>(`input[name="koi-gen-target"][value="${t.value}"]`)
          ?.focus();
      });
      const text = document.createElement('span');
      text.className = 'koi-wizard-option-text';
      const title = document.createElement('span');
      title.className = 'koi-wizard-option-title';
      title.textContent = t.title;
      const blurb = document.createElement('span');
      blurb.className = 'koi-wizard-option-blurb';
      blurb.textContent = t.blurb;
      text.append(title, blurb);
      option.append(input, text);
      group.appendChild(option);
    }
    return group;
  }

  function checkboxRow(opts: {
    label: string;
    checked: boolean;
    disabled?: boolean;
    hint?: string;
    onToggle?: (checked: boolean) => void;
  }): HTMLElement {
    const row = document.createElement('label');
    row.className = 'koi-wizard-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'koi-checkbox';
    input.checked = opts.checked;
    if (opts.disabled) input.disabled = true;
    if (opts.onToggle) input.addEventListener('change', () => opts.onToggle!(input.checked));
    const text = document.createElement('span');
    text.className = 'koi-wizard-check-text';
    const label = document.createElement('span');
    label.className = 'koi-wizard-check-label';
    label.textContent = opts.label;
    text.appendChild(label);
    if (opts.hint) {
      const hint = document.createElement('span');
      hint.className = 'koi-wizard-check-hint';
      hint.textContent = opts.hint;
      text.appendChild(hint);
    }
    row.append(input, text);
    return row;
  }

  function buildArtifactsStep(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'koi-wizard-checks';
    wrap.appendChild(
      checkboxRow({ label: 'Source files', checked: true, disabled: true, hint: 'Always included — the emitted source tree.' }),
    );
    if (state.target === 'csharp') {
      wrap.appendChild(
        checkboxRow({
          label: 'Project file (.csproj)',
          checked: state.includeCsproj,
          hint: 'A minimal net10.0 SDK-style project so the output builds as-is.',
          onToggle: (c) => {
            state.includeCsproj = c;
          },
        }),
      );
    }
    wrap.appendChild(
      checkboxRow({
        label: 'Ubiquitous-language glossary (glossary.md)',
        checked: state.includeGlossary,
        hint: 'The model’s glossary as Markdown documentation.',
        onToggle: (c) => {
          state.includeGlossary = c;
        },
      }),
    );
    return wrap;
  }

  function buildNameStep(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'koi-wizard-name';

    const labelEl = document.createElement('label');
    labelEl.className = 'koi-field-label';
    labelEl.textContent = 'Project name';
    labelEl.htmlFor = 'koi-gen-name';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'koi-gen-name';
    input.className = 'koi-input';
    input.value = state.projectName;
    input.autocomplete = 'off';
    input.spellcheck = false;

    const hint = document.createElement('p');
    hint.className = 'koi-wizard-hint';
    hint.textContent = 'Names the archive’s root folder, the .csproj, and the root namespace.';

    const invalid = document.createElement('p');
    invalid.id = NAME_ERR_ID;
    invalid.className = 'koi-wizard-invalid';
    invalid.textContent = 'Use a letter or underscore, then letters, digits, underscores, or dots.';

    // Reflect validity into the field's a11y attributes; describe the field by the error only while
    // the error is actually showing.
    function applyNameValidity(): void {
      const valid = isValidProjectName(state.projectName);
      invalid.hidden = valid;
      input.setAttribute('aria-invalid', String(!valid));
      if (valid) input.removeAttribute('aria-describedby');
      else input.setAttribute('aria-describedby', NAME_ERR_ID);
    }
    applyNameValidity();

    input.addEventListener('input', () => {
      state.projectName = input.value;
      state.nameEdited = true;
      applyNameValidity();
      refreshFooter(); // single source of truth for the Next button's enabled state
    });
    // Enter advances when the name is valid.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && isValidProjectName(state.projectName)) {
        e.preventDefault();
        void next();
      }
    });

    wrap.append(labelEl, input, hint, invalid);
    return wrap;
  }

  function summaryRow(label: string, value: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'koi-wizard-summary-row';
    const k = document.createElement('span');
    k.className = 'koi-wizard-summary-key';
    k.textContent = label;
    const v = document.createElement('span');
    v.className = 'koi-wizard-summary-val';
    v.textContent = value;
    row.append(k, v);
    return row;
  }

  function buildGenerateStep(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'koi-wizard-generate';

    const artifacts: string[] = ['Source files'];
    if (state.target === 'csharp' && state.includeCsproj) artifacts.push('.csproj');
    if (state.includeGlossary) artifacts.push('glossary.md');

    const targetLabel = TARGETS.find((t) => t.value === state.target)?.title ?? state.target;
    wrap.appendChild(summaryRow('Language', targetLabel));
    wrap.appendChild(summaryRow('Project name', state.projectName));
    wrap.appendChild(summaryRow('Artifacts', artifacts.join(', ')));
    if (state.preview && !state.preview.error) {
      wrap.appendChild(summaryRow('Source files', String(state.preview.files.length)));
    }
    return wrap;
  }

  // --- footer ---------------------------------------------------------------
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'koi-wizard-btn';
  backBtn.textContent = 'Back';
  backBtn.addEventListener('click', () => back());

  const primaryBtn = document.createElement('button');
  primaryBtn.type = 'button';
  primaryBtn.className = 'koi-wizard-btn primary';
  primaryBtn.addEventListener('click', () => void next());

  footerEl.append(backBtn, primaryBtn);

  function refreshFooter(): void {
    // `navigating` is a re-entrancy guard, not a UI-busy signal — leave it out of disabled state, or
    // the post-navigation render (which runs before `navigating` is cleared) strands Back disabled.
    backBtn.disabled = state.busy || state.step === STEP.Language;
    backBtn.hidden = state.done;

    if (state.done) {
      primaryBtn.textContent = 'Close';
      primaryBtn.disabled = false;
      return;
    }
    if (state.step === STEP.Generate) {
      primaryBtn.textContent = 'Generate';
      const ready = !!state.preview && canGenerate(state.preview, state.projectName);
      primaryBtn.disabled = state.busy || !ready;
    } else {
      primaryBtn.textContent = 'Next';
      const nameOk = state.step !== STEP.Name || isValidProjectName(state.projectName);
      primaryBtn.disabled = state.busy || !nameOk;
    }
  }

  // --- status / success banner + live region --------------------------------
  function refreshStatus(): void {
    const text = state.done ? `${state.projectName}.zip is ready.` : state.status;
    const kind: StatusKind = state.done ? 'success' : state.statusKind;
    if (!text) {
      statusBanner.hidden = true;
      statusBanner.textContent = '';
      statusBanner.className = 'koi-wizard-banner';
      announcer.textContent = '';
      return;
    }
    statusBanner.hidden = false;
    statusBanner.className = 'koi-wizard-banner' + (kind === 'success' ? ' success' : kind === 'error' ? ' error' : '');
    statusBanner.textContent = text;
    // Announce via the persistent live region (the ✓ on success is CSS-only, so it isn't spoken).
    announcer.textContent = text;
  }

  // --- render ---------------------------------------------------------------
  function render(): void {
    // Step indicator.
    const steps = Array.from(stepsEl.children) as HTMLElement[];
    steps.forEach((li, i) => {
      const active = i === state.step && !state.done;
      li.classList.toggle('active', active);
      li.classList.toggle('done', i < state.step || state.done);
      if (active) li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
    });

    refreshStatus();

    // Content.
    contentEl.innerHTML = '';
    let body: HTMLElement;
    if (state.step === STEP.Language) body = buildLanguageStep();
    else if (state.step === STEP.Artifacts) body = buildArtifactsStep();
    else if (state.step === STEP.Name) body = buildNameStep();
    else body = buildGenerateStep();
    contentEl.appendChild(body);

    refreshFooter();

    // Keep keyboard users oriented inside the name field.
    if (state.step === STEP.Name && !state.done) {
      const nameInput = contentEl.querySelector<HTMLInputElement>('#koi-gen-name');
      nameInput?.focus();
      nameInput?.select();
    }
  }

  modal.onOpen(() => {
    epoch++; // invalidate any async work still in flight from a previous session
    state = initialState();
    navigating = false;
    render();
  });

  return { open: modal.open, close: modal.close };
}
