// "Generate Project" wizard as a Preact component (#991 Task 2). A multi-step assistant that turns the
// active model into a downloadable project archive: pick a target language → choose artifacts → name the
// project → generate + save. It reuses the shared modal chrome (koine-ui's createModal, wired by the
// `createGenerateProject` facade in generateProjectWizard.ts) and the pure bundling core
// (generateProject.ts); all I/O is injected via `GenerateProjectDeps` so the wizard stays decoupled from
// the LSP client and the host.
//
// The imperative predecessor's `WizardState` maps 1:1 onto `useReducer`; its session `epoch` (invalidating
// in-flight async after a close+reopen) becomes a per-instance `aliveRef` — the facade remounts the
// component with a fresh `key` on every open, so the previous session's component unmounts, its `aliveRef`
// flips false, and any pending emit/generate discards its stale result on resume. The `navigating`
// re-entrancy guard stays a ref; per-step JSX replaces the `contentEl.innerHTML=''` rebuild, so keyed
// reconciliation keeps focus without the old manual focus-repair after every wipe.
import { render } from 'preact';
import { useEffect, useReducer, useRef } from 'preact/hooks';
import type { EmitPreviewResult } from '@/lsp/lsp';
import {
  buildProjectZip,
  canGenerate,
  defaultProjectName,
  isValidProjectName,
} from '@/export/generateProject';
import { EMIT_TARGETS } from '@/shared/emitTargets';

/** An emit-target id. A plain `string` so a backend-only target needs no front-end type edit. */
export type Target = string;
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

// Steps, named so the navigation/render logic never hinges on bare magic numbers.
const STEP = { Language: 0, Artifacts: 1, Name: 2, Generate: 3 } as const;
const STEP_LABELS = ['Language', 'Artifacts', 'Name', 'Generate'] as const;
const LAST_STEP = STEP.Generate;
const NAME_ERR_ID = 'koi-gen-name-err';

// Per-target marketing blurb shown on each language card. This prose genuinely lives in the front-end
// (it isn't backend metadata), so it's keyed by target id and looked up; a backend-only target with no
// blurb still appears, just without a description.
const TARGET_BLURBS: Record<string, string> = {
  csharp: 'Idiomatic, self-contained .NET source (value objects, aggregates, CQRS, …).',
  typescript: 'The TypeScript emitter output for the same model.',
  python: 'Python dataclasses and protocols for the same model.',
  php: 'Typed PHP classes for the same model.',
  rust: 'An idiomatic Rust crate (structs, Result-returning constructors, traits) for the same model.',
};

/**
 * The wizard's language cards, built from the LIVE EMIT_TARGETS (seeded from the backend at boot,
 * issue #282) so a registry target appears here with no edit; id/title come from the shared list and
 * the blurb is looked up by id. Read at wizard-render time (a function, not a module-load snapshot).
 */
export function wizardTargets(): { value: Target; title: string; blurb: string }[] {
  return EMIT_TARGETS.map((t) => ({
    value: t.id,
    title: t.displayName,
    blurb: TARGET_BLURBS[t.id] ?? '',
  }));
}

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

type Action =
  | { type: 'compileStart' }
  | { type: 'compileDone'; target: Target; res: EmitPreviewResult }
  | { type: 'compileFailed'; error: string }
  | { type: 'advance' }
  | { type: 'back' }
  | { type: 'selectTarget'; target: Target }
  | { type: 'setCsproj'; value: boolean }
  | { type: 'setGlossary'; value: boolean }
  | { type: 'setName'; value: string }
  | { type: 'generateStart' }
  | { type: 'generateDone' }
  | { type: 'saveCancelled' }
  | { type: 'generateError'; error: string };

type Dispatch = (action: Action) => void;

function reducer(s: WizardState, a: Action): WizardState {
  switch (a.type) {
    case 'compileStart':
      return { ...s, busy: true, status: 'Compiling the model…', statusKind: 'info' };
    case 'compileDone': {
      const res = a.res;
      let status: string | null;
      let statusKind: StatusKind;
      if (res.error) {
        status = 'Emit error: ' + res.error;
        statusKind = 'error';
      } else if (!res.files.length) {
        status = 'No files were emitted — fix the model’s diagnostics first.';
        statusKind = 'error';
      } else {
        status = null;
        statusKind = 'info';
      }
      // key by the compiled target, not the (possibly switched) live one
      return {
        ...s,
        busy: false,
        preview: res,
        previewTarget: a.target,
        status,
        statusKind,
        projectName: s.nameEdited ? s.projectName : defaultProjectName(res.files),
      };
    }
    case 'compileFailed':
      return {
        ...s,
        busy: false,
        preview: null,
        previewTarget: null,
        status: 'Compile request failed: ' + a.error,
        statusKind: 'error',
      };
    case 'advance':
      return { ...s, step: Math.min(s.step + 1, LAST_STEP) };
    case 'back':
      return { ...s, step: s.step - 1, status: null, statusKind: 'info' };
    case 'selectTarget':
      // A new target invalidates the cached emit (and the C#-only csproj toggle).
      return { ...s, target: a.target, preview: null, previewTarget: null, status: null, statusKind: 'info' };
    case 'setCsproj':
      return { ...s, includeCsproj: a.value };
    case 'setGlossary':
      return { ...s, includeGlossary: a.value };
    case 'setName':
      return { ...s, projectName: a.value, nameEdited: true };
    case 'generateStart':
      return { ...s, busy: true, status: 'Generating the archive…', statusKind: 'info' };
    case 'generateDone':
      return { ...s, busy: false, done: true, status: null, statusKind: 'info' };
    case 'saveCancelled':
      return { ...s, busy: false, status: 'Save cancelled — nothing was written.', statusKind: 'info' };
    case 'generateError':
      return { ...s, busy: false, status: 'Could not generate the project: ' + a.error, statusKind: 'error' };
    default:
      return s;
  }
}

export function GenerateProjectWizard(props: { deps: GenerateProjectDeps; onClose: () => void }) {
  const { deps, onClose } = props;
  const [state, dispatch] = useReducer(reducer, undefined, initialState);

  // The authoritative snapshot for async handlers: refreshed every render so a handler resuming after an
  // await reads the latest committed state (dispatch is the only writer, so this never diverges).
  const stateRef = useRef(state);
  stateRef.current = state;

  // Synchronous re-entrancy guard: set before any await so a double-click on Next/Generate can't start a
  // second navigation or a second download.
  const navigatingRef = useRef(false);

  // Per-session liveness (the epoch, per-instance). In-flight async work checks this and discards its
  // result (no dispatch) once the component has unmounted — the facade remounts a fresh instance on every
  // open, so a pending emit/generate from a closed session never mutates the new session's state.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Compile the chosen target (once per target) so the Name step can default from the emitted namespace and
  // the Generate step can bundle without re-compiling. Surfaces emit failures as a status banner; never
  // throws. Returns the (cached or fresh) preview, or null when the request failed / the session ended.
  async function ensurePreview(): Promise<EmitPreviewResult | null> {
    const st = stateRef.current;
    if (st.preview && st.previewTarget === st.target) return st.preview;
    const target = st.target; // capture: a switch mid-compile must not re-tag this result
    dispatch({ type: 'compileStart' });
    try {
      const res = await deps.emitPreview(target);
      if (!aliveRef.current) return null; // wizard was closed + reopened — drop the stale result
      dispatch({ type: 'compileDone', target, res });
      return res;
    } catch (e) {
      if (!aliveRef.current) return null;
      dispatch({ type: 'compileFailed', error: String(e) });
      return null;
    }
  }

  async function next(): Promise<void> {
    const st = stateRef.current;
    if (st.done) {
      onClose();
      return;
    }
    if (st.busy || navigatingRef.current) return;
    navigatingRef.current = true;
    try {
      if (st.step === STEP.Generate) {
        await generate();
        return;
      }
      // Compile when leaving the Language step so Artifacts/Name/Generate reflect real output, and hold the
      // user here (don't advance) when the model can't emit.
      if (st.step === STEP.Language) {
        const res = await ensurePreview();
        if (!aliveRef.current) return;
        if (!res || res.error || !res.files.length) return;
      }
      if (!aliveRef.current) return;
      dispatch({ type: 'advance' });
    } finally {
      navigatingRef.current = false;
    }
  }

  function back(): void {
    const st = stateRef.current;
    if (st.busy || st.step === STEP.Language) return;
    dispatch({ type: 'back' });
  }

  async function generate(): Promise<void> {
    const preview = await ensurePreview();
    if (!aliveRef.current) return;
    const st = stateRef.current;
    if (!preview || !canGenerate(preview, st.projectName)) return;
    dispatch({ type: 'generateStart' });
    try {
      let glossary: string | null = null;
      if (st.includeGlossary) {
        try {
          glossary = (await deps.glossary()).markdown;
        } catch {
          glossary = null; // a glossary failure shouldn't sink the whole download
        }
      }
      const bytes = await buildProjectZip(preview.files, {
        projectName: st.projectName,
        includeCsproj: st.target === 'csharp' && st.includeCsproj,
        glossary,
      });
      const saved = await deps.saveZip(`${st.projectName}.zip`, bytes);
      if (!aliveRef.current) return;
      dispatch(saved ? { type: 'generateDone' } : { type: 'saveCancelled' });
    } catch (e) {
      if (!aliveRef.current) return;
      dispatch({ type: 'generateError', error: String(e) });
    }
  }

  // --- derived banner / footer (verbatim from the imperative refreshStatus/refreshFooter) ---------------
  const bannerText = state.done ? `${state.projectName}.zip is ready.` : state.status;
  const bannerKind: StatusKind = state.done ? 'success' : state.statusKind;
  const bannerClass =
    'koi-wizard-banner' + (bannerKind === 'success' ? ' success' : bannerKind === 'error' ? ' error' : '');

  const backDisabled = state.busy || state.step === STEP.Language;
  let primaryLabel: string;
  let primaryDisabled: boolean;
  if (state.done) {
    primaryLabel = 'Close';
    primaryDisabled = false;
  } else if (state.step === STEP.Generate) {
    primaryLabel = 'Generate';
    const ready = !!state.preview && canGenerate(state.preview, state.projectName);
    primaryDisabled = state.busy || !ready;
  } else {
    primaryLabel = 'Next';
    const nameOk = state.step !== STEP.Name || isValidProjectName(state.projectName);
    primaryDisabled = state.busy || !nameOk;
  }

  return (
    <div class="koi-wizard">
      <ol class="koi-wizard-steps" aria-label="Progress">
        {STEP_LABELS.map((label, i) => {
          const active = i === state.step && !state.done;
          const done = i < state.step || state.done;
          return (
            <li
              key={label}
              class={'koi-wizard-step' + (active ? ' active' : '') + (done ? ' done' : '')}
              aria-current={active ? 'step' : undefined}
            >
              {label}
            </li>
          );
        })}
      </ol>

      {/* The visual status banner (shown/hidden freely) and a separate, always-present visually-hidden live
          region. Announcements ride the persistent region — toggling a banner's hidden/role in the same
          update that adds text is unreliable for screen readers. */}
      <p class={bannerClass} hidden={!bannerText}>
        {bannerText}
      </p>
      <span class="koi-sr-only" aria-live="polite">
        {bannerText ?? ''}
      </span>

      <div class="koi-wizard-content">
        {state.step === STEP.Language && <LanguageStep state={state} dispatch={dispatch} />}
        {state.step === STEP.Artifacts && <ArtifactsStep state={state} dispatch={dispatch} />}
        {state.step === STEP.Name && (
          <NameStep state={state} dispatch={dispatch} onEnter={() => void next()} />
        )}
        {state.step === STEP.Generate && <GenerateStep state={state} />}
      </div>

      <div class="koi-wizard-footer">
        <button
          type="button"
          class="koi-wizard-btn"
          hidden={state.done}
          disabled={backDisabled}
          onClick={() => back()}
        >
          Back
        </button>
        <button
          type="button"
          class="koi-wizard-btn primary"
          disabled={primaryDisabled}
          onClick={() => void next()}
        >
          {primaryLabel}
        </button>
      </div>
    </div>
  );
}

// --- per-step content -----------------------------------------------------
function LanguageStep(props: { state: WizardState; dispatch: Dispatch }) {
  const { state, dispatch } = props;
  return (
    <div class="koi-wizard-options" role="radiogroup" aria-label="Target language">
      {wizardTargets().map((t) => (
        <label key={t.value} class={'koi-wizard-option' + (state.target === t.value ? ' selected' : '')}>
          <input
            type="radio"
            name="koi-gen-target"
            value={t.value}
            checked={state.target === t.value}
            disabled={state.busy} // can't switch target mid-compile (closes the stale-result race)
            onChange={() => {
              if (state.busy || state.target === t.value) return;
              dispatch({ type: 'selectTarget', target: t.value });
            }}
          />
          <span class="koi-wizard-option-text">
            <span class="koi-wizard-option-title">{t.title}</span>
            <span class="koi-wizard-option-blurb">{t.blurb}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function CheckboxRow(props: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  hint?: string;
  onToggle?: (checked: boolean) => void;
}) {
  const { onToggle } = props;
  return (
    <label class="koi-wizard-check">
      <input
        type="checkbox"
        class="koi-checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={onToggle ? (e) => onToggle((e.currentTarget as HTMLInputElement).checked) : undefined}
      />
      <span class="koi-wizard-check-text">
        <span class="koi-wizard-check-label">{props.label}</span>
        {props.hint && <span class="koi-wizard-check-hint">{props.hint}</span>}
      </span>
    </label>
  );
}

function ArtifactsStep(props: { state: WizardState; dispatch: Dispatch }) {
  const { state, dispatch } = props;
  return (
    <div class="koi-wizard-checks">
      <CheckboxRow label="Source files" checked disabled hint="Always included — the emitted source tree." />
      {state.target === 'csharp' && (
        <CheckboxRow
          label="Project file (.csproj)"
          checked={state.includeCsproj}
          hint="A minimal net10.0 SDK-style project so the output builds as-is."
          onToggle={(c) => dispatch({ type: 'setCsproj', value: c })}
        />
      )}
      <CheckboxRow
        label="Ubiquitous-language glossary (glossary.md)"
        checked={state.includeGlossary}
        hint="The model’s glossary as Markdown documentation."
        onToggle={(c) => dispatch({ type: 'setGlossary', value: c })}
      />
    </div>
  );
}

function NameStep(props: { state: WizardState; dispatch: Dispatch; onEnter: () => void }) {
  const { state, dispatch, onEnter } = props;
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus + select the field the moment the Name step mounts (on arrival, and again on any re-arrival) —
  // keyboard users land in the field with its text ready to overtype. Empty deps: it fires once per mount,
  // never on a keystroke (the controlled value re-renders in place without remounting), so it can't steal
  // the caret mid-typing the way an every-render focus would.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Reflect validity into the field's a11y attributes; describe the field by the error only while the error
  // is actually showing.
  const valid = isValidProjectName(state.projectName);

  return (
    <div class="koi-wizard-name">
      <label class="koi-field-label" for="koi-gen-name">
        Project name
      </label>
      <input
        ref={inputRef}
        type="text"
        id="koi-gen-name"
        class="koi-input"
        value={state.projectName}
        autocomplete="off"
        spellcheck={false}
        aria-invalid={valid ? 'false' : 'true'}
        aria-describedby={valid ? undefined : NAME_ERR_ID}
        onInput={(e) => dispatch({ type: 'setName', value: (e.currentTarget as HTMLInputElement).value })}
        onKeyDown={(e) => {
          // Enter advances when the name is valid.
          if (e.key === 'Enter' && isValidProjectName(state.projectName)) {
            e.preventDefault();
            onEnter();
          }
        }}
      />
      <p class="koi-wizard-hint">Names the archive’s root folder, the .csproj, and the root namespace.</p>
      <p id={NAME_ERR_ID} class="koi-wizard-invalid" hidden={valid}>
        Use a letter or underscore, then letters, digits, underscores, or dots.
      </p>
    </div>
  );
}

function SummaryRow(props: { label: string; value: string }) {
  return (
    <div class="koi-wizard-summary-row">
      <span class="koi-wizard-summary-key">{props.label}</span>
      <span class="koi-wizard-summary-val">{props.value}</span>
    </div>
  );
}

function GenerateStep(props: { state: WizardState }) {
  const { state } = props;
  const artifacts: string[] = ['Source files'];
  if (state.target === 'csharp' && state.includeCsproj) artifacts.push('.csproj');
  if (state.includeGlossary) artifacts.push('glossary.md');
  const targetLabel = wizardTargets().find((t) => t.value === state.target)?.title ?? state.target;
  return (
    <div class="koi-wizard-generate">
      <SummaryRow label="Language" value={targetLabel} />
      <SummaryRow label="Project name" value={state.projectName} />
      <SummaryRow label="Artifacts" value={artifacts.join(', ')} />
      {state.preview && !state.preview.error && (
        <SummaryRow label="Source files" value={String(state.preview.files.length)} />
      )}
    </div>
  );
}

/**
 * Mount (or remount) the wizard into a host — the modal body. Bumping `session` between renders changes the
 * component's `key`, so Preact unmounts the previous instance (flipping its `aliveRef` false — the epoch
 * bump) and mounts a fresh one with reset state. Called by the `createGenerateProject` facade on each open.
 */
export function renderGenerateProjectWizard(
  host: HTMLElement,
  args: { session: number; deps: GenerateProjectDeps; onClose: () => void },
): void {
  render(<GenerateProjectWizard key={args.session} deps={args.deps} onClose={args.onClose} />, host);
}
