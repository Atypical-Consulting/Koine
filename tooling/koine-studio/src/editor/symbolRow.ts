// The focus-gated DSL symbol accessory row (#221). On a phone there is no physical keyboard for the
// punctuation Koine leans on (`->`, `«`, `=>`, …), and the soft keyboard buries them behind shift
// layers. This renders a horizontally-scrollable strip of one-tap token buttons that sits above the
// soft keyboard while the editor has focus. Each tap inserts at the caret WITHOUT moving focus out of
// the editor — the keyboard stays up — because the buttons preventDefault their `mousedown` (the
// pointer event that would otherwise blur the CM6 content before the click fires).
// Type-only: `EditorView` is only ever a parameter type here, so importing it as a value would pull
// the whole @codemirror/view runtime into any module (and test) that touches the symbol row. Keeping
// it type-only lets the a11y test scan the row with a plain stub and avoids a happy-dom/axe deadlock
// that the live CM runtime otherwise triggers.
import type { EditorView } from '@codemirror/view';

/** One token button: the literal inserted at the caret, a screen-reader name, and a safe DOM slug. */
interface SymbolToken {
  /** The exact text inserted at the caret (the glyph shown on the button). */
  token: string;
  /** Accessible name announced for the button (the glyph alone is not descriptive). */
  label: string;
  /**
   * A stable, attribute-safe identifier for `data-token` (the test/wiring hook). The glyph is NEVER
   * put in an attribute value: a `"` token would otherwise produce `data-token='"'`, which axe-core's
   * selector generation chokes on under happy-dom. The slug sidesteps that — the glyph lives only in
   * textContent (safe) and the inserted literal is `token`.
   */
  slug: string;
}

// The DSL punctuation a Koine author reaches for most, in the order they appear on the strip. Guillemets
// frame stereotypes (`«aggregate root»`); the arrows drive transitions/lambdas; the rest are structural.
const TOKENS: SymbolToken[] = [
  { token: '->', label: 'Arrow', slug: 'arrow' },
  { token: '=>', label: 'Fat arrow', slug: 'fat-arrow' },
  { token: ':', label: 'Colon', slug: 'colon' },
  { token: '{', label: 'Open brace', slug: 'open-brace' },
  { token: '}', label: 'Close brace', slug: 'close-brace' },
  { token: '«', label: 'Open guillemet', slug: 'open-guillemet' },
  { token: '»', label: 'Close guillemet', slug: 'close-guillemet' },
  { token: '/', label: 'Slash', slug: 'slash' },
  { token: '@', label: 'At sign', slug: 'at-sign' },
  { token: '|', label: 'Pipe', slug: 'pipe' },
  { token: '(', label: 'Open paren', slug: 'open-paren' },
  { token: ')', label: 'Close paren', slug: 'close-paren' },
  { token: '"', label: 'Quote', slug: 'quote' },
];

/**
 * Replace the editor's current selection with `token` and collapse the caret to just past it. A plain
 * caret (empty selection) becomes a straight insertion; a range becomes a replacement. Re-focuses the
 * view so the keyboard stays up after the tap.
 */
export function insertToken(view: EditorView, token: string): void {
  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: { from, to, insert: token },
    selection: { anchor: from + token.length },
    scrollIntoView: true,
  });
  view.focus();
}

/** Handle returned by {@link mountSymbolRow}; `destroy()` removes the strip from its host. */
export interface SymbolRowHandle {
  destroy(): void;
}

/**
 * Render the DSL symbol accessory row into `host` and return a teardown handle. The strip is a
 * `role="toolbar"` of token buttons; tapping one calls {@link insertToken}. Each button preventDefaults
 * its `mousedown` so the editor never loses focus (and the soft keyboard never collapses) on tap. The
 * caller owns when the strip is visible (it is shown only while the editor is focused on a narrow
 * viewport — see editorSession); this function just builds the DOM.
 */
export function mountSymbolRow(view: EditorView, host: HTMLElement): SymbolRowHandle {
  const toolbar = document.createElement('div');
  toolbar.className = 'koi-symbol-row';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Insert Koine symbol');

  for (const { token, label, slug } of TOKENS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'koi-symbol-btn';
    btn.dataset.token = slug; // attribute-safe slug; the glyph stays in textContent (see SymbolToken)
    btn.setAttribute('aria-label', label);
    btn.textContent = token;
    // Keep the editor focused: a pointer-down on the button would blur the CM6 content (collapsing the
    // soft keyboard) before the click lands, so swallow the default while still letting `click` fire.
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => insertToken(view, token));
    toolbar.appendChild(btn);
  }

  host.appendChild(toolbar);

  return {
    destroy(): void {
      toolbar.remove();
    },
  };
}
