// The Spotlight launcher's overlay shell: scrim + card + input row + prefix-mode pill + footer legend
// (issue #1143, task 3), extended (task 4) to fill `.lx-results` with grouped, ranked result rows, and
// (task 5) to resolve + render the live PREVIEW pane for the selected result. Per-result quick actions
// (task 6, this task) add the `.lx-actmenu` popover + `.lx-toast` confirmation, wired through the
// injected `LauncherActionDeps` seam (Task 8 binds the concrete effects). Full ↑/↓ keyboard nav (Task 7)
// still isn't wired — "selected" is always the FIRST visible row (`deriveResults(...).visible[0]`) until
// Task 7 supplies real keyboard-driven selection state; `menuOpen`/`menuIndex` below are tracked as
// plain state in this same component so Task 7's keyboard handler can drive them directly. No extra
// join is needed for the preview: `buildCatalog` (task 5) already attaches each symbol/event/rule
// entry's joined `ModelElement`, so `previewFor(selected.entry, {})` reads straight off the catalog.
import { useEffect, useRef, useState } from 'preact/hooks';
import { actionsFor, type LauncherActionDeps } from '@/launcher/actions';
import { ActionMenu } from '@/launcher/ActionMenu';
import { buildCatalog, type LauncherSources } from '@/launcher/buildCatalog';
import { MODES, PREFIX_CHARS, parseMode, type CatalogEntry } from '@/launcher/catalog';
import { deriveResults } from '@/launcher/deriveResults';
import { previewFor } from '@/launcher/preview';
import { PreviewPane } from '@/launcher/PreviewPane';
import { ResultRow } from '@/launcher/ResultRow';

/** How long a `.lx-toast` confirmation stays visible before auto-clearing (README §2/SEAMS: "~1.6s"). */
const TOAST_DURATION_MS = 1600;

export interface LauncherPanelProps {
  sources: LauncherSources;
  visible: boolean;
  onClose(): void;
  /** The quick-action effect seam (issue #1143, task 6) — Task 8 supplies the concrete binding to
   * `lsp`/`platform`/`openUri`/clipboard; tests pass a stub (see `LauncherPanel.test.tsx`'s `makeActionDeps`). */
  actionDeps: LauncherActionDeps;
}

/** The panel body. Exported for unit tests; the shell mounts it via {@link createLauncher}. */
export function LauncherPanel(props: LauncherPanelProps) {
  const { sources, visible, onClose, actionDeps } = props;
  const [input, setInput] = useState('');
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { mode, query } = parseMode(input);
  // Grouped/ranked results (Task 4) — see deriveResults.ts for the empty-query default vs. ranked-and-
  // grouped derivation. `visible` is the same flat top-to-bottom row order Task 7's selection reducer
  // will need; re-derive it from (catalog, mode, query) rather than threading it through props, since
  // deriveResults is a pure function those tasks can call directly.
  const { sections, visible: visibleResults } = deriveResults(catalog, mode, query);
  // "Selected" is always the first visible row until Task 7 lands real ↑/↓ selection state.
  const selected = visibleResults[0];
  const previewModel = selected ? previewFor(selected.entry, {}) : null;
  const hasPreview = previewModel !== null;

  function showToast(message: string): void {
    setToastMessage(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastMessage(null), TOAST_DURATION_MS);
  }

  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);

  // Wraps the injected `actionDeps.toast` so THIS panel instance renders the `.lx-toast` bubble for
  // any action fired through it, while still forwarding the call to the caller's own binding (Task 8
  // may route it to further side effects; a stub in tests just observes the call).
  const effectiveDeps: LauncherActionDeps = { ...actionDeps, toast: (message: string) => {
    showToast(message);
    actionDeps.toast(message);
  } };

  const selectedActions = selected ? actionsFor(selected.entry, effectiveDeps) : [];

  function runDefault(entry: CatalogEntry): void {
    void actionsFor(entry, effectiveDeps)[0]?.run();
  }

  function openMenu(): void {
    if (!selected) return;
    setMenuIndex(0);
    setMenuOpen(true);
  }

  function closeMenu(): void {
    setMenuOpen(false);
  }

  function runMenuAction(index: number): void {
    const action = selectedActions[index];
    closeMenu();
    void action?.run();
  }

  // Load the live catalog once per open so the count/preview reflect real data; guarded against the
  // panel closing/unmounting before the join resolves (buildCatalog awaits the model index + git log).
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

  // Start the next open with a clean query, matching the prototype's open() reset. The action menu
  // and any in-flight toast reset the same way — a fresh open should never resurface last session's
  // popover or confirmation bubble.
  useEffect(() => {
    if (!visible) {
      setInput('');
      setMenuOpen(false);
      setToastMessage(null);
    }
  }, [visible]);

  function clearMode(): void {
    setInput((value) => value.slice(1));
    inputRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      // Esc closes the topmost overlay first: the action menu when it's open, else the launcher
      // itself. (Full ↑/↓/↵ keyboard driving of the menu is Task 7 — this is just nested-overlay Esc.)
      if (menuOpen) {
        closeMenu();
        return;
      }
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
                  <ResultRow
                    key={row.entry.id}
                    result={row}
                    selected={row.entry.id === selected?.entry.id}
                    onRun={() => runDefault(row.entry)}
                    onOpenMenu={openMenu}
                  />
                ))}
              </div>
            ))}
          </div>
          <div class="lx-preview">{previewModel && <PreviewPane model={previewModel} />}</div>
        </div>
        <div class="lx-footer">
          <span class="lx-hint">
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span class="lx-hint">
            <kbd>↵</kbd> open
          </span>
          <button type="button" class="lx-hint lx-hint-btn" disabled={!selected} onClick={openMenu}>
            <kbd>⌘</kbd>
            <kbd>K</kbd> actions
          </button>
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
        {menuOpen && selected && (
          <ActionMenu
            actions={selectedActions}
            title={selected.entry.title}
            selectedIndex={menuIndex}
            onSelect={setMenuIndex}
            onRun={runMenuAction}
            onClose={closeMenu}
          />
        )}
      </div>
      <div class={toastMessage ? 'lx-toast show' : 'lx-toast'} aria-live="polite">
        <svg class="lx-ic" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
        </svg>
        <span>{toastMessage}</span>
      </div>
    </div>
  );
}
