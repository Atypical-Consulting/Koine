// One `.lx-item` row in the Spotlight launcher's results list (issue #1143, task 4): a DDD kind chip
// or line-icon glyph, the fuzzy-highlighted title + sub line, and a best-effort tail (a command's
// keycap hint, a commit's short hash). Extended (task 6) with the selected row's `.lx-actbtn` tail
// affordance, which opens the `.lx-actmenu` popover for this result (`LauncherPanel.tsx` owns that
// state) — full keyboard-driven selection is still Task 7.
import { highlight, type RankedResult } from '@/launcher/fuzzy';
import { KIND, type CatalogEntry } from '@/launcher/catalog';

export interface ResultRowProps {
  result: RankedResult;
  selected: boolean;
  /** Stubbed for a later task's mouse/keyboard selection wiring (Task 7) — no-op until then. */
  onHover?: () => void;
  /** Runs this result's default quick action (issue #1143, task 6) — wired to `actionsFor(entry, deps)[0].run()`. */
  onRun?: () => void;
  /** Opens the `.lx-actmenu` popover for this result (issue #1143, task 6); only rendered when `selected`. */
  onOpenMenu?: () => void;
}

/** The line-icon glyphs a non-chip category renders, ported verbatim (path data unchanged) from the
 * prototype's `I` map in design/design_handoff_git_spotlight_logos/koine-launcher.js. Exported so the
 * preview pane (Task 5) reuses the same icon paths instead of duplicating them. */
export type GlyphKind = 'action' | 'file' | 'gloss' | 'rule' | 'state' | 'commit';

export function GlyphPaths({ kind }: { kind: GlyphKind }) {
  switch (kind) {
    case 'action':
      return <path d="M4.5 4 8 7.5 4.5 11M8.5 11.5h4" />;
    case 'file':
      return (
        <>
          <path d="M4 2.4h4.5l3 3v8H4z" />
          <path d="M8.5 2.4v3h3" />
        </>
      );
    case 'gloss':
      return (
        <>
          <path d="M4 3.2h6a1.4 1.4 0 0 1 1.4 1.4v8.2M4 3.2A1.2 1.2 0 0 0 2.8 4.4v8.4A1.2 1.2 0 0 0 4 14h7.4" />
          <path d="M5.4 6h4M5.4 8.2h4" />
        </>
      );
    case 'rule':
      return <path d="M8 2.2 3.2 4v3.4c0 3 2 5 4.8 6.4 2.8-1.4 4.8-3.4 4.8-6.4V4z" />;
    case 'state':
      return (
        <>
          <circle cx="4" cy="8" r="1.7" />
          <circle cx="12" cy="8" r="1.7" />
          <path d="M5.7 8h4.6M8.6 6.3 10.3 8 8.6 9.7" />
        </>
      );
    case 'commit':
      return (
        <>
          <circle cx="8" cy="8" r="2.4" />
          <path d="M8 2v3.6M8 10.4V14" />
        </>
      );
  }
}

/** The prototype's `catGlyph` category → glyph mapping, minus the symbol/event branch (those render a
 * `.lx-kind` chip instead, handled by the caller). `rule` picks `state` vs `rule` off `rkind`. */
function glyphKindFor(entry: CatalogEntry): GlyphKind {
  if (entry.cat === 'rule') return entry.rkind === 'state' ? 'state' : 'rule';
  if (entry.cat === 'glossary') return 'gloss';
  if (entry.cat === 'commit') return 'commit';
  if (entry.cat === 'action') return 'action';
  return 'file';
}

/** The tail: a command's keyboard-chord hint, or a commit's short hash — best-effort from whatever
 * identity field the entry actually carries (files don't yet carry a diff-stat field to show here). */
function Tail({ entry }: { entry: CatalogEntry }) {
  if (entry.cat === 'action' && entry.hint) return <span class="lx-kbd">{entry.hint}</span>;
  if (entry.cat === 'commit' && entry.hash) return <span class="lx-meta">{entry.hash.slice(0, 7)}</span>;
  return null;
}

/** The sub line: a file shows just its directory; a commit shows its own pre-built "sha · author"
 * sub; everything else shows its sub plus a `·`-separated context when it has one — ported verbatim
 * from the prototype's `itemRow()` sub-building branch. */
function Sub({ entry }: { entry: CatalogEntry }) {
  if (entry.cat === 'file') return <span class="lx-ctx">{entry.ctx ?? ''}</span>;
  if (entry.cat === 'commit') return <>{entry.sub}</>;
  return (
    <>
      {entry.sub ?? ''}
      {entry.ctx ? (
        <>
          {' · '}
          <span class="lx-ctx">{entry.ctx}</span>
        </>
      ) : null}
    </>
  );
}

/**
 * One grouped result row. `result.entry` is the `CatalogEntry` to render; `result.ranges` are the
 * title's matched character indices from `rank()` (empty when the entry matched on its secondary
 * keyword/context pass, in which case the title renders with no highlight).
 */
export function ResultRow(props: ResultRowProps) {
  const { result, selected, onHover, onRun, onOpenMenu } = props;
  const { entry } = result;
  const chip = entry.cat === 'symbol' || entry.cat === 'event' ? KIND[entry.kind as keyof typeof KIND] : undefined;
  const segments = highlight(entry.title, result.ranges);
  // A command entry gated by `Command.enabled()` (issue #1407): `when()`/`isEnabled` already governs
  // whether the entry appears in the catalog at all (buildCatalog.ts's commandEntries), so the ONLY
  // remaining reason this can read false here is the second, independent activatability axis — e.g.
  // open-folder/new-model while a workspace-open op is busy. Re-evaluated on every render (not cached
  // at catalog-build time) so the row flips back to normal the instant the busy op clears, without
  // requiring the launcher to be reopened. Mirrors koine-ui's `koi-palette-item--disabled` affordance.
  const disabled = entry.cat === 'action' && entry.enabled?.() === false;
  const rowClass = ['lx-item', selected ? 'sel' : null, disabled ? 'lx-item--disabled' : null]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      class={rowClass}
      // Stable per-entry id so the input's `aria-activedescendant` can point AT-readers at the active
      // option as ↑/↓ moves the selection (issue #1145 review); pairs with `role="option"` below.
      id={`lx-opt-${entry.id}`}
      role="option"
      aria-selected={selected}
      aria-disabled={disabled || undefined}
      data-id={entry.id}
      onMouseMove={onHover}
      onClick={onRun}
    >
      {chip ? (
        <span class="lx-kind" style={{ '--kc': `var(${chip.token})` }} title={chip.word}>
          {chip.code}
        </span>
      ) : (
        <span class="lx-glyph">
          <svg class="lx-ic" viewBox="0 0 16 16" aria-hidden="true">
            <GlyphPaths kind={glyphKindFor(entry)} />
          </svg>
        </span>
      )}
      <div class="lx-main">
        <div class="lx-title">
          {segments.map((seg, i) => (seg.match ? <mark key={i}>{seg.text}</mark> : seg.text))}
        </div>
        <div class="lx-sub">
          <Sub entry={entry} />
        </div>
      </div>
      <div class="lx-tail">
        <Tail entry={entry} />
        {/* Suppressed for a disabled action row (#1407): its only quick action is Run, which is exactly
            what's currently gated — a popover offering an inert "Run" would be a dead end. */}
        {selected && onOpenMenu && !disabled && (
          <button
            type="button"
            class="lx-actbtn avail"
            aria-label={`Quick actions for ${entry.title}`}
            onClick={(e) => {
              e.stopPropagation();
              onOpenMenu();
            }}
          >
            Actions
            <span class="lx-actbtn-kbd">⌘K</span>
          </button>
        )}
      </div>
    </div>
  );
}
