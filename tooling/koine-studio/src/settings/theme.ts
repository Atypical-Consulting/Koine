// Theme manager for Koine Studio: applies the active theme by setting
// document.documentElement.dataset.theme ('dark' | 'light'). Because the CodeMirror
// editor theme reads the same var() tokens as the page, flipping the dataset attribute
// re-themes the editor automatically — no CodeMirror reconfiguration. Persistence and the
// canonical Settings type live in ./persistence; this module owns the DOM apply and publishes
// the active theme to the uiChrome store field so other panels can react via a plain subscription.
import { type ThemeName, loadSettings, patchSettings } from '@/settings/persistence';
import { appStore } from '@/store/index';

/** Apply a theme to the document root (drives every CSS var() and the editor theme). */
export function applyTheme(t: ThemeName): void {
  document.documentElement.dataset.theme = t;
  appStore.getState().setTheme(t);
}

/** Read the persisted theme, apply it, and return it. Call once at startup. */
export function initTheme(): ThemeName {
  const t = loadSettings().theme;
  applyTheme(t);
  return t;
}

/** The currently applied theme. */
export function currentTheme(): ThemeName {
  return appStore.getState().theme;
}

/** Flip dark<->light: persist, apply, and return the new theme. */
export function toggleTheme(): ThemeName {
  const next: ThemeName = currentTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}

/** Persist and apply an explicit theme (the store field is published by applyTheme). */
export function setTheme(t: ThemeName): void {
  patchSettings({ theme: t });
  applyTheme(t);
}
