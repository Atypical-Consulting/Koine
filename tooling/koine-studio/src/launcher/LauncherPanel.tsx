// The Spotlight launcher's overlay shell: scrim + card + input row + prefix-mode pill + footer legend
// (issue #1143, task 3), extended (task 4) to fill `.lx-results` with grouped, ranked result rows, and
// (task 5) to resolve + render the live PREVIEW pane for the selected result. Per-result quick actions
// (task 6) add the `.lx-actmenu` popover + `.lx-toast` confirmation, wired through the injected
// `LauncherActionDeps` seam (Task 8 binds the concrete effects). Task 7 (this task) formalizes
// `selectedIndex` as real state (reset to 0 on every query/mode change) and wires the full keyboard
// model (`keys.ts`'s pure `handleKey` reducer) plus mouse-move selection on top of it — see `onKeyDown`
// below. No extra join is needed for the preview: `buildCatalog` (task 5) already attaches each
// symbol/event/rule entry's joined `ModelElement`, so `previewFor(selected.entry, {})` reads straight
// off the catalog.
import { useEffect, useRef, useState } from 'preact/hooks';
import { registerOverlay } from '@atypical/koine-ui';
import { actionsFor, type LauncherActionDeps } from '@/launcher/actions';
import { ActionMenu } from '@/launcher/ActionMenu';
import { buildCatalog, type LauncherSources } from '@/launcher/buildCatalog';
import { MODES, PREFIX_CHARS, parseMode, type CatalogEntry } from '@/launcher/catalog';
import { deriveResults } from '@/launcher/deriveResults';
import { handleKey, type LauncherKeyState } from '@/launcher/keys';
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
  /** Hands the shell a callback that raises THIS panel's `.lx-toast` (issue #1145 review): commandWiring
   * binds it so a degraded action (rename/revert-commit) can honestly say "not available yet" instead of a
   * misleading silent jump. Optional so the unit tests mount the panel without it. */
  onRegisterToast?(show: (message: string) => void): void;
}

/** The panel body. Exported for unit tests; the shell mounts it via {@link createLauncher}. */
export function LauncherPanel(props: LauncherPanelProps) {
  const { sources, visible, onClose, actionDeps, onRegisterToast } = props;
  const [input, setInput] = useState('');
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Live-state mirrors read by the shared Esc-stack dismiss (registered once per open, so it can't
  // close over `query`/`onClose` directly — it reads whatever these hold at Escape time). Assigned on
  // every render below, so the dismiss always sees the current query and the current onClose.
  const queryRef = useRef('');
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const { mode, query } = parseMode(input);
  queryRef.current = query;
  // Grouped/ranked results (Task 4) — see deriveResults.ts for the empty-query default vs. ranked-and-
  // grouped derivation. `visible` is the same flat top-to-bottom row order the keyboard reducer's ↑/↓
  // indexes into; re-derive it from (catalog, mode, query) rather than threading it through props, since
  // deriveResults is a pure function.
  const { sections, visible: visibleResults } = deriveResults(catalog, mode, query);
  // The keyboard-driven "selected" row (Task 7): `selectedIndex` is real state, reset to 0 below
  // whenever the query/mode changes so a fresh search always starts at the top result.
  const selected = visibleResults[selectedIndex];
  const previewModel = selected ? previewFor(selected.entry, {}) : null;
  const hasPreview = previewModel !== null;

  // Reset the selection to the top result whenever the effective (mode, query) changes — matches the
  // prototype's `input.addEventListener("input", () => { sel = 0; render(); ...})`.
  useEffect(() => setSelectedIndex(0), [mode.key, query]);

  // Best-effort: keep the keyboard-selected row in view as ↑/↓ moves past the visible viewport.
  useEffect(() => {
    resultsRef.current?.querySelector('.lx-item.sel')?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  function showToast(message: string): void {
    setToastMessage(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastMessage(null), TOAST_DURATION_MS);
  }

  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);

  // Expose showToast to the shell once (issue #1145 review). `showToast` only touches stable identities
  // (setToastMessage + the timer ref), so the mount-time closure stays correct for the panel's life.
  useEffect(() => {
    onRegisterToast?.(showToast);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      setSelectedIndex(0);
      setMenuOpen(false);
      setToastMessage(null);
    }
  }, [visible]);

  // Join koine-ui's shared Esc-stack while open (issue #1164), the same register-on-open /
  // unregister-on-close lifecycle inspectorSheet.tsx and welcome.ts use. `registerOverlay` centralizes
  // Escape ONLY: its single document-level handler routes each Esc to the topmost overlay, so the
  // launcher dismisses in the right order when it coexists with another overlay. The launcher-level
  // dismiss mirrors the old reducer's Escape branch — clear a non-empty query first, else close —
  // reading the live query/onClose off refs since it's registered once per open. The non-Esc chord
  // traps (⌘K stopPropagation, the `.lx-scrim` clause, `|| launcher.isOpen`) are NOT subsumed and stay.
  useEffect(() => {
    if (!visible) return;
    const unregister = registerOverlay(() => {
      if (queryRef.current !== '') setInput('');
      else onCloseRef.current();
    });
    return unregister;
  }, [visible]);

  // Nest the action menu as a second Esc-stack layer ABOVE the launcher (issue #1164): while it's open
  // the menu is the topmost overlay, so one shared Esc closes just the menu (peeling back to the
  // launcher layer), and the next Esc dismisses the launcher — the same menu → clear-query → close
  // order the reducer used to own, now expressed as stack depth. Popped on close/hide/unmount so no
  // stale close-fn lingers (mirrors inspectorSheet's destroy()). setMenuOpen is a stable setter, so the
  // dismiss needs no dep beyond `menuOpen`.
  useEffect(() => {
    if (!menuOpen) return;
    const unregister = registerOverlay(() => setMenuOpen(false));
    return unregister;
  }, [menuOpen]);

  function clearMode(): void {
    // Drop the mode-prefix char, and a single following space if there was one ("@ Order" → "Order"),
    // mirroring parseMode's own leading-space trim so the cleared query is the bare term (#1145 review).
    setInput((value) => {
      const rest = value.slice(1);
      return rest.startsWith(' ') ? rest.slice(1) : rest;
    });
    inputRef.current?.focus();
  }

  // The full keyboard model (issue #1143, task 7): `keys.ts`'s pure `handleKey` reducer decides the
  // intent from the current state; this handler just applies it (and calls `preventDefault()` when the
  // reducer says to) — no key-specific branching lives here anymore. Attached (below) to the
  // `.lx-scrim` overlay so arrows/↵/Tab/Esc/⌘K work while the query input keeps DOM focus (focus stays
  // trapped in the input; the container-level listener catches the bubbled keydown).
  function onKeyDown(e: KeyboardEvent): void {
    if (!visible) return;
    // While open the launcher OWNS its chords: stop them bubbling to the shell's GLOBAL window keydown
    // listeners (commandWiring's ⌘K palette-toggle, ide.tsx's ⌘S save + ⌘Z/⌘Y undo/redo). Those gate on
    // overlayOpen(), which doesn't see `.lx-scrim`, so without this they'd fire on the editor beneath the
    // open launcher (issue #1145). Escape is the ONE exception (issue #1164): it must bubble to koine-ui's
    // shared document-level Esc handler, which now owns overlay dismissal (the launcher + action-menu
    // layers register on the shared stack above). commandWiring deliberately never handles Escape, so
    // letting it through can't double-fire a global chord. Typing still works either way — the input
    // already received the keystroke; stopPropagation only stops the bubble.
    if (e.key !== 'Escape') e.stopPropagation();
    const keyState: LauncherKeyState = {
      query,
      selectedIndex,
      resultCount: visibleResults.length,
      menuOpen,
      menuIndex,
      menuCount: selectedActions.length,
      selectedTitle: selected ? selected.entry.title : null,
      modePrefix: mode.prefix,
    };
    const result = handleKey(e, keyState);
    if (result.preventDefault) e.preventDefault();

    switch (result.kind) {
      case 'move':
        setSelectedIndex(result.selectedIndex);
        break;
      case 'runDefault':
        if (selected) runDefault(selected.entry);
        break;
      case 'fill':
        setInput(result.query);
        inputRef.current?.focus();
        break;
      case 'toggleMenu':
        if (menuOpen) closeMenu();
        else openMenu();
        break;
      case 'menuMove':
        setMenuIndex(result.menuIndex);
        break;
      case 'runMenu':
        runMenuAction(menuIndex);
        break;
      case 'none':
        break;
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
            role="combobox"
            aria-expanded={visibleResults.length > 0}
            aria-controls="lx-results"
            aria-activedescendant={selected ? `lx-opt-${selected.entry.id}` : undefined}
            value={input}
            onInput={(e) => setInput((e.target as HTMLInputElement).value)}
          />
          <span class="lx-count">{catalog.length}</span>
          <kbd class="lx-esc">esc</kbd>
        </div>
        <div class="lx-body">
          <div
            ref={resultsRef}
            id="lx-results"
            class="lx-results"
            role="listbox"
            aria-label="Results"
            data-mode={mode.key}
            data-query={query}
          >
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
                {section.rows.map((row) => {
                  const index = visibleResults.indexOf(row);
                  return (
                    <ResultRow
                      key={row.entry.id}
                      result={row}
                      selected={index === selectedIndex}
                      onHover={() => setSelectedIndex(index)}
                      onRun={() => runDefault(row.entry)}
                      onOpenMenu={openMenu}
                    />
                  );
                })}
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
