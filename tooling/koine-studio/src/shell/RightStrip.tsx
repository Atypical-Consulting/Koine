import type { JSX } from 'preact';

/** The right-rail view a stripe button opens/closes. Mirrors Koine Studio's `RightView` union
 *  (`tooling/koine-studio/src/store/slices/uiChrome.ts`) but is declared locally so this
 *  component carries no import from Studio's store — @atypical/koine-ui stays store-free. Keep
 *  this list in sync with `RightView` if a right-rail tool window is ever added or removed. */
type RightStripView = 'props' | 'assistant' | 'source-control';

// RightStrip: the right-edge tool-window stripe's buttons as a Preact component (#759, finishing the #193
// migration — replaces the imperative `rightStripMarkup()` string builder injected via innerHTML at boot).
// `index.html` keeps <aside id="right-strip" role="toolbar"> a thin shell; ide.tsx renders this into it.
//
// Rider-style: a slim vertical bar of icon toggles, one per right-rail RightView, each opening/closing
// (or switching) the #right Properties panel. The toggle/switch/collapse behaviour and the live
// aria-pressed state stay owned by inspectorController (#500): it captures these `.rstrip-btn` nodes once
// after mount and mutates their aria-pressed on every view/collapse change. So this component renders the
// buttons ONCE and never re-renders (no store subscription) — Preact never reconciles away the
// controller's imperative aria-pressed writes or its captured node references. Every button ships
// aria-pressed="false" here as the pre-wiring default, exactly as the string builder did.

/** One stripe toggle: the RightView it controls, its accessible name/tooltip, and its 16×16 line icon. */
interface StripeButton {
  view: RightStripView;
  /** Accessible name (aria-label) + the custom left-pointing hover/focus tooltip text (`data-tooltip`,
   *  styled in _inspector.scss). Rider shows the tool-window name on its stripe icons. */
  label: string;
  /** The 16×16 line-icon children (the toolbar's stroked idiom), reusing the prefs/spark/git glyphs. */
  icon: JSX.Element;
}

/** The toggles, top-to-bottom, in right-view order (Properties first; AI Chat second). Rules and Notes
 *  were retired (#730): a selected element's invariants surface in the Properties panel's Invariants
 *  section, and model Notes live in the center Deck's Docs surface — so neither needs its own stripe. */
const STRIPE_BUTTONS: readonly StripeButton[] = [
  {
    view: 'props',
    label: 'Properties',
    // Prefs sliders — reuses the #btn-prefs glyph.
    icon: (
      <>
        <path d="M2.5 5.5h11M2.5 10.5h11" />
        <circle cx="6" cy="5.5" r="1.7" />
        <circle cx="10" cy="10.5" r="1.7" />
      </>
    ),
  },
  {
    view: 'assistant',
    label: 'AI Chat',
    // Spark — the brand's "this generates" glyph, the same mark the AI tab wore in the center.
    icon: (
      <>
        <path d="M6.5 1.8c.5 2.6 1.6 3.7 4.2 4.2-2.6.5-3.7 1.6-4.2 4.2-.5-2.6-1.6-3.7-4.2-4.2 2.6-.5 3.7-1.6 4.2-4.2Z" />
        <path d="M12 9.4c.2 1.1.6 1.5 1.7 1.7-1.1.2-1.5.6-1.7 1.7-.2-1.1-.6-1.5-1.7-1.7 1.1-.2 1.5-.6 1.7-1.7Z" />
      </>
    ),
  },
  {
    view: 'source-control',
    label: 'Source Control',
    // Git-branch — a trunk with a branch curving back into it.
    icon: (
      <>
        <circle cx="4.5" cy="4" r="1.6" />
        <circle cx="4.5" cy="12" r="1.6" />
        <circle cx="11.5" cy="4" r="1.6" />
        <path d="M4.5 5.6v4.8M11.5 5.6v1.2a3 3 0 0 1-3 3H4.5" />
      </>
    ),
  },
];

/** The stripe's buttons: one icon toggle per RightView. Each carries a `data-tooltip` CSS reveals as a
 *  left-pointing label on hover/focus (the stripe hugs the viewport's right edge, so the tooltip opens
 *  inward), and `aria-controls="right"` tying it to the panel it opens. The controller flips each
 *  button's aria-pressed as the panel opens, closes, or switches view. Rendered once into #right-strip. */
export function RightStrip(): JSX.Element {
  return (
    <>
      {STRIPE_BUTTONS.map(({ view, label, icon }) => (
        <button
          type="button"
          class="rstrip-btn"
          data-rview={view}
          data-tooltip={label}
          aria-label={label}
          aria-controls="right"
          aria-pressed="false"
          key={view}
        >
          <svg class="tb-ico" viewBox="0 0 16 16" aria-hidden="true">
            {icon}
          </svg>
        </button>
      ))}
    </>
  );
}
