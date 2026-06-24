// The CodeMirror 6 surface for inline (ghost-text) AI completions. It renders whatever the pure state
// machine (inlineCompletionState.ts) is showing as a dimmed inline widget after the caret, drives that
// machine from editor activity, and binds Tab (accept) / Esc (dismiss). The thinking lives in the state
// machine and the AI client; this file is purely the CodeMirror glue.
//
// It is deliberately kept SEPARATE from, and non-conflicting with, the deterministic LSP completion
// popup: while that popup is open we suppress ghost text entirely, and our Tab/Esc handlers fall through
// (return false) whenever there is no suggestion, so the popup keeps its own keys.
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { Prec, StateEffect, type Extension } from '@codemirror/state';
import type { InlineState } from './inlineCompletionState';
import type { InlineRequestContext } from '@/ai/inlineCompletionClient';

/** The editor-side context: what the client needs (before/after/uri) plus the gating flags the state
 *  machine's `canSuggest` reads. Passing the superset to `requestInline` is fine — it reads only the
 *  fields it declares. */
export interface EditorInlineContext extends InlineRequestContext {
  /** True when there is a non-empty selection (never suggest over a selection). */
  hasSelection: boolean;
  /** True when the caret sits at a sensible boundary (nothing but whitespace remains on the line). */
  atBoundary: boolean;
}

export interface InlineCompletionDeps {
  /** The shared state machine (created in editor.ts and wired to the AI client + prefs toggle). */
  state: InlineState<EditorInlineContext>;
  /** The prefs toggle gate (default off) — re-read on every edit so toggling takes effect at once. */
  isEnabled: () => boolean;
  /** True while the deterministic LSP completion popup is open; ghost text is suppressed then. */
  lspPopupOpen: (view: EditorView) => boolean;
}

// Only the last/next slice of the buffer is sent — recent context is what matters for a continuation,
// and a cap keeps token spend (and latency) bounded on large models.
const MAX_BEFORE = 2000;
const MAX_AFTER = 500;

// Dispatched purely to make the ViewPlugin re-evaluate its decorations after an async suggestion
// resolves — that resolution happens outside any transaction, so we need a transaction to react to it.
const redrawEffect = StateEffect.define<null>();

/** Snapshot the buffer around the caret plus the gating flags the state machine needs. */
function buildContext(view: EditorView): EditorInlineContext {
  const { state } = view;
  const sel = state.selection.main;
  const head = sel.head;
  const line = state.doc.lineAt(head);
  return {
    before: state.sliceDoc(Math.max(0, head - MAX_BEFORE), head),
    after: state.sliceDoc(head, Math.min(state.doc.length, head + MAX_AFTER)),
    uri: '', // reserved — the client does not yet send the uri to the model
    hasSelection: !sel.empty,
    atBoundary: state.sliceDoc(head, line.to).trim().length === 0,
  };
}

/** The dimmed inline widget that paints the suggestion after the caret. */
class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: GhostWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-inline-suggestion';
    // pre-wrap (set in the theme) renders a multi-line prediction with its real shape.
    span.textContent = this.text;
    return span;
  }
}

const ghostTheme = EditorView.baseTheme({
  '.cm-inline-suggestion': {
    opacity: '0.4', // dims the editor foreground, so it adapts to both the dark and light themes
    whiteSpace: 'pre-wrap',
  },
});

/**
 * Build the inline-completion extension: a ViewPlugin that feeds the state machine from editor activity
 * and renders its suggestion, plus a high-precedence Tab/Esc keymap to accept/dismiss.
 */
export function inlineCompletionExtension(deps: InlineCompletionDeps): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      // True only while inside update(); a synchronous state transition during onType() must NOT
      // dispatch a redraw (we'd re-enter dispatch) — the in-flight update rebuilds decorations itself.
      private updating = false;

      constructor(view: EditorView) {
        deps.state.onChange = () => {
          if (!this.updating) view.dispatch({ effects: redrawEffect.of(null) });
        };
      }

      update(u: ViewUpdate): void {
        this.updating = true;
        try {
          if (u.docChanged) {
            // A real edit: (re)start a suggestion, or clear it when off / a popup is up.
            if (deps.isEnabled() && !deps.lspPopupOpen(u.view)) {
              deps.state.onType(buildContext(u.view));
            } else {
              deps.state.dismiss();
            }
          } else if (u.selectionSet) {
            // Caret moved without typing → any shown suggestion no longer fits; drop it.
            deps.state.dismiss();
          }
          this.decorations = this.build(u.view);
        } finally {
          this.updating = false;
        }
      }

      private build(view: EditorView): DecorationSet {
        const sug = deps.state.suggestion;
        if (deps.state.status !== 'showing' || !sug) return Decoration.none;
        // Re-check the gates at paint time: a suggestion that resolved after the toggle went off, or
        // while the LSP popup opened, must not appear.
        if (!deps.isEnabled() || deps.lspPopupOpen(view)) return Decoration.none;
        const head = view.state.selection.main.head;
        return Decoration.set([Decoration.widget({ widget: new GhostWidget(sug), side: 1 }).range(head)]);
      }

      destroy(): void {
        deps.state.onChange = null;
        deps.state.dismiss();
      }
    },
    { decorations: (v) => v.decorations },
  );

  // Highest precedence so Tab accepts a ghost before indentWithTab indents — but only when one is
  // showing; otherwise the handlers return false and Tab/Esc keep their normal behavior (indent, and
  // close the LSP popup respectively).
  const acceptKeymap = Prec.highest(
    keymap.of([
      {
        key: 'Tab',
        run: (view) => {
          if (deps.state.status !== 'showing') return false;
          const text = deps.state.accept();
          if (!text) return false;
          const head = view.state.selection.main.head;
          view.dispatch({
            changes: { from: head, insert: text },
            selection: { anchor: head + text.length },
            userEvent: 'input.complete',
          });
          return true;
        },
      },
      {
        key: 'Escape',
        run: (view) => {
          if (deps.state.status !== 'showing') return false;
          deps.state.dismiss();
          view.dispatch({ effects: redrawEffect.of(null) });
          return true;
        },
      },
    ]),
  );

  return [plugin, acceptKeymap, ghostTheme];
}
