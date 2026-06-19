// Appearance application for Koine Studio: the small set of settings that are nothing more than
// CSS custom properties / data attributes on <html>. Keeping the DOM writes here (rather than
// scattered through ide.ts) means startup and the Settings dialog drive the exact same code, so a
// freshly loaded app and a live change can never diverge. Theme itself lives in ./theme; this
// module owns the accent hue, the reduced-motion flag, and the editor type metrics.
import { ACCENT_NAMES, type AccentName, type Settings } from './store';

/** A selectable accent: the tokens it overrides, plus a label/swatch for the picker. */
export interface AccentPreset {
  /** Human label shown under the swatch. */
  readonly label: string;
  /** Solid colour drawn in the picker (the default has no override, so it needs its own swatch). */
  readonly swatch: string;
  /** --koi-accent override, or '' to defer to the theme's own (best-tuned) accent. */
  readonly accent: string;
  /** --koi-cyan override (the gradient partner), or ''. */
  readonly cyan: string;
  /** --koi-on-accent override (ink on a filled accent surface), or ''. */
  readonly onAccent: string;
}

// 'blue' is the identity default and intentionally overrides nothing, so the theme's own
// per-mode accent (a brighter blue on dark, a deeper blue on light) stays in charge. The other
// three are bright enough that a single near-black ink reads on both themes.
export const ACCENTS: Record<AccentName, AccentPreset> = {
  blue: { label: 'Azure', swatch: '#5aa9ff', accent: '', cyan: '', onAccent: '' },
  teal: { label: 'Teal', swatch: '#1fc8b6', accent: '#1fc8b6', cyan: '#54d6ff', onAccent: '#04221f' },
  violet: { label: 'Violet', swatch: '#b07cff', accent: '#b07cff', cyan: '#6ea8ff', onAccent: '#190d33' },
  amber: { label: 'Amber', swatch: '#ffb454', accent: '#ffb454', cyan: '#ff8d6b', onAccent: '#2a1503' },
};

/** Order the swatches appear in the picker — the canonical roster from the data layer. */
export const ACCENT_ORDER: readonly AccentName[] = ACCENT_NAMES;

const root = () => document.documentElement;

/**
 * Apply (or clear) the accent override. The default preset removes the inline properties so the
 * theme tokens win again; every other preset pins all three tokens inline on <html>.
 */
export function applyAccent(name: AccentName): void {
  const preset = ACCENTS[name] ?? ACCENTS.blue;
  const style = root().style;
  const set = (prop: string, value: string) => (value ? style.setProperty(prop, value) : style.removeProperty(prop));
  set('--koi-accent', preset.accent);
  set('--koi-cyan', preset.cyan);
  set('--koi-on-accent', preset.onAccent);
}

/** Toggle the explicit reduced-motion flag the stylesheet reads (html[data-reduce-motion]). */
export function applyReduceMotion(on: boolean): void {
  if (on) root().dataset.reduceMotion = 'true';
  else delete root().dataset.reduceMotion;
}

/** Drive the editor's font size + line height, both read by the CodeMirror theme as CSS vars. */
export function applyEditorMetrics(fontSize: number, lineHeight: number): void {
  const style = root().style;
  style.setProperty('--koi-editor-font-size', `${fontSize}px`);
  style.setProperty('--koi-editor-line-height', String(lineHeight));
}

/** Apply every <html>-level appearance setting at once (startup + after a Settings change). */
export function applyAppearance(s: Settings): void {
  applyAccent(s.accent);
  applyReduceMotion(s.reduceMotion);
  applyEditorMetrics(s.fontSize, s.lineHeight);
}
