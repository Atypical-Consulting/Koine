// Settings dialog for Koine Studio. Built on the shared createModal() chrome, but laid out as a
// two-pane preference center: a vertical category rail (Appearance / Editor / Assistant / Advanced)
// on the left, the active category's controls on the right. The set of persisted Settings is the
// source of truth (./persistence); each control writes a single-field patch through patchSettings() and
// reports the merged Settings back via onChange. The app's onChange handler is the single place that
// re-skins the studio (applyAppearance + editor soft-wrap), so flipping a control applies live there;
// only Theme is applied here directly, through ./theme's setTheme (its own live-apply + listeners).
import {
  loadSettings,
  patchSettings,
  saveSettings,
  saveApiKey,
  clearApiKey,
  whenSecretsReady,
  DEFAULT_SETTINGS,
  PREVIEW_TARGETS,
  type Settings,
  type AccentName,
  type PreviewTarget,
} from '@/settings/persistence';
import { setTheme } from '@/settings/theme';
import { ACCENTS, ACCENT_ORDER } from '@/settings/appearance';
import { createModal } from '@/shared/overlay';
import { mcpJsonSnippet, MCP_CLIENTS, probeMcp } from '@/mcp/mcp';

export interface PrefsCallbacks {
  /** Fired after every committed change with the merged, persisted Settings. */
  onChange(s: Settings): void;

  /**
   * Resolve the local MCP HTTP endpoint URL to surface in the Assistant settings (so the user can
   * paste it into LM Studio), or null when the host can't serve one — the web build, where the row
   * stays hidden. Optional: a caller that doesn't wire it simply never shows the row.
   */
  mcpEndpoint?(): Promise<string | null>;

  /**
   * Stop the local MCP sidecar when the user disables it. Optional: a host that never starts one
   * (browser) can omit it. Pairs with {@link mcpEndpoint}, which (re)starts it.
   */
  mcpStop?(): Promise<void>;

  /**
   * Whether this host can actually run the MCP sidecar — the desktop shell can, a browser tab cannot.
   * Defaults to true when omitted; the web build passes false so the toggle is shown disabled and the
   * endpoint/test rows stay hidden (the copy-paste recipes still render, pointing at the CLI).
   */
  mcpHostable?: boolean;

  /**
   * Whether this host can save projects to a workspace root directory. True in the browser when the
   * File System Access API is present; false on the Tauri desktop. When false, the workspace root row
   * is hidden from Settings.
   */
  canSaveProjects?: boolean;

  /** Return the remembered workspace root's display name (for Settings), or null if not yet set. */
  workspaceRootName?(): Promise<string | null>;

  /** Re-pick the workspace root directory; returns its name, or null if dismissed. */
  pickWorkspaceRoot?(): Promise<string | null>;
}

export interface PrefsHandle {
  open(): void;
  close(): void;
}

const FONT_MIN = 10;
const FONT_MAX = 22;
const FONT_STEP = 0.5;

const LINE_HEIGHT_MIN = 1.2;
const LINE_HEIGHT_MAX = 2.4;
const LINE_HEIGHT_STEP = 0.1;

// Category rail icons, drawn in the studio's 16×16 line-icon idiom (stroke = currentColor).
const ICON = {
  appearance:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.6"/><path d="M8 2.4a5.6 5.6 0 0 1 0 11.2z" fill="currentColor" stroke="none"/></svg>',
  editor:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4 2.4 8 6 12"/><path d="M10 4l3.6 4-3.6 4"/></svg>',
  assistant:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2l1.5 3.9 3.9 1.5-3.9 1.5L8 13l-1.5-3.9L2.6 7.6l3.9-1.5z"/></svg>',
  mcp:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2.6v4.2M10 2.6v4.2M4.4 6.8h7.2v1.4a3.6 3.6 0 0 1-3.6 3.6 3.6 3.6 0 0 1-3.6-3.6z"/><path d="M8 12v1.8"/></svg>',
  advanced:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.6 4.6h10.8M2.6 8h10.8M2.6 11.4h10.8"/><circle cx="6" cy="4.6" r="1.7" fill="var(--koi-paper-2)"/><circle cx="10.4" cy="8" r="1.7" fill="var(--koi-paper-2)"/><circle cx="5" cy="11.4" r="1.7" fill="var(--koi-paper-2)"/></svg>',
  output:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.4 2.6c-1.2 0-1.7.6-1.7 1.8v1.6c0 .9-.3 1.3-1.1 1.4v1.2c.8.1 1.1.5 1.1 1.4v1.6c0 1.2.5 1.8 1.7 1.8M9.6 2.6c1.2 0 1.7.6 1.7 1.8v1.6c0 .9.3 1.3 1.1 1.4v1.2c-.8.1-1.1.5-1.1 1.4v1.6c0 1.2-.5 1.8-1.7 1.8"/></svg>',
} as const;

/**
 * Build the Settings dialog and return an imperative handle. The DOM is created once; each open()
 * repopulates every control from the freshly loaded Settings so the dialog never shows stale values
 * (e.g. after a theme toggle from the toolbar or command palette).
 */
export function createPreferences(cb: PrefsCallbacks): PrefsHandle {
  const modal = createModal({ title: 'Settings', ariaLabel: 'Koine Studio settings', variant: 'koi-modal--settings' });

  // Every control commits a single-field patch, then reports the merged Settings to the app.
  function commit(patch: Partial<Settings>): void {
    cb.onChange(patchSettings(patch));
  }

  // --- control factories ----------------------------------------------------

  // A labelled settings row: a title (+ optional description) on the left, the control on the right.
  function row(title: string, description: string, control: HTMLElement): HTMLElement {
    const r = document.createElement('div');
    r.className = 'koi-set-row';
    const text = document.createElement('div');
    text.className = 'koi-set-text';
    const label = document.createElement('span');
    label.className = 'koi-set-label';
    label.textContent = title;
    text.appendChild(label);
    if (description) {
      const desc = document.createElement('span');
      desc.className = 'koi-set-desc';
      desc.textContent = description;
      text.appendChild(desc);
    }
    const ctrl = document.createElement('div');
    ctrl.className = 'koi-set-control';
    ctrl.appendChild(control);
    r.append(text, ctrl);
    return r;
  }

  // A panel groups rows under a category.
  function panel(id: string, ...rows: HTMLElement[]): HTMLElement {
    const p = document.createElement('section');
    p.className = 'koi-settings-panel';
    p.id = `koi-settings-panel-${id}`;
    p.setAttribute('role', 'tabpanel');
    p.append(...rows);
    return p;
  }

  // An iOS-style on/off switch backed by role=switch (toggles on click; label via aria-label).
  function toggle(ariaLabel: string, onChange: (on: boolean) => void): { el: HTMLButtonElement; set(on: boolean): void } {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'koi-switch';
    btn.setAttribute('role', 'switch');
    btn.setAttribute('aria-label', ariaLabel);
    btn.setAttribute('aria-checked', 'false');
    const thumb = document.createElement('span');
    thumb.className = 'koi-switch-thumb';
    btn.appendChild(thumb);
    const set = (on: boolean) => btn.setAttribute('aria-checked', String(on));
    btn.addEventListener('click', () => {
      const next = btn.getAttribute('aria-checked') !== 'true';
      set(next);
      onChange(next);
    });
    return { el: btn, set };
  }

  // A segmented radio group (e.g. Dark / Light). Each option is a button; one is checked at a time.
  function segmented<T extends string>(
    ariaLabel: string,
    options: readonly { value: T; label: string }[],
    onSelect: (value: T) => void,
  ): { el: HTMLElement; set(value: T): void } {
    const group = document.createElement('div');
    group.className = 'koi-segmented';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', ariaLabel);
    const buttons = options.map(({ value, label }) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'koi-seg';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      b.dataset.value = value;
      b.textContent = label;
      b.addEventListener('click', () => {
        set(value);
        onSelect(value);
      });
      group.appendChild(b);
      return b;
    });
    const set = (value: T) => {
      for (const b of buttons) b.setAttribute('aria-checked', String(b.dataset.value === value));
    };
    return { el: group, set };
  }

  // The accent swatch picker: one coloured dot per preset, single-selection radio group.
  function accentPicker(onSelect: (value: AccentName) => void): { el: HTMLElement; set(value: AccentName): void } {
    const group = document.createElement('div');
    group.className = 'koi-accent-row';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Accent colour');
    const buttons = ACCENT_ORDER.map((name) => {
      const preset = ACCENTS[name];
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'koi-accent-swatch';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      b.setAttribute('aria-label', preset.label);
      b.title = preset.label;
      b.dataset.value = name;
      b.style.setProperty('--koi-swatch', preset.swatch);
      const dot = document.createElement('span');
      dot.className = 'koi-accent-dot';
      b.appendChild(dot);
      b.addEventListener('click', () => {
        set(name);
        onSelect(name);
      });
      group.appendChild(b);
      return b;
    });
    const set = (value: AccentName) => {
      for (const b of buttons) b.setAttribute('aria-checked', String(b.dataset.value === value));
    };
    return { el: group, set };
  }

  // The output-language picker: a card per target (identity dot + name + the file extension it
   // emits), laid out as a single-selection radio group.
  function langPicker(onSelect: (value: PreviewTarget) => void): { el: HTMLElement; set(value: PreviewTarget): void } {
    const LABELS: Record<PreviewTarget, string> = {
      csharp: 'C#',
      typescript: 'TypeScript',
      python: 'Python',
      php: 'PHP',
    };
    // The file extension each target emits — a concrete, recognizable cue on every card.
    const EXTENSIONS: Record<PreviewTarget, string> = {
      csharp: '.cs',
      typescript: '.ts',
      python: '.py',
      php: '.php',
    };
    const group = document.createElement('div');
    group.className = 'koi-lang-picker';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Output language');
    const buttons = PREVIEW_TARGETS.map((id) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'koi-lang-opt';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      b.dataset.value = id;
      const dot = document.createElement('span');
      dot.className = 'lang-dot';
      dot.dataset.lang = id;
      dot.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'koi-lang-name';
      label.textContent = LABELS[id];
      const ext = document.createElement('span');
      ext.className = 'koi-lang-ext';
      ext.textContent = EXTENSIONS[id];
      b.append(dot, label, ext);
      b.addEventListener('click', () => {
        set(id);
        onSelect(id);
      });
      group.appendChild(b);
      return b;
    });
    const set = (value: PreviewTarget) => {
      for (const b of buttons) b.setAttribute('aria-checked', String(b.dataset.value === value));
    };
    return { el: group, set };
  }

  // A clamped numeric setting input. On commit it parses, restores the prior value for empty/blank
  // or non-numeric input (Number('') is 0, so the blank case must be caught explicitly), clamps into
  // [min, max], then writes the single field. The committed change re-applies appearance via onChange.
  function metricInput(
    min: number,
    max: number,
    step: number,
    read: () => number,
    write: (value: number) => void,
  ): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'koi-number';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.addEventListener('change', () => {
      const text = input.value.trim();
      const raw = Number(text);
      if (text === '' || !Number.isFinite(raw)) {
        input.value = String(read()); // restore the last good value
        return;
      }
      const clamped = Math.min(Math.max(raw, min), max);
      input.value = String(clamped);
      write(clamped);
    });
    return input;
  }

  function select<T extends string>(options: readonly { value: T; label: string }[]): HTMLSelectElement {
    const sel = document.createElement('select');
    sel.className = 'koi-select';
    for (const { value, label } of options) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      sel.appendChild(opt);
    }
    return sel;
  }

  // --- Appearance -----------------------------------------------------------

  const themeSeg = segmented<Settings['theme']>(
    'Theme',
    [
      { value: 'dark', label: 'Dark' },
      { value: 'light', label: 'Light' },
    ],
    (theme) => {
      setTheme(theme); // persists + applies live + notifies theme listeners
      cb.onChange(loadSettings());
    },
  );

  // Appearance fields just commit; the live re-skin happens in onChange via applyAppearance (the one
  // place that defines how a Settings object maps to the DOM), so there is a single apply path.
  const accent = accentPicker((name) => commit({ accent: name }));
  const reduceMotion = toggle('Reduce motion', (on) => commit({ reduceMotion: on }));

  const appearancePanel = panel(
    'appearance',
    row('Theme', 'Light or dark surfaces across the whole studio.', themeSeg.el),
    row('Accent', 'The highlight colour for selections, focus, and actions.', accent.el),
    row('Reduce motion', 'Collapse animations and transitions.', reduceMotion.el),
  );

  // --- Editor ---------------------------------------------------------------

  const fontInput = metricInput(
    FONT_MIN,
    FONT_MAX,
    FONT_STEP,
    () => loadSettings().fontSize,
    (v) => commit({ fontSize: v }),
  );

  const lineHeightInput = metricInput(
    LINE_HEIGHT_MIN,
    LINE_HEIGHT_MAX,
    LINE_HEIGHT_STEP,
    () => loadSettings().lineHeight,
    (v) => commit({ lineHeight: v }),
  );

  // A live type specimen: a short Koine snippet that renders at the current font size, line height,
  // and word-wrap so the numeric inputs above have something tangible to read against. It updates on
  // every keystroke — visual only; the real editor re-skins through onChange like every other field.
  const specimenCode = document.createElement('pre');
  specimenCode.className = 'koi-editor-specimen-code';
  specimenCode.setAttribute('aria-hidden', 'true');
  specimenCode.innerHTML =
    '<span class="tk-c">// A value object is immutable and compared by its fields</span>\n' +
    '<span class="tk-k">value</span> <span class="tk-t">Money</span> {\n' +
    '  amount: <span class="tk-t">Decimal</span>\n' +
    '  currency: <span class="tk-t">Currency</span>\n' +
    '}';

  const specimenLabel = document.createElement('span');
  specimenLabel.className = 'koi-editor-specimen-label';
  specimenLabel.textContent = 'Preview';

  const specimen = document.createElement('figure');
  specimen.className = 'koi-editor-specimen';
  specimen.append(specimenLabel, specimenCode);

  // Read a metric input's current value, clamped into range, falling back to the persisted setting
  // for an empty or non-numeric field so a mid-edit blank never blanks the preview.
  function specimenMetric(input: HTMLInputElement, min: number, max: number, fallback: number): number {
    const raw = Number(input.value.trim());
    if (input.value.trim() === '' || !Number.isFinite(raw)) return fallback;
    return Math.min(Math.max(raw, min), max);
  }
  function refreshSpecimen(): void {
    const s = loadSettings();
    specimenCode.style.fontSize = `${specimenMetric(fontInput, FONT_MIN, FONT_MAX, s.fontSize)}px`;
    specimenCode.style.lineHeight = String(
      specimenMetric(lineHeightInput, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, s.lineHeight),
    );
  }
  fontInput.addEventListener('input', refreshSpecimen);
  lineHeightInput.addEventListener('input', refreshSpecimen);

  const wordWrap = toggle('Word wrap', (on) => {
    commit({ wordWrap: on });
    specimenCode.classList.toggle('is-wrapped', on); // the preview wraps / scrolls just like the editor
  });
  const formatOnSave = toggle('Format on save', (on) => commit({ formatOnSave: on }));

  const editorPanel = panel(
    'editor',
    specimen,
    row('Font size', 'Editor text size, in pixels.', fontInput),
    row('Line height', 'Vertical spacing between lines.', lineHeightInput),
    row('Word wrap', 'Wrap long lines instead of scrolling sideways.', wordWrap.el),
    row('Format on save', 'Run the Koine formatter when you press save.', formatOnSave.el),
  );

  // --- Output ---------------------------------------------------------------

  const outputLang = langPicker((target) => commit({ previewTarget: target }));

  // Output lays the picker out full-width under its own heading (not a narrow label/control row) so
  // the four language cards have room to breathe and the caption can say what actually changes.
  const outputText = document.createElement('div');
  outputText.className = 'koi-set-text';
  const outputLabel = document.createElement('span');
  outputLabel.className = 'koi-set-label';
  outputLabel.textContent = 'Output language';
  const outputDesc = document.createElement('span');
  outputDesc.className = 'koi-set-desc';
  outputDesc.textContent =
    'The language the Generated preview emits. Your .koi source stays the same — switch any time.';
  outputText.append(outputLabel, outputDesc);

  const outputBlock = document.createElement('div');
  outputBlock.className = 'koi-output-block';
  outputBlock.append(outputText, outputLang.el);

  const outputPanel = panel('output', outputBlock);

  // --- Assistant (AI) -------------------------------------------------------

  const aiProviderSelect = select([
    { value: 'anthropic', label: 'Anthropic (Claude)' },
    { value: 'openai', label: 'OpenAI-compatible' },
  ] as const);

  const aiBaseUrlInput = document.createElement('input');
  aiBaseUrlInput.type = 'text';
  aiBaseUrlInput.className = 'koi-text';
  aiBaseUrlInput.spellcheck = false;
  aiBaseUrlInput.placeholder = 'https://api.openai.com/v1';
  aiBaseUrlInput.setAttribute('list', 'koi-ai-base-presets');
  const presets = document.createElement('datalist');
  presets.id = 'koi-ai-base-presets';
  for (const url of ['https://api.openai.com/v1', 'http://localhost:11434/v1', 'http://localhost:1234/v1']) {
    const opt = document.createElement('option');
    opt.value = url;
    presets.appendChild(opt);
  }

  const aiKeyInput = document.createElement('input');
  aiKeyInput.type = 'password';
  aiKeyInput.className = 'koi-text';
  aiKeyInput.autocomplete = 'off';
  aiKeyInput.placeholder = 'sk-…  (blank for local Ollama / LM Studio)';

  const aiModelInput = document.createElement('input');
  aiModelInput.type = 'text';
  aiModelInput.className = 'koi-text';
  aiModelInput.spellcheck = false;
  aiModelInput.placeholder = 'claude-opus-4-8';

  const aiAgenticTools = toggle('Compiler tools', (on) => commit({ aiAgenticTools: on }));

  const baseUrlRow = row('Base URL', 'Endpoint for the OpenAI-compatible provider.', aiBaseUrlInput);
  const agenticToolsRow = row(
    'Compiler tools',
    'Let the model validate, compile and format your model mid-chat. Off keeps replies streaming — some local servers (LM Studio) stop streaming when tools are offered.',
    aiAgenticTools.el,
  );
  function syncProviderFields(): void {
    const isOpenai = aiProviderSelect.value === 'openai';
    baseUrlRow.hidden = !isOpenai;
    // The Anthropic path doesn't use the compiler tools, so the toggle only applies to OpenAI-compatible.
    agenticToolsRow.hidden = !isOpenai;
    aiModelInput.placeholder = isOpenai ? 'gpt-4o  ·  qwen2.5-coder  ·  …' : 'claude-opus-4-8';
  }

  aiProviderSelect.addEventListener('change', () => {
    const aiProvider = aiProviderSelect.value === 'openai' ? 'openai' : 'anthropic';
    const merged = patchSettings({ aiProvider });
    // Swap the model field to the model remembered for the now-selected provider, so a Claude id is
    // never left sitting in front of an OpenAI endpoint (and vice-versa).
    aiModelInput.value = aiProvider === 'openai' ? merged.aiModelOpenai : merged.aiModel;
    syncProviderFields();
    cb.onChange(merged);
  });
  aiBaseUrlInput.addEventListener('change', () => {
    const url = aiBaseUrlInput.value.trim();
    commit({ aiBaseUrl: url || 'https://api.openai.com/v1' });
  });
  // The key is a secret: it goes through the encrypted store, not the plaintext settings blob.
  aiKeyInput.addEventListener('change', () => {
    void saveApiKey(aiKeyInput.value.trim()).then(() => cb.onChange(loadSettings()));
  });
  aiModelInput.addEventListener('change', () => {
    const model = aiModelInput.value.trim();
    commit(aiProviderSelect.value === 'openai' ? { aiModelOpenai: model } : { aiModel: model });
  });

  const assistantPanel = panel(
    'assistant',
    row('Provider', 'Which API the assistant talks to.', aiProviderSelect),
    baseUrlRow,
    row('API key', 'Encrypted in this browser and never leaves this device — sent only to the provider you choose.', aiKeyInput),
    row('Model', 'The model id the assistant requests.', aiModelInput),
    agenticToolsRow,
    presets,
  );

  // --- MCP server (Settings → MCP) ------------------------------------------
  // The desktop shell hosts a `koine mcp --http` sidecar; this panel toggles it on/off, shows the
  // right copy-paste recipe per client, and self-probes the endpoint to confirm an LLM can reach
  // Koine's tools. The web build can't host a server, so the toggle is disabled and only the recipes
  // (pointing at the `koine mcp --http` CLI) are shown.

  // URL shown inside HTTP recipes before a live endpoint resolves (or on the web build).
  const MCP_URL_PLACEHOLDER = 'http://127.0.0.1:PORT/mcp';

  const mcpEnableToggle = toggle('Enable MCP server', (on) => void applyMcpEnabled(on));
  const mcpEnableRow = row(
    'Enable MCP server',
    'Serve Koine’s compiler tools to an external MCP client (LM Studio, Claude Desktop…).',
    mcpEnableToggle.el,
  );

  // A browser tab can't host a server — surfaced as a caption when !mcpHostable.
  const mcpWebHint = document.createElement('p');
  mcpWebHint.className = 'koi-mcp-note';
  mcpWebHint.textContent =
    'A browser tab can’t host a server. Run `koine mcp --http` from the CLI, then use the recipe below.';
  mcpWebHint.hidden = true;

  // Endpoint URL (read-only) + Copy mcp.json — the quick path for a URL client.
  const mcpUrlInput = document.createElement('input');
  mcpUrlInput.type = 'text';
  mcpUrlInput.className = 'koi-text';
  mcpUrlInput.readOnly = true;
  mcpUrlInput.spellcheck = false;
  mcpUrlInput.placeholder = 'starting…';
  mcpUrlInput.setAttribute('aria-label', 'Koine MCP endpoint URL');

  const mcpCopyBtn = document.createElement('button');
  mcpCopyBtn.type = 'button';
  mcpCopyBtn.className = 'koi-set-action';
  mcpCopyBtn.textContent = 'Copy mcp.json';
  let mcpCopyTimer: ReturnType<typeof setTimeout> | undefined;
  mcpCopyBtn.addEventListener('click', () => {
    const url = mcpUrlInput.value.trim();
    if (!url) return;
    navigator.clipboard
      .writeText(mcpJsonSnippet(url))
      .then(() => (mcpCopyBtn.textContent = 'Copied ✓'))
      .catch(() => (mcpCopyBtn.textContent = 'Copy failed'))
      .finally(() => {
        clearTimeout(mcpCopyTimer);
        mcpCopyTimer = setTimeout(() => (mcpCopyBtn.textContent = 'Copy mcp.json'), 1600);
      });
  });

  const mcpControl = document.createElement('div');
  mcpControl.className = 'koi-mcp-control';
  mcpControl.append(mcpUrlInput, mcpCopyBtn);
  const mcpEndpointRow = row('Endpoint', 'The loopback URL a URL-based client connects to.', mcpControl);

  // Per-client recipe picker.
  const mcpClientSelect = select(MCP_CLIENTS.map((c) => ({ value: c.id, label: c.label })));
  mcpClientSelect.addEventListener('change', () => {
    commit({ mcpClient: mcpClientSelect.value as Settings['mcpClient'] });
    renderRecipe();
  });
  const mcpClientRow = row('Client', 'Pick your MCP client for its exact setup snippet.', mcpClientSelect);

  // The recipe body: a heading + Copy, the snippet, the config hint, and an optional caveat.
  const mcpSnippet = document.createElement('pre');
  mcpSnippet.className = 'koi-mcp-snippet';
  mcpSnippet.tabIndex = 0;
  mcpSnippet.setAttribute('aria-label', 'MCP client configuration snippet');

  const mcpRecipeCopy = document.createElement('button');
  mcpRecipeCopy.type = 'button';
  mcpRecipeCopy.className = 'koi-set-action';
  mcpRecipeCopy.textContent = 'Copy';
  let mcpRecipeTimer: ReturnType<typeof setTimeout> | undefined;
  mcpRecipeCopy.addEventListener('click', () => {
    navigator.clipboard
      .writeText(mcpSnippet.textContent ?? '')
      .then(() => (mcpRecipeCopy.textContent = 'Copied ✓'))
      .catch(() => (mcpRecipeCopy.textContent = 'Copy failed'))
      .finally(() => {
        clearTimeout(mcpRecipeTimer);
        mcpRecipeTimer = setTimeout(() => (mcpRecipeCopy.textContent = 'Copy'), 1600);
      });
  });

  const mcpRecipeHead = document.createElement('div');
  mcpRecipeHead.className = 'koi-mcp-recipe-head';
  const mcpRecipeTitle = document.createElement('span');
  mcpRecipeTitle.className = 'koi-set-label';
  mcpRecipeTitle.textContent = 'Configuration';
  mcpRecipeHead.append(mcpRecipeTitle, mcpRecipeCopy);

  const mcpRecipeHint = document.createElement('p');
  mcpRecipeHint.className = 'koi-mcp-hint';
  const mcpRecipeNote = document.createElement('p');
  mcpRecipeNote.className = 'koi-mcp-note';

  const mcpRecipe = document.createElement('div');
  mcpRecipe.className = 'koi-mcp-recipe';
  mcpRecipe.append(mcpRecipeHead, mcpSnippet, mcpRecipeHint, mcpRecipeNote);

  function renderRecipe(): void {
    const client = MCP_CLIENTS.find((c) => c.id === mcpClientSelect.value) ?? MCP_CLIENTS[0];
    const url = mcpUrlInput.value.trim() || MCP_URL_PLACEHOLDER;
    mcpSnippet.textContent = client.snippet(url);
    mcpRecipeHint.textContent = client.configHint;
    mcpRecipeNote.textContent = client.note ?? '';
    mcpRecipeNote.hidden = !client.note;
  }

  // Connection test: Studio probes the endpoint as a minimal MCP client and reports the tool count.
  const mcpTestBtn = document.createElement('button');
  mcpTestBtn.type = 'button';
  mcpTestBtn.className = 'koi-set-action';
  mcpTestBtn.textContent = 'Test connection';

  const mcpStatus = document.createElement('span');
  mcpStatus.className = 'koi-mcp-status';
  mcpStatus.setAttribute('role', 'status');
  mcpStatus.setAttribute('aria-live', 'polite');

  type McpStatusKind = 'idle' | 'off' | 'checking' | 'ok' | 'fail';
  const STATUS_LABEL: Record<McpStatusKind, string> = {
    idle: 'Not checked',
    off: 'Server off',
    checking: 'Checking…',
    ok: 'Connected',
    fail: 'Not reachable',
  };
  function setMcpStatus(kind: McpStatusKind, text?: string): void {
    mcpStatus.dataset.state = kind;
    mcpStatus.textContent = text ?? STATUS_LABEL[kind];
  }

  const mcpTestControl = document.createElement('div');
  mcpTestControl.className = 'koi-mcp-control';
  mcpTestControl.append(mcpTestBtn, mcpStatus);
  const mcpTestRow = row('Connection', 'Confirm an LLM can reach Koine’s tools at this URL.', mcpTestControl);

  // Monotonic token bumped by every enable/disable/reset/open. A slow async result (endpoint launch,
  // probe) checks its captured token before writing the UI and drops itself if a newer action has
  // since superseded it — so a late enable can't re-show a URL for a server the user just disabled,
  // and a probe can't overwrite "Server off" after a disable.
  let mcpGen = 0;

  mcpTestBtn.addEventListener('click', () => void runMcpTest());
  async function runMcpTest(): Promise<void> {
    if (!loadSettings().mcpEnabled) return setMcpStatus('off');
    const url = mcpUrlInput.value.trim();
    if (!url) return setMcpStatus('fail', 'No endpoint');
    const gen = ++mcpGen;
    setMcpStatus('checking');
    const result = await probeMcp(url);
    if (gen !== mcpGen) return; // a newer toggle/test ran while we probed — don't clobber its status
    if (result.ok) setMcpStatus('ok', `Connected ✓ — ${result.tools.length} tools`);
    else setMcpStatus('fail');
  }

  // Resolve (and on the desktop, lazily launch) the MCP sidecar endpoint URL, or '' if it can't be
  // brought up. DOM-free so callers can guard the write against a newer action via mcpGen.
  async function resolveMcpEndpoint(): Promise<string> {
    if (!cb.mcpEndpoint) return '';
    try {
      return (await cb.mcpEndpoint()) ?? '';
    } catch {
      return '';
    }
  }

  // Paint the "server off" state: no endpoint, the recipe on its placeholder URL, status off.
  function showMcpOff(): void {
    mcpUrlInput.value = '';
    renderRecipe();
    setMcpStatus('off');
  }

  // Apply an enable result to the UI: reveal the URL + recipe, or surface a start failure (a blank
  // URL means the sidecar never came up) instead of a benign "Not checked".
  function showMcpStarted(url: string): void {
    mcpUrlInput.value = url;
    renderRecipe();
    if (url) setMcpStatus('idle');
    else setMcpStatus('fail', 'Server didn’t start');
  }

  // Toggle the sidecar: start + reveal the endpoint on enable, stop + clear it on disable.
  async function applyMcpEnabled(on: boolean): Promise<void> {
    const gen = ++mcpGen;
    commit({ mcpEnabled: on });
    if (on) {
      const url = await resolveMcpEndpoint();
      if (gen !== mcpGen) return; // superseded by a newer toggle/reset — drop this stale result
      showMcpStarted(url);
    } else {
      await cb.mcpStop?.();
      if (gen !== mcpGen) return;
      showMcpOff();
    }
    syncMcpUi(on);
  }

  // Reflect enabled state + host capability: the endpoint and test rows only matter when a server is
  // actually running here; the recipes are always useful, so they stay visible.
  function syncMcpUi(enabled: boolean = loadSettings().mcpEnabled): void {
    const hostable = cb.mcpHostable !== false;
    mcpEnableToggle.el.disabled = !hostable;
    mcpWebHint.hidden = hostable;
    mcpEndpointRow.hidden = !hostable || !enabled;
    mcpTestRow.hidden = !hostable || !enabled;
  }

  const mcpPanel = panel('mcp', mcpEnableRow, mcpWebHint, mcpEndpointRow, mcpClientRow, mcpRecipe, mcpTestRow);

  // --- Workspace root (shown only when the host can save projects) ----------

  const wsRootValue = document.createElement('span');
  wsRootValue.className = 'koi-set-label';
  wsRootValue.textContent = 'Not set yet';

  const wsRootBtn = document.createElement('button');
  wsRootBtn.type = 'button';
  wsRootBtn.className = 'koi-set-action';
  wsRootBtn.textContent = 'Change…';
  wsRootBtn.addEventListener('click', () => {
    void cb.pickWorkspaceRoot?.().then((name) => {
      if (name !== null) wsRootValue.textContent = name;
    });
  });

  const wsRootControl = document.createElement('div');
  wsRootControl.className = 'koi-mcp-control';
  wsRootControl.append(wsRootValue, wsRootBtn);
  const wsRootRow = row(
    'Workspace root',
    'The directory under which "Save to disk" writes named projects.',
    wsRootControl,
  );
  wsRootRow.hidden = !cb.canSaveProjects;

  async function refreshWsRootValue(): Promise<void> {
    if (!cb.canSaveProjects || !cb.workspaceRootName) return;
    const name = await cb.workspaceRootName();
    wsRootValue.textContent = name ?? 'Not set yet';
  }

  // --- Advanced -------------------------------------------------------------

  const traceSelect = select([
    { value: 'off', label: 'Off' },
    { value: 'messages', label: 'Messages' },
    { value: 'verbose', label: 'Verbose' },
  ] as const);
  traceSelect.addEventListener('change', () => {
    const v = traceSelect.value;
    commit({ lspTrace: v === 'messages' || v === 'verbose' ? v : 'off' });
  });

  // Reset is destructive (it clears the assistant key too), so it confirms on a second click and
  // disarms itself shortly after to avoid an accidental wipe.
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'koi-set-danger';
  let armed = false;
  let disarmTimer: ReturnType<typeof setTimeout> | undefined;
  function disarmReset(): void {
    armed = false;
    resetBtn.classList.remove('is-armed');
    resetBtn.textContent = 'Reset to defaults';
    if (disarmTimer) clearTimeout(disarmTimer);
  }
  resetBtn.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      resetBtn.classList.add('is-armed');
      resetBtn.textContent = 'Click again to reset everything';
      disarmTimer = setTimeout(disarmReset, 4000);
      return;
    }
    disarmReset();
    saveSettings({ ...DEFAULT_SETTINGS });
    void clearApiKey(); // reset wipes the secret too, not just the plaintext settings
    const fresh = loadSettings();
    setTheme(fresh.theme); // theme has its own live-apply path (not covered by applyAppearance)
    populate(fresh);
    void cb.mcpStop?.(); // defaults disable MCP — stop any running sidecar and reflect it
    ++mcpGen; // supersede any in-flight enable/probe so it can't repaint the panel after reset
    showMcpOff();
    syncMcpUi(false);
    cb.onChange(fresh); // re-skins accent/motion/editor metrics + soft-wrap via the app's onChange
  });

  const advancedPanel = panel(
    'advanced',
    wsRootRow,
    row('Language server trace', 'Verbosity of LSP logging in the console.', traceSelect),
    row('Reset', 'Restore every setting — including the assistant — to its default.', resetBtn),
  );

  // --- assemble the two-pane layout -----------------------------------------

  const categories = [
    { id: 'appearance', label: 'Appearance', icon: ICON.appearance, panel: appearancePanel },
    { id: 'editor', label: 'Editor', icon: ICON.editor, panel: editorPanel },
    { id: 'output', label: 'Output', icon: ICON.output, panel: outputPanel },
    { id: 'assistant', label: 'Assistant', icon: ICON.assistant, panel: assistantPanel },
    { id: 'mcp', label: 'MCP', icon: ICON.mcp, panel: mcpPanel },
    { id: 'advanced', label: 'Advanced', icon: ICON.advanced, panel: advancedPanel },
  ] as const;

  const nav = document.createElement('nav');
  nav.className = 'koi-settings-nav';
  nav.setAttribute('role', 'tablist');
  nav.setAttribute('aria-orientation', 'vertical');
  nav.setAttribute('aria-label', 'Settings categories');

  const panels = document.createElement('div');
  panels.className = 'koi-settings-panels';

  const tabs = categories.map((c) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'koi-settings-tab';
    tab.setAttribute('role', 'tab');
    tab.id = `koi-settings-tab-${c.id}`;
    tab.setAttribute('aria-controls', c.panel.id);
    tab.tabIndex = -1;
    const icon = document.createElement('span');
    icon.className = 'koi-settings-tab-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = c.icon;
    const label = document.createElement('span');
    label.textContent = c.label;
    tab.append(icon, label);
    c.panel.setAttribute('aria-labelledby', tab.id);
    nav.appendChild(tab);
    panels.appendChild(c.panel);
    return tab;
  });

  let activeIndex = 0;
  function selectCategory(index: number, focusTab = false): void {
    activeIndex = index;
    categories.forEach((c, i) => {
      const on = i === index;
      tabs[i].setAttribute('aria-selected', String(on));
      tabs[i].classList.toggle('is-active', on);
      tabs[i].tabIndex = on ? 0 : -1;
      c.panel.hidden = !on;
    });
    if (focusTab) tabs[index].focus();
  }

  tabs.forEach((tab, i) => tab.addEventListener('click', () => selectCategory(i)));
  // Roving arrow navigation between categories (vertical tablist convention).
  nav.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const delta = e.key === 'ArrowDown' ? 1 : -1;
    selectCategory((activeIndex + delta + categories.length) % categories.length, true);
  });

  const layout = document.createElement('div');
  layout.className = 'koi-settings-layout';
  layout.append(nav, panels);
  modal.body.appendChild(layout);

  // --- populate every control from the current Settings ---------------------

  function populate(s: Settings): void {
    themeSeg.set(s.theme);
    accent.set(s.accent);
    reduceMotion.set(s.reduceMotion);
    fontInput.value = String(s.fontSize);
    lineHeightInput.value = String(s.lineHeight);
    wordWrap.set(s.wordWrap);
    formatOnSave.set(s.formatOnSave);
    specimenCode.classList.toggle('is-wrapped', s.wordWrap);
    refreshSpecimen();
    outputLang.set(s.previewTarget);
    aiProviderSelect.value = s.aiProvider;
    aiBaseUrlInput.value = s.aiBaseUrl;
    aiKeyInput.value = s.aiApiKey;
    aiModelInput.value = s.aiProvider === 'openai' ? s.aiModelOpenai : s.aiModel;
    aiAgenticTools.set(s.aiAgenticTools);
    traceSelect.value = s.lspTrace;
    mcpEnableToggle.set(s.mcpEnabled);
    mcpClientSelect.value = s.mcpClient;
    renderRecipe();
    syncProviderFields();
  }

  modal.onOpen(() => {
    disarmReset();
    const s = loadSettings();
    populate(s);
    void refreshWsRootValue();
    // On a very fast first open the secret may still be decrypting; back-fill the key once it lands,
    // but never clobber a value the user has already started typing.
    void whenSecretsReady().then(() => {
      if (aiKeyInput.value === '') aiKeyInput.value = loadSettings().aiApiKey;
    });
    // Only the desktop, and only when the user has enabled MCP, (re)starts the sidecar on open — the
    // server is opt-in, so an unopened Settings dialog never spawns a background process.
    if (s.mcpEnabled && cb.mcpHostable !== false) {
      const gen = ++mcpGen;
      void resolveMcpEndpoint().then((url) => {
        if (gen === mcpGen) showMcpStarted(url);
      });
    } else {
      ++mcpGen;
      showMcpOff();
    }
    syncMcpUi(s.mcpEnabled);
    selectCategory(activeIndex); // keep the last-open category across opens
    tabs[activeIndex].focus();
  });

  return { open: modal.open, close: modal.close };
}
