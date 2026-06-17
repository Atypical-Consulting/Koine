// A small CodeMirror 6 setup for .koi: a token-level StreamLanguage highlighter (derived
// from the compiler's grammar) plus a lint source wired to the real compiler's diagnostics.
// The authoritative errors come from the wasm compiler; highlighting is best-effort.
import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  StreamLanguage,
  HighlightStyle,
  syntaxHighlighting,
  indentOnInput,
  bracketMatching,
} from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { linter, lintGutter, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
import type { KoineDiagnostic } from './koine';

// --- .koi token highlighter -------------------------------------------------

const KEYWORDS = new Set([
  'context', 'module', 'import', 'version', 'value', 'quantity', 'entity', 'aggregate',
  'enum', 'identified', 'by', 'root', 'as', 'natural', 'sequence', 'guid', 'versioned',
  'invariant', 'matches', 'when', 'if', 'then', 'else', 'command', 'create', 'requires',
  'emit', 'states', 'event', 'integration', 'publishes', 'subscribes', 'spec', 'on',
  'service', 'operation', 'usecase', 'policy', 'repository', 'operations', 'find',
  'readmodel', 'from', 'query', 'now',
]);

const TYPES = new Set([
  'String', 'Int', 'Decimal', 'Bool', 'Instant', 'List', 'Set', 'Map', 'Range',
]);

const koineLanguage = StreamLanguage.define<{ afterMatches: boolean }>({
  name: 'koine',
  startState: () => ({ afterMatches: false }),
  token(stream, state) {
    if (stream.eatSpace()) return null;

    // line comment
    if (stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }
    // regex literal — only right after the `matches` keyword (avoids `/` division clash)
    if (state.afterMatches && stream.peek() === '/') {
      stream.next();
      let escaped = false;
      let ch: string | void;
      while ((ch = stream.next()) != null) {
        if (ch === '/' && !escaped) break;
        escaped = ch === '\\' && !escaped;
      }
      state.afterMatches = false;
      return 'regexp';
    }
    // string
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) {
      state.afterMatches = false;
      return 'string';
    }
    // number
    if (stream.match(/^\d+(\.\d+)?/)) {
      state.afterMatches = false;
      return 'number';
    }
    // doc comment marker handled as comment above; annotations like @since(2)
    if (stream.match(/^@[A-Za-z]+/)) {
      state.afterMatches = false;
      return 'meta';
    }
    // identifiers / keywords / types
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) {
      const word = stream.current();
      state.afterMatches = word === 'matches';
      if (KEYWORDS.has(word)) return 'keyword';
      if (TYPES.has(word)) return 'typeName';
      // Type-ish: CapitalizedNames read as type references
      if (/^[A-Z]/.test(word)) return 'className';
      return 'variableName';
    }
    // operators / punctuation
    if (stream.match(/^(->|<-|=>|==|!=|<=|>=|&&|\|\||[-+*/%<>=!.,:;(){}[\]?])/)) {
      state.afterMatches = false;
      return 'operator';
    }
    stream.next();
    return null;
  },
});

const koineHighlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--koi-accent)', fontWeight: '600' },
  { tag: t.typeName, color: 'var(--koi-cyan)' },
  { tag: t.className, color: 'var(--koi-cyan)' },
  { tag: t.string, color: '#1a8f5a' },
  { tag: t.regexp, color: '#c2410c' },
  { tag: t.number, color: '#9a5b00' },
  { tag: t.comment, color: 'var(--koi-muted)', fontStyle: 'italic' },
  { tag: t.meta, color: '#8a5cf6' },
  { tag: t.operator, color: 'var(--koi-ink-soft)' },
  { tag: t.variableName, color: 'var(--koi-ink)' },
]);

// --- editor factory ---------------------------------------------------------

export interface KoineEditorOptions {
  parent: HTMLElement;
  doc: string;
  /** Called (debounced) when the document changes. */
  onChange?: (doc: string) => void;
  /** Lint source: return diagnostics for the given source. */
  lintSource?: (doc: string) => Promise<KoineDiagnostic[]>;
  readOnly?: boolean;
}

export interface KoineEditor {
  view: EditorView;
  getDoc(): string;
  setDoc(doc: string): void;
  /** Move the cursor to a 1-based line/column and focus. */
  goto(line: number, col: number): void;
  /** Force the linter to re-run. */
  refreshDiagnostics(): void;
  destroy(): void;
}

function toCmDiagnostic(view: EditorView, d: KoineDiagnostic): CmDiagnostic {
  const doc = view.state.doc;
  const clampLine = (l: number) => Math.min(Math.max(l, 1), doc.lines);
  const lineFrom = doc.line(clampLine(d.line));
  const lineTo = doc.line(clampLine(d.endLine || d.line));
  const from = Math.min(lineFrom.from + Math.max(d.col - 1, 0), lineFrom.to);
  let to = Math.min(lineTo.from + Math.max((d.endCol || d.col + 1) - 1, 0), lineTo.to);
  if (to <= from) to = Math.min(from + 1, doc.length);
  return {
    from,
    to,
    severity: d.severity === 'warning' ? 'warning' : 'error',
    message: `${d.code}: ${d.message}`,
  };
}

export function createKoineEditor(opts: KoineEditorOptions): KoineEditor {
  let changeTimer: ReturnType<typeof setTimeout> | undefined;

  const lintExt: Extension = opts.lintSource
    ? linter(
        async (view) => {
          const diags = await opts.lintSource!(view.state.doc.toString());
          return diags.map((d) => toCmDiagnostic(view, d));
        },
        { delay: 350 },
      )
    : [];

  const view = new EditorView({
    parent: opts.parent,
    state: EditorState.create({
      doc: opts.doc,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        koineLanguage,
        syntaxHighlighting(koineHighlight),
        lintGutter(),
        lintExt,
        EditorView.editable.of(!opts.readOnly),
        EditorState.readOnly.of(!!opts.readOnly),
        EditorView.theme({
          '&': { height: '100%', fontSize: '13.5px' },
          '.cm-scroller': { fontFamily: 'var(--koi-font-mono)', lineHeight: '1.6' },
          '.cm-gutters': {
            backgroundColor: 'transparent',
            color: 'var(--koi-muted)',
            border: 'none',
          },
          '.cm-content': { caretColor: 'var(--koi-accent)' },
          '&.cm-focused': { outline: 'none' },
        }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && opts.onChange) {
            clearTimeout(changeTimer);
            const doc = u.state.doc.toString();
            changeTimer = setTimeout(() => opts.onChange!(doc), 300);
          }
        }),
      ],
    }),
  });

  return {
    view,
    getDoc: () => view.state.doc.toString(),
    setDoc(doc: string) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
    },
    goto(line: number, col: number) {
      const ln = Math.min(Math.max(line, 1), view.state.doc.lines);
      const lineInfo = view.state.doc.line(ln);
      const pos = Math.min(lineInfo.from + Math.max(col - 1, 0), lineInfo.to);
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      view.focus();
    },
    refreshDiagnostics() {
      // nudge the linter by dispatching an empty change
      view.dispatch({});
    },
    destroy() {
      clearTimeout(changeTimer);
      view.destroy();
    },
  };
}
