// Preferences modal for Koine Studio: uses the shared createModal() chrome and exposes the
// four persisted Settings (theme, editor font size, format-on-save, LSP trace). Reads the
// current Settings via loadSettings() on each open, writes each change through patchSettings()
// (so localStorage stays the source of truth), and reports the merged Settings back to the app
// via onChange. The Theme control applies live through ./theme's setTheme so flipping the
// select re-themes the editor immediately.
import { loadSettings, patchSettings, type Settings } from './store';
import { setTheme } from './theme';
import { createModal } from './overlay';

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
 * Build the preferences modal and return an imperative handle. The DOM is created once; each
 * open() repopulates every control from the freshly loaded Settings so the dialog never shows
 * stale values (e.g. after a theme toggle from the toolbar or command palette).
 */
export function createPreferences(cb: PrefsCallbacks): PrefsHandle {
  const modal = createModal({ title: 'Preferences' });

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

  modal.body.append(
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

  // Populate every control from the freshly loaded Settings, then move focus to the first
  // control so keyboard users land inside the dialog (overriding the modal's default focus).
  modal.onOpen(() => {
    const s = loadSettings();
    themeSelect.value = s.theme;
    fontInput.value = String(s.fontSize);
    formatCheckbox.checked = s.formatOnSave;
    traceSelect.value = s.lspTrace;
    themeSelect.focus();
  });

  return { open: modal.open, close: modal.close };
}
