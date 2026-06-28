// rightStrip: the single source of truth for the right-edge tool-window stripe's INNER markup (#500).
// ide.tsx's boot injects this into <aside id="right-strip" role="toolbar">, so index.html stays a thin
// shell and the stripe can never drift from the data-rview ids inspectorController wires.
//
// Rider-style: a slim vertical bar of icon toggles, one per right-rail RightView, each opening/closing
// (or switching) the #right Properties panel. The aside owns the toolbar role + accessible name; this
// builder owns the buttons. The toggle/switch/collapse behaviour + the live aria-pressed state land in
// inspectorController (Task 4); every button ships aria-pressed="false" here as the pre-wiring default.

import type { RightView } from '@/store/slices/uiChrome';

/** One stripe toggle: which RightView it controls, its accessible name/tooltip, and its line-icon glyph
 *  (the toolbar's stroked 16×16 idiom, reusing the prefs/notes/git glyphs already in the shell). */
interface StripeButton {
  view: RightView;
  /** Accessible name (aria-label) + the text of the custom left-pointing hover/focus tooltip
   *  (`data-tooltip`, styled in _inspector.scss). Rider shows the tool-window name on its stripe icons. */
  label: string;
  /** Inner SVG path/shape markup for the 16×16 line icon. */
  icon: string;
}

/** The four toggles, top-to-bottom, in right-view order (Properties first). */
const STRIPE_BUTTONS: readonly StripeButton[] = [
  {
    view: 'props',
    label: 'Properties',
    // Prefs sliders — reuses the #btn-prefs glyph.
    icon: '<path d="M2.5 5.5h11M2.5 10.5h11" /><circle cx="6" cy="5.5" r="1.7" /><circle cx="10" cy="10.5" r="1.7" />',
  },
  {
    view: 'rules',
    label: 'Rules',
    // Checklist — two checked items (business rules / invariants).
    icon: '<path d="M2.5 4.5 3.6 5.6 5.6 3.6M7.5 4.6h6M2.5 10.5 3.6 11.6 5.6 9.6M7.5 10.6h6" />',
  },
  {
    view: 'notes',
    label: 'Notes',
    // Pencil — reuses the rail docs-footer Notes glyph.
    icon: '<path d="M10.4 3.1 12.9 5.6 6.1 12.4 3 13 3.6 9.9Z" /><path d="M9.2 4.3 11.7 6.8" />',
  },
  {
    view: 'source-control',
    label: 'Source Control',
    // Git-branch — a trunk with a branch curving back into it.
    icon: '<circle cx="4.5" cy="4" r="1.6" /><circle cx="4.5" cy="12" r="1.6" /><circle cx="11.5" cy="4" r="1.6" /><path d="M4.5 5.6v4.8M11.5 5.6v1.2a3 3 0 0 1-3 3H4.5" />',
  },
];

/** The stripe's inner markup: one icon toggle button per RightView, each carrying a `data-tooltip` that
 *  CSS reveals as a left-pointing label on hover/focus (the stripe hugs the viewport's right edge, so the
 *  tooltip opens inward). Injected at boot into the #right-strip toolbar aside; the controller flips each
 *  button's aria-pressed as the panel opens, closes, or switches view. */
export function rightStripMarkup(): string {
  return STRIPE_BUTTONS.map(
    ({ view, label, icon }) => `
    <button type="button" class="rstrip-btn" data-rview="${view}" data-tooltip="${label}" aria-label="${label}" aria-controls="right" aria-pressed="false">
      <svg class="tb-ico" viewBox="0 0 16 16" aria-hidden="true">${icon}</svg>
    </button>`,
  ).join('');
}
