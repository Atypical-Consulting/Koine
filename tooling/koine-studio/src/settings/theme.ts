// Theme manager for Koine Studio: applies the active theme by setting
// document.documentElement.dataset.theme ('dark' | 'light'). Because the CodeMirror
// editor theme reads the same var() tokens as the page, flipping the dataset attribute
// re-themes the editor automatically — no CodeMirror reconfiguration. Persistence and the
// canonical Settings type live in ./persistence; this module owns the DOM apply + a small
// change-listener registry so other panels can react to theme flips.
import { type ThemeName, loadSettings, patchSettings } from '@/settings/persistence';

// Listeners notified after every apply (toggle/set). Kept module-local; no DOM, no leaks.
const listeners = new Set<(t: ThemeName) => void>();

// Last theme we applied, so currentTheme() does not have to re-read storage.
let active: ThemeName = 'dark';

function notify(t: ThemeName): void {
  for (const cb of listeners) cb(t);
}

/** Apply a theme to the document root (drives every CSS var() and the editor theme). */
export function applyTheme(t: ThemeName): void {
  document.documentElement.dataset.theme = t;
  active = t;
}

/** Read the persisted theme, apply it, and return it. Call once at startup. */
export function initTheme(): ThemeName {
  const t = loadSettings().theme;
  applyTheme(t);
  return t;
}

/** The currently applied theme. */
export function currentTheme(): ThemeName {
  return active;
}

/** Flip dark<->light: persist, apply, notify listeners, and return the new theme. */
export function toggleTheme(): ThemeName {
  const next: ThemeName = active === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}

/** Persist, apply, and notify listeners of an explicit theme. */
export function setTheme(t: ThemeName): void {
  patchSettings({ theme: t });
  applyTheme(t);
  notify(t);
}

/** Register a callback fired after each toggleTheme/setTheme. */
export function onThemeChange(cb: (t: ThemeName) => void): void {
  listeners.add(cb);
}
