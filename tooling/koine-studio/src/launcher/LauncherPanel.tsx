// The Spotlight launcher's overlay shell: scrim + card + input row + prefix-mode pill + footer legend
// (issue #1143, task 3), extended (task 4) to fill `.lx-results` with grouped, ranked result rows. No
// preview pane (Task 5), no per-result actions (Task 6), no full keyboard nav beyond Esc (Task 7) —
// `selected` is always false this task; a later task supplies the selection index.
import { useEffect, useRef, useState } from 'preact/hooks';
import { buildCatalog, type LauncherSources } from '@/launcher/buildCatalog';
import { MODES, PREFIX_CHARS, parseMode, type CatalogEntry } from '@/launcher/catalog';
import { deriveResults } from '@/launcher/deriveResults';
import { ResultRow } from '@/launcher/ResultRow';

export interface LauncherPanelProps {
  sources: LauncherSources;
  visible: boolean;
  onClose(): void;
}

/** The panel body. Exported for unit tests; the shell mounts it via {@link createLauncher}. */
export function LauncherPanel(props: LauncherPanelProps) {
  const { sources, visible, onClose } = props;
  const [input, setInput] = useState('');
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const { mode, query } = parseMode(input);
  // Flips once a selected result exposes a preview() to show (Task 5); always false this task.
  const hasPreview = false;
  // Grouped/ranked results (Task 4) — see deriveResults.ts for the empty-query default vs. ranked-and-
  // grouped derivation. `visible` (unused here) is the same flat top-to-bottom row order Task 7's
  // selection reducer and Task 5's preview need; re-derive it from (catalog, mode, query) rather than
  // threading it through props, since deriveResults is a pure function those tasks can call directly.
  const { sections } = deriveResults(catalog, mode, query);

  // Load the live catalog once per open so the count reflects real data; guarded against the panel
  // closing/unmounting before the join resolves (buildCatalog awaits the model index + git log).
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void buildCatalog(sources).then((entries) => {
      if (!cancelled) setCatalog(entries);
    });
    return () => {
      cancelled = true;
    };
    // sources is a stable seam reference from the factory (mirrors searchController's props seam).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Focus (and select) the query field once the now-visible input exists — after the paint that
  // flips `hidden` off — mirroring createSearchPanel's rAF-timed focus.
  useEffect(() => {
    if (!visible) return;
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [visible]);

  // Start the next open with a clean query, matching the prototype's open() reset.
  useEffect(() => {
    if (!visible) setInput('');
  }, [visible]);

  function clearMode(): void {
    setInput((value) => value.slice(1));
    inputRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div
      class="lx-scrim"
      role="dialog"
      aria-modal="true"
      aria-label="Command launcher"
      hidden={!visible}
      onKeyDown={onKeyDown}
    >
      <div class={hasPreview ? 'lx has-preview' : 'lx'}>
        <div class="lx-inrow">
          <svg class="lx-search" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="1.4" />
            <path d="M10.2 10.2 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
          {mode.key !== MODES.all.key && (
            <span class="lx-modepill">
              <span class="lx-modepill-label">{mode.label}</span>
              <button type="button" class="mp-x" aria-label="Clear mode" title="Clear mode" onClick={clearMode}>
                <svg class="ico" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" />
                </svg>
              </button>
            </span>
          )}
          <input
            ref={inputRef}
            id="lx-input"
            name="lx-input"
            class="lx-input"
            type="text"
            autocomplete="off"
            spellcheck={false}
            aria-label="Search commands, symbols, files…"
            placeholder="Search the model — symbols, events, files, commands…"
            value={input}
            onInput={(e) => setInput((e.target as HTMLInputElement).value)}
          />
          <span class="lx-count">{catalog.length}</span>
          <kbd class="lx-esc">esc</kbd>
        </div>
        <div class="lx-body">
          <div class="lx-results" role="listbox" aria-label="Results" data-mode={mode.key} data-query={query}>
            {sections.length === 0 && (
              <div class="lx-empty">
                <div class="le-big">No matches for "{query}"</div>
                Try a different term, or a mode: <b>&gt;</b> commands · <b>@</b> symbols · <b>#</b> events
              </div>
            )}
            {sections.map((section) => (
              <div class="lx-group" key={section.label}>
                <div class="lx-group-label">
                  {section.label}
                  <span class="gl-n">{section.rows.length}</span>
                </div>
                {section.rows.map((row) => (
                  <ResultRow key={row.entry.id} result={row} selected={false} />
                ))}
              </div>
            ))}
          </div>
        </div>
        <div class="lx-footer">
          <span class="lx-hint">
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span class="lx-hint">
            <kbd>↵</kbd> open
          </span>
          <span class="lx-hint">
            <kbd>⌘</kbd>
            <kbd>K</kbd> actions
          </span>
          <span class="lx-hint">
            <kbd>tab</kbd> fill
          </span>
          <div class="lx-legend">
            {PREFIX_CHARS.map((prefix) => {
              const m = MODES[prefix];
              return (
                <button
                  type="button"
                  key={m.key}
                  class={mode.key === m.key ? 'lx-mchip on' : 'lx-mchip'}
                  data-mode={m.key}
                  title={m.hint}
                  onClick={() => {
                    setInput(m.prefix);
                    inputRef.current?.focus();
                  }}
                >
                  <b>{m.prefix}</b>
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
