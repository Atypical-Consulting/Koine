// CodeMirror 6 setup for the Playground: an editable .koi editor (token highlighting, keyword
// autocomplete, bracket closing, search, a run shortcut, and live compiler diagnostics) plus a
// read-only, syntax-highlighted viewer for the generated C#/TypeScript output. The authoritative
// errors come from the wasm compiler; highlighting is best-effort.
import { EditorState, Compartment, type Extension } from '@codemirror/state';
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
  defaultHighlightStyle,
  indentOnInput,
  bracketMatching,
} from '@codemirror/language';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completeFromList,
  type CompletionContext,
} from '@codemirror/autocomplete';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { csharp } from '@codemirror/legacy-modes/mode/clike';
import { typescript } from '@codemirror/legacy-modes/mode/javascript';
import { python } from '@codemirror/legacy-modes/mode/python';
import { tags as t } from '@lezer/highlight';
import { linter, lintGutter, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
import type { KoineDiagnostic } from './koine';

// --- .koi token highlighter -------------------------------------------------

const KEYWORDS = [
  'context', 'module', 'import', 'version', 'value', 'quantity', 'entity', 'aggregate',
  'enum', 'identified', 'by', 'root', 'as', 'natural', 'sequence', 'guid', 'versioned',
  'invariant', 'matches', 'when', 'if', 'then', 'else', 'command', 'create', 'requires',
  'emit', 'states', 'event', 'integration', 'publishes', 'subscribes', 'spec', 'on',
  'service', 'operation', 'usecase', 'policy', 'repository', 'operations', 'find',
  'readmodel', 'from', 'query', 'now',
];
const KEYWORD_SET = new Set(KEYWORDS);

const TYPES = ['String', 'Int', 'Decimal', 'Bool', 'Instant', 'List', 'Set', 'Map', 'Range'];
const TYPE_SET = new Set(TYPES);

const koineLanguage = StreamLanguage.define<{ afterMatches: boolean }>({
  name: 'koine',
  startState: () => ({ afterMatches: false }),
  token(stream, state) {
    if (stream.eatSpace()) return null;
    if (stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }
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
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) {
      state.afterMatches = false;
      return 'string';
    }
    if (stream.match(/^\d+(\.\d+)?/)) {
      state.afterMatches = false;
      return 'number';
    }
    if (stream.match(/^@[A-Za-z]+/)) {
      state.afterMatches = false;
      return 'meta';
    }
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) {
      const word = stream.current();
      state.afterMatches = word === 'matches';
      if (KEYWORD_SET.has(word)) return 'keyword';
      if (TYPE_SET.has(word)) return 'typeName';
      if (/^[A-Z]/.test(word)) return 'className';
      return 'variableName';
    }
    if (stream.match(/^(->|<-|=>|==|!=|<=|>=|&&|\|\||[-+*/%<>=!.,:;(){}[\]?])/)) {
      state.afterMatches = false;
      return 'operator';
    }
    stream.next();
    return null;
  },
});

const koineHighlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--koi-hl-keyword)', fontWeight: '600' },
  { tag: t.typeName, color: 'var(--koi-hl-type)' },
  { tag: t.className, color: 'var(--koi-hl-type)' },
  { tag: t.string, color: 'var(--koi-hl-string)' },
  { tag: t.regexp, color: 'var(--koi-hl-regex)' },
  { tag: t.number, color: 'var(--koi-hl-number)' },
  { tag: t.comment, color: 'var(--koi-hl-comment)', fontStyle: 'italic' },
  { tag: t.meta, color: 'var(--koi-hl-meta)' },
  { tag: t.operator, color: 'var(--koi-hl-punct)' },
  { tag: t.punctuation, color: 'var(--koi-hl-punct)' },
  { tag: t.propertyName, color: 'var(--koi-hl-type)' },
  { tag: t.variableName, color: 'var(--koi-fg)' },
  { tag: t.definitionKeyword, color: 'var(--koi-hl-keyword)', fontWeight: '600' },
]);

// Keyword/type autocomplete for the editor.
function koineCompletions(ctx: CompletionContext) {
  const word = ctx.matchBefore(/[A-Za-z_][A-Za-z0-9_]*/);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  return completeFromList([
    ...KEYWORDS.map((k) => ({ label: k, type: 'keyword' })),
    ...TYPES.map((k) => ({ label: k, type: 'type' })),
  ])(ctx);
}

const sharedTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '13.5px' },
  '.cm-scroller': { fontFamily: 'var(--koi-font-mono)', lineHeight: '1.6' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--koi-muted)', border: 'none' },
  '.cm-content': { caretColor: 'var(--koi-accent)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--koi-accent) 6%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--koi-accent)' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--koi-cyan) 22%, transparent)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--koi-cyan) 28%, transparent)' },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'color-mix(in srgb, var(--koi-accent) 40%, transparent)',
  },
  // Find/replace panel — styled to match the blueprint chrome.
  '.cm-panels': { backgroundColor: 'var(--koi-paper-2)', color: 'var(--koi-fg)', borderColor: 'var(--koi-line)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--koi-line)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--koi-line)' },
  '.cm-panel.cm-search': {
    padding: '8px 10px',
    fontFamily: 'var(--koi-font-body)',
    fontSize: '0.82rem',
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '6px',
  },
  '.cm-panel.cm-search label': {
    color: 'var(--koi-muted)',
    fontSize: '0.78rem',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
  },
  '.cm-textfield': {
    backgroundColor: 'var(--koi-surface)',
    color: 'var(--koi-fg)',
    border: '1px solid var(--koi-line)',
    borderRadius: '6px',
    padding: '4px 8px',
    fontFamily: 'var(--koi-font-mono)',
    fontSize: '0.8rem',
  },
  '.cm-textfield:focus-visible': { outline: 'none', borderColor: 'var(--koi-accent)' },
  '.cm-button': {
    backgroundColor: 'var(--koi-surface)',
    backgroundImage: 'none',
    color: 'var(--koi-ink-soft)',
    border: '1px solid var(--koi-line)',
    borderRadius: '6px',
    padding: '4px 9px',
    fontFamily: 'var(--koi-font-mono)',
    fontSize: '0.76rem',
    cursor: 'pointer',
  },
  '.cm-button:hover': { borderColor: 'var(--koi-accent)', color: 'var(--koi-fg)' },
  '.cm-panel.cm-search [name=close]': {
    position: 'absolute',
    top: '4px',
    right: '8px',
    color: 'var(--koi-muted)',
    cursor: 'pointer',
    fontSize: '1.1rem',
    padding: '0 4px',
    background: 'transparent',
    border: '0',
  },
  '.cm-panel.cm-search [name=close]:hover': { color: 'var(--koi-fg)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--koi-surface)',
    border: '1px solid var(--koi-line)',
    borderRadius: '6px',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--koi-accent)',
    color: 'var(--koi-on-accent)',
  },
});

// --- editable editor --------------------------------------------------------

export interface KoineEditorOptions {
  parent: HTMLElement;
  doc: string;
  onChange?: (doc: string) => void;
  lintSource?: (doc: string) => Promise<KoineDiagnostic[]>;
}

export interface KoineEditor {
  view: EditorView;
  getDoc(): string;
  setDoc(doc: string): void;
  goto(line: number, col: number): void;
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
        closeBrackets(),
        highlightSelectionMatches(),
        search({ top: true }),
        autocompletion({ override: [koineCompletions], icons: false }),
        keymap.of([...closeBracketsKeymap, ...searchKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
        koineLanguage,
        syntaxHighlighting(koineHighlight),
        lintGutter(),
        lintExt,
        sharedTheme,
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
    destroy() {
      clearTimeout(changeTimer);
      view.destroy();
    },
  };
}

// --- read-only output viewer ------------------------------------------------

export type OutputLang = 'csharp' | 'typescript' | 'python' | 'plain';

const langExt = (lang: OutputLang): Extension => {
  if (lang === 'csharp') return StreamLanguage.define(csharp);
  if (lang === 'typescript') return StreamLanguage.define(typescript);
  if (lang === 'python') return StreamLanguage.define(python);
  return [];
};

/** Presentation-only map from an emit-target id to the output viewer's syntax-highlight mode. This is
 *  the one thing the dynamic target list (koine.ts `listEmitTargets`) can't carry — the backend
 *  doesn't know CodeMirror modes — so it lives here keyed by id, NOT as a second list of which targets
 *  exist. Any id without an entry (a newly-shipped target, e.g. rust/docs/asyncapi) degrades to plain
 *  text. */
const HIGHLIGHT_MODE_BY_TARGET: Record<string, OutputLang> = {
  csharp: 'csharp',
  typescript: 'typescript',
  python: 'python',
};

/** The output-viewer highlight mode for an emit-target id; unknown ids degrade to plain text (#438). */
export function highlightModeForTarget(targetId: string): OutputLang {
  return HIGHLIGHT_MODE_BY_TARGET[targetId] ?? 'plain';
}

export interface OutputView {
  setContent(text: string, lang: OutputLang): void;
  destroy(): void;
}

/** A read-only, syntax-highlighted, line-numbered viewer for generated output. */
export function createOutputView(parent: HTMLElement): OutputView {
  const language = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: '',
      extensions: [
        lineNumbers(),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        highlightSelectionMatches(),
        search({ top: true }),
        keymap.of(searchKeymap),
        language.of(langExt('csharp')),
        syntaxHighlighting(koineHighlight),
        syntaxHighlighting(defaultHighlightStyle),
        sharedTheme,
      ],
    }),
  });

  return {
    setContent(text, lang) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        effects: language.reconfigure(langExt(lang)),
      });
    },
    destroy: () => view.destroy(),
  };
}
