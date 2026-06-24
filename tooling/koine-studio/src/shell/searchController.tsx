// Workspace search panel: a thin, non-modal Preact panel that floats over the editor and runs the
// pure search core (workspaceSearch.ts) over every .koi file in the open folder. It owns no app
// state — the shell injects the four seams it needs (list the files, read a closed file, reveal a
// match, snapshot the open buffers) so this stays testable without a host fs or a live editor.
//
// Search corpus rule: a file's LIVE (possibly unsaved) buffer text wins over its on-disk text, so
// results reflect what the user is actually editing; closed files are read through the host fs.
//
// Replace (the "Replace with" field + per-file / across-files apply) is layered on in a later task;
// this file is search + go-to-match only.
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { el } from '@/shared/el';
import { runSearch, type FileMatches, type Match, type SearchQuery } from '@/shell/workspaceSearch';

/** The shell-provided seams the panel drives — everything it can't (and shouldn't) own itself. */
export interface SearchPanelOptions {
  /** Every searchable .koi uri under the open folder (skip-list applied); `[]` when no folder is open. */
  listFiles(glob?: string): Promise<string[]>;
  /** A closed file's on-disk text by uri, or null when it can't be read. */
  readFile(uri: string): Promise<string | null>;
  /** Open the file (if needed), make it active, and select the match's range in the editor. */
  openAndReveal(uri: string, match: Match): void | Promise<void>;
  /** Snapshot of every open buffer's live text, keyed by uri (so unsaved edits are searched). */
  getActiveBuffers(): Map<string, string>;
  /** A short display label for a uri (the workspace-relative path), for the results tree. */
  labelOf(uri: string): string;
}

/** Imperative handle the shell wires to the Mod-Shift-F shortcut / command palette. */
export interface SearchPanelHandle {
  open(): void;
  close(): void;
  toggle(): void;
  /** Open the panel and move focus into the query field. */
  focus(): void;
  readonly isOpen: boolean;
}

interface SearchPanelProps extends SearchPanelOptions {
  visible: boolean;
  onClose(): void;
}

/**
 * Build the searchable corpus: prefer a file's live buffer text (unsaved edits included), fall back
 * to its on-disk text, and include any open buffers that aren't under the listed folder set (e.g. a
 * transient single-file workspace).
 */
async function buildCorpus(opts: SearchPanelOptions): Promise<{ uri: string; text: string }[]> {
  const uris = await opts.listFiles();
  const live = opts.getActiveBuffers();
  const corpus: { uri: string; text: string }[] = [];
  const seen = new Set<string>();
  for (const uri of uris) {
    seen.add(uri);
    const text = live.get(uri) ?? (await opts.readFile(uri));
    if (text != null) corpus.push({ uri, text });
  }
  for (const [uri, text] of live) if (!seen.has(uri)) corpus.push({ uri, text });
  return corpus;
}

/** The panel body. Exported for unit tests; the shell uses {@link createSearchPanel}. */
export function SearchPanel(props: SearchPanelProps) {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [include, setInclude] = useState('');
  const [files, setFiles] = useState<FileMatches[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Re-run the search (debounced) whenever the query / toggles / include change, and whenever the
  // panel is (re)opened — so results reflect the current buffers and on-disk files each time.
  useEffect(() => {
    if (!props.visible) return;
    if (query === '') {
      setFiles([]);
      setError(null);
      return;
    }
    let cancelled = false;
    const id = setTimeout(() => {
      const q: SearchQuery = { text: query, caseSensitive, wholeWord, regex, include };
      void buildCorpus(props).then((corpus) => {
        if (cancelled) return;
        const outcome = runSearch(corpus, q);
        setFiles(outcome.files);
        setError(outcome.error);
      });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
    // props seams are stable references from the factory; the listed inputs are what change a search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive, wholeWord, regex, include, props.visible]);

  const total = files.reduce((n, f) => n + f.matches.length, 0);
  const summary = error
    ? ''
    : query === ''
      ? 'Type to search across the workspace'
      : files.length === 0
        ? 'No results'
        : `${total} result${total === 1 ? '' : 's'} in ${files.length} file${files.length === 1 ? '' : 's'}`;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      props.onClose();
    }
  };

  return (
    <div class="koi-search" role="region" aria-label="Workspace search" hidden={!props.visible} onKeyDown={onKeyDown}>
      <div class="koi-search-head">
        <input
          class="koi-search-query"
          type="text"
          placeholder="Search"
          aria-label="Search text"
          autocomplete="off"
          spellcheck={false}
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />
        <div class="koi-search-toggles" role="group" aria-label="Search options">
          <button
            type="button"
            class="koi-search-toggle"
            aria-pressed={caseSensitive}
            title="Match case"
            onClick={() => setCaseSensitive((v) => !v)}
          >
            Aa
          </button>
          <button
            type="button"
            class="koi-search-toggle"
            aria-pressed={wholeWord}
            title="Match whole word"
            onClick={() => setWholeWord((v) => !v)}
          >
            ab
          </button>
          <button
            type="button"
            class="koi-search-toggle"
            aria-pressed={regex}
            title="Use regular expression"
            onClick={() => setRegex((v) => !v)}
          >
            .*
          </button>
        </div>
        <button type="button" class="koi-search-close" aria-label="Close search" title="Close (Esc)" onClick={props.onClose}>
          ✕
        </button>
      </div>
      <input
        class="koi-search-include"
        type="text"
        placeholder="files to include (e.g. *.koi)"
        aria-label="Files to include"
        autocomplete="off"
        spellcheck={false}
        value={include}
        onInput={(e) => setInclude((e.target as HTMLInputElement).value)}
      />
      {error && (
        <div class="koi-search-error" role="alert">
          {error}
        </div>
      )}
      <div class="koi-search-summary" aria-live="polite">
        {summary}
      </div>
      <div class="koi-search-results" role="tree" aria-label="Search results">
        {files.map((file) => (
          <div class="koi-search-file" role="treeitem" aria-expanded="true" key={file.uri}>
            <div class="koi-search-file-head">
              <span class="koi-search-file-name" title={props.labelOf(file.uri)}>
                {props.labelOf(file.uri)}
              </span>
              <span class="koi-search-file-count">{file.matches.length}</span>
            </div>
            <div role="group">
              {file.matches.map((m, i) => (
                <button
                  type="button"
                  class="koi-search-match"
                  role="treeitem"
                  key={`${m.line}:${m.column}:${i}`}
                  title={`Line ${m.line}`}
                  onClick={() => void props.openAndReveal(file.uri, m)}
                >
                  <span class="koi-search-match-line">{m.line}</span>
                  <span class="koi-search-match-preview">
                    {m.preview.slice(0, m.column)}
                    <mark>{m.preview.slice(m.column, m.column + m.length)}</mark>
                    {m.preview.slice(m.column + m.length)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Mount the search panel into the document (once) and return the imperative handle the shell drives.
 * The panel is non-modal: it floats over the editor and stays mounted across open/close (a prop flip),
 * so the last query and results survive a toggle.
 */
export function createSearchPanel(opts: SearchPanelOptions): SearchPanelHandle {
  const host = el('div', { class: 'koi-search-host' });
  document.body.appendChild(host);
  let isOpen = false;
  let opener: HTMLElement | null = null; // element focused before the panel opened, restored on close

  function paint(): void {
    render(<SearchPanel {...opts} visible={isOpen} onClose={close} />, host);
  }

  function open(): void {
    if (isOpen) return;
    opener = document.activeElement as HTMLElement | null;
    isOpen = true;
    paint();
  }

  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    paint();
    opener?.focus?.();
    opener = null;
  }

  function focus(): void {
    open();
    // Focus after the render flushes so the (now-visible) query input exists and accepts focus.
    requestAnimationFrame(() => {
      const input = host.querySelector<HTMLInputElement>('.koi-search-query');
      input?.focus();
      input?.select();
    });
  }

  paint(); // mount once, hidden — toggling afterward is just a visibility prop flip
  return {
    open,
    close,
    focus,
    toggle() {
      if (isOpen) close();
      else focus();
    },
    get isOpen() {
      return isOpen;
    },
  };
}
