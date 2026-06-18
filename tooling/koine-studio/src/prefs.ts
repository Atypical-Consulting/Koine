// Preferences modal for Koine Studio: a generic .koi-modal* dialog exposing the four
// persisted Settings (theme, editor font size, format-on-save, LSP trace). Reads the
// current Settings via loadSettings() on open, writes each change through patchSettings()
// (so localStorage stays the source of truth), and reports the merged Settings back to the
// app via onChange. The Theme control applies live through ./theme's setTheme so flipping
// the select re-themes the editor immediately. Self-mounts to document.body once; Esc and a
// backdrop click close it. No CodeMirror, no framework — plain DOM.
import { loadSettings, patchSettings, type Settings } from './store';
import { setTheme } from './theme';

export interface PrefsCallbacks {
  /** Fired after every committed change with the merged, persisted Settings. */
  onChange(s: Settings): void;
}

export interface PrefsHandle {
  open(): void;
  close(): void;
}

const FONT_MIN = 10;
const FONT_MAX = 22;
const FONT_STEP = 0.5;

/**
 * Build the preferences modal and return an imperative handle. The DOM is created once and
 * kept hidden between opens; open() repopulates every control from the freshly loaded
 * Settings so the dialog never shows stale values.
 */
export function createPreferences(cb: PrefsCallbacks): PrefsHandle {
  // --- backdrop + panel (generic modal shell) -------------------------------
  const backdrop = document.createElement('div');
  backdrop.className = 'koi-modal-backdrop';
  backdrop.hidden = true;

  const modal = document.createElement('div');
  modal.className = 'koi-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Preferences');
  backdrop.appendChild(modal);

  const header = document.createElement('div');
  header.className = 'koi-modal-header';
  const title = document.createElement('h2');
  title.className = 'koi-modal-title';
  title.textContent = 'Preferences';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'koi-modal-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '✕';
  header.append(title, closeBtn);

  const body = document.createElement('div');
  body.className = 'koi-modal-body';

  modal.append(header, body);

  // --- field factory --------------------------------------------------------
  // Each row is a .koi-field with a .koi-field-label and a .koi-field-control wrapper around
  // the actual input/select.
  function field(labelText: string, control: HTMLElement): HTMLElement {
    const f = document.createElement('label');
    f.className = 'koi-field';
    const label = document.createElement('span');
    label.className = 'koi-field-label';
    label.textContent = labelText;
    const ctrl = document.createElement('span');
    ctrl.className = 'koi-field-control';
    ctrl.appendChild(control);
    f.append(label, ctrl);
    return f;
  }

  // Theme — select dark/light. Applies live via setTheme (which persists + re-themes the editor).
  const themeSelect = document.createElement('select');
  themeSelect.className = 'koi-select';
  for (const [value, text] of [['dark', 'Dark'], ['light', 'Light']] as const) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    themeSelect.appendChild(opt);
  }

  // Editor font size — number input, step 0.5, clamped to [10, 22].
  const fontInput = document.createElement('input');
  fontInput.type = 'number';
  fontInput.className = 'koi-number';
  fontInput.min = String(FONT_MIN);
  fontInput.max = String(FONT_MAX);
  fontInput.step = String(FONT_STEP);

  // Format on save — checkbox.
  const formatCheckbox = document.createElement('input');
  formatCheckbox.type = 'checkbox';
  formatCheckbox.className = 'koi-checkbox';

  // LSP trace — select off/messages/verbose.
  const traceSelect = document.createElement('select');
  traceSelect.className = 'koi-select';
  for (const [value, text] of [
    ['off', 'Off'],
    ['messages', 'Messages'],
    ['verbose', 'Verbose'],
  ] as const) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    traceSelect.appendChild(opt);
  }

  body.append(
    field('Theme', themeSelect),
    field('Editor font size', fontInput),
    field('Format on save', formatCheckbox),
    field('LSP trace', traceSelect),
  );

  // --- commit helpers -------------------------------------------------------
  // Every control commits a single-field patch, then reports the merged Settings. The Theme
  // field is special-cased: it goes through setTheme so the change applies live AND persists,
  // after which we still surface the merged Settings to onChange.
  function commit(patch: Partial<Settings>): void {
    const merged = patchSettings(patch);
    cb.onChange(merged);
  }

  themeSelect.addEventListener('change', () => {
    const theme = themeSelect.value === 'light' ? 'light' : 'dark';
    setTheme(theme); // persists + applies + notifies theme listeners
    cb.onChange(loadSettings()); // report the now-current, merged Settings
  });

  // Clamp font size into range on commit; ignore non-numeric input.
  fontInput.addEventListener('change', () => {
    const raw = Number(fontInput.value);
    if (!Number.isFinite(raw)) {
      fontInput.value = String(loadSettings().fontSize);
      return;
    }
    const clamped = Math.min(Math.max(raw, FONT_MIN), FONT_MAX);
    fontInput.value = String(clamped);
    commit({ fontSize: clamped });
  });

  formatCheckbox.addEventListener('change', () => {
    commit({ formatOnSave: formatCheckbox.checked });
  });

  traceSelect.addEventListener('change', () => {
    const v = traceSelect.value;
    const lspTrace = v === 'messages' || v === 'verbose' ? v : 'off';
    commit({ lspTrace });
  });

  // --- open/close -----------------------------------------------------------
  // Populate every control from the freshly loaded Settings so the dialog reflects whatever
  // other surfaces (toolbar toggle, command palette) may have changed since the last open.
  function populate(): void {
    const s = loadSettings();
    themeSelect.value = s.theme;
    fontInput.value = String(s.fontSize);
    formatCheckbox.checked = s.formatOnSave;
    traceSelect.value = s.lspTrace;
  }

  let opener: HTMLElement | null = null;

  function open(): void {
    opener = document.activeElement as HTMLElement | null;
    populate();
    backdrop.hidden = false;
    // Focus the first control so keyboard users land inside the dialog.
    themeSelect.focus();
  }

  function close(): void {
    backdrop.hidden = true;
    opener?.focus?.(); // restore focus to whatever opened the dialog
    opener = null;
  }

  // Backdrop click (outside the panel) closes; clicks inside the panel do not bubble out.
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  closeBtn.addEventListener('click', close);

  // Esc closes while open. Scoped to the backdrop subtree so it only fires when focus is
  // inside the dialog; the app's global Esc-closes-top-overlay handler covers other cases.
  backdrop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });

  document.body.appendChild(backdrop);

  return { open, close };
}
