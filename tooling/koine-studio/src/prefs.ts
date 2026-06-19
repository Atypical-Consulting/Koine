// Settings dialog for Koine Studio. Built on the shared createModal() chrome, but laid out as a
// two-pane preference center: a vertical category rail (Appearance / Editor / Assistant / Advanced)
// on the left, the active category's controls on the right. The set of persisted Settings is the
// source of truth (./store); each control writes a single-field patch through patchSettings() and
// reports the merged Settings back via onChange. The app's onChange handler is the single place that
// re-skins the studio (applyAppearance + editor soft-wrap), so flipping a control applies live there;
// only Theme is applied here directly, through ./theme's setTheme (its own live-apply + listeners).
import { loadSettings, patchSettings, saveSettings, DEFAULT_SETTINGS, type Settings, type AccentName } from './store';
import { setTheme } from './theme';
import { ACCENTS, ACCENT_ORDER } from './appearance';
import { createModal } from './overlay';
import { mcpJsonSnippet } from './mcp';

export interface PrefsCallbacks {
  /** Fired after every committed change with the merged, persisted Settings. */
  onChange(s: Settings): void;

  /**
   * Resolve the local MCP HTTP endpoint URL to surface in the Assistant settings (so the user can
   * paste it into LM Studio), or null when the host can't serve one — the web build, where the row
   * stays hidden. Optional: a caller that doesn't wire it simply never shows the row.
   */
  mcpEndpoint?(): Promise<string | null>;
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
  advanced:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.6 4.6h10.8M2.6 8h10.8M2.6 11.4h10.8"/><circle cx="6" cy="4.6" r="1.7" fill="var(--koi-paper-2)"/><circle cx="10.4" cy="8" r="1.7" fill="var(--koi-paper-2)"/><circle cx="5" cy="11.4" r="1.7" fill="var(--koi-paper-2)"/></svg>',
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

  const wordWrap = toggle('Word wrap', (on) => commit({ wordWrap: on }));
  const formatOnSave = toggle('Format on save', (on) => commit({ formatOnSave: on }));

  const editorPanel = panel(
    'editor',
    row('Font size', 'Editor text size, in pixels.', fontInput),
    row('Line height', 'Vertical spacing between lines.', lineHeightInput),
    row('Word wrap', 'Wrap long lines instead of scrolling sideways.', wordWrap.el),
    row('Format on save', 'Run the Koine formatter when you press save.', formatOnSave.el),
  );

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

  const baseUrlRow = row('Base URL', 'Endpoint for the OpenAI-compatible provider.', aiBaseUrlInput);
  function syncProviderFields(): void {
    baseUrlRow.hidden = aiProviderSelect.value !== 'openai';
    aiModelInput.placeholder = aiProviderSelect.value === 'openai' ? 'gpt-4o  ·  qwen2.5-coder  ·  …' : 'claude-opus-4-8';
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
  aiKeyInput.addEventListener('change', () => commit({ aiApiKey: aiKeyInput.value.trim() }));
  aiModelInput.addEventListener('change', () => {
    const model = aiModelInput.value.trim();
    commit(aiProviderSelect.value === 'openai' ? { aiModelOpenai: model } : { aiModel: model });
  });

  // MCP server (desktop only): expose Koine's compiler tools to an external MCP client by URL. The
  // row is hidden until the desktop shell resolves the sidecar endpoint (the web build never does).
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
  const mcpRow = row('MCP endpoint', 'Point an MCP client (LM Studio…) at this URL to use Koine’s tools.', mcpControl);
  mcpRow.hidden = true;

  // Resolve (and on the desktop, lazily launch) the MCP sidecar endpoint, revealing the row when a
  // URL comes back. Browser hosts return null, so the row stays hidden. Best-effort: any failure
  // simply leaves the affordance hidden rather than surfacing an error in Settings.
  async function refreshMcpEndpoint(): Promise<void> {
    if (!cb.mcpEndpoint) {
      mcpRow.hidden = true;
      return;
    }

    try {
      const url = await cb.mcpEndpoint();
      mcpUrlInput.value = url ?? '';
      mcpRow.hidden = url === null;
    } catch {
      mcpRow.hidden = true;
    }
  }

  const assistantPanel = panel(
    'assistant',
    row('Provider', 'Which API the assistant talks to.', aiProviderSelect),
    baseUrlRow,
    row('API key', 'Stored locally in this browser — sent only to the provider you choose.', aiKeyInput),
    row('Model', 'The model id the assistant requests.', aiModelInput),
    mcpRow,
    presets,
  );

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
    const fresh = loadSettings();
    setTheme(fresh.theme); // theme has its own live-apply path (not covered by applyAppearance)
    populate(fresh);
    cb.onChange(fresh); // re-skins accent/motion/editor metrics + soft-wrap via the app's onChange
  });

  const advancedPanel = panel(
    'advanced',
    row('Language server trace', 'Verbosity of LSP logging in the console.', traceSelect),
    row('Reset', 'Restore every setting — including the assistant — to its default.', resetBtn),
  );

  // --- assemble the two-pane layout -----------------------------------------

  const categories = [
    { id: 'appearance', label: 'Appearance', icon: ICON.appearance, panel: appearancePanel },
    { id: 'editor', label: 'Editor', icon: ICON.editor, panel: editorPanel },
    { id: 'assistant', label: 'Assistant', icon: ICON.assistant, panel: assistantPanel },
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
    aiProviderSelect.value = s.aiProvider;
    aiBaseUrlInput.value = s.aiBaseUrl;
    aiKeyInput.value = s.aiApiKey;
    aiModelInput.value = s.aiProvider === 'openai' ? s.aiModelOpenai : s.aiModel;
    traceSelect.value = s.lspTrace;
    syncProviderFields();
  }

  modal.onOpen(() => {
    disarmReset();
    populate(loadSettings());
    void refreshMcpEndpoint(); // desktop: lazily start the sidecar and reveal its endpoint
    selectCategory(activeIndex); // keep the last-open category across opens
    tabs[activeIndex].focus();
  });

  return { open: modal.open, close: modal.close };
}
