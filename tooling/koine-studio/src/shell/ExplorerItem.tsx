import type { JSX } from 'preact';
import type { FsEntry } from '@/host';

// One workspace-explorer row (#989 task 2): a keyed `<li role="treeitem">` — the Preact counterpart of
// explorer.ts's `buildItem()`. Ported for STATIC-render parity only: the icon classifier, dirty dot,
// error/warning badge, active row (aria-current/aria-selected) and filter-match highlight all mirror
// buildItem() exactly. Keyboard nav (F2 rename, Delete, arrow/roving-tabindex), drag-and-drop, inline
// create/rename and the "…" context-menu trigger are NOT here yet — those land in later #989 tasks; a
// directory click (this component's only affordance today) simply toggles expansion via `onToggle`, and
// a file click opens it via `onOpen`. `tabIndex` stays a fixed -1 (no roving-tabindex focus management
// until the keyboard-nav task).
//
// This component owns nothing but its own row-shaped props — no `collapsed`/`filterText` state, no
// ExplorerCallbacks — so `ExplorerPanel` (which flattens the visible rows via `explorerModel.ts` and
// derives `expanded`/`active`/`dirty`/diagnostics from `ExplorerCallbacks` per row) is the sole owner of
// that lifecycle. Being its own component (not just a rendering function) makes each row's Preact
// identity explicit, which is what the "keyed identity" test in ExplorerPanel.test.tsx pins: an
// untouched row keeps its DOM node across a re-render that only changes a SIBLING row's props.
export interface ExplorerItemProps {
  token: string;
  kind: FsEntry['kind'];
  name: string;
  /** 1-based ARIA tree level — matches explorer.ts's `aria-level`. */
  level: number;
  /** Directories only — whether this row's children are shown. */
  expanded: boolean;
  /** Files only — whether this is the open/active buffer. */
  active: boolean;
  /** Files only — an unsaved-changes dot. */
  dirty: boolean;
  errors: number;
  warnings: number;
  /** The active (lowercased, trimmed) filter query, for the `<mark>` highlight — '' when not filtering. */
  filterText: string;
  /** Directories only — toggle expand/collapse. */
  onToggle: () => void;
  /** Files only — open the buffer. */
  onOpen: () => void;
}

export function ExplorerItem(props: ExplorerItemProps): JSX.Element {
  const { token, kind, name, level, expanded, active, dirty, errors, warnings, filterText, onToggle, onOpen } = props;
  const isDir = kind === 'dir';
  const isActiveFile = !isDir && active;
  const hasBadge = !isDir && (errors > 0 || warnings > 0);

  return (
    <li
      role="treeitem"
      data-kind={kind}
      data-token={token}
      aria-level={level}
      aria-expanded={isDir ? expanded : undefined}
      aria-selected={isActiveFile ? 'true' : undefined}
      tabIndex={-1}
    >
      <div
        class="explorer-row"
        aria-current={isActiveFile ? 'true' : undefined}
        style={{ '--depth': String(level - 1) }}
        onClick={isDir ? onToggle : onOpen}
      >
        <span
          class="explorer-twisty"
          aria-hidden="true"
          onClick={
            isDir
              ? (e: MouseEvent) => {
                  e.stopPropagation();
                  onToggle();
                }
              : undefined
          }
        >
          {isDir ? (expanded ? '▾' : '▸') : ''}
        </span>
        <ItemIcon kind={kind} name={name} expanded={expanded} />
        <span class="explorer-name">{highlightMatch(name, filterText)}</span>
        {!isDir && dirty && (
          <span class="tree-dirty" title="Unsaved changes">
            •
          </span>
        )}
        {hasBadge && (
          <span
            class={errors > 0 ? 'tree-badge tree-badge-err' : 'tree-badge tree-badge-warn'}
            title={`${errors} error(s), ${warnings} warning(s)`}
          >
            {errors > 0 ? errors : warnings}
          </span>
        )}
      </div>
    </li>
  );
}

// Wrap the filter match in <mark>, mirroring explorer.ts's fillName() — the FIRST case-insensitive
// occurrence only (a name matches the filter at most meaningfully once for this highlight).
function highlightMatch(name: string, query: string): JSX.Element | string {
  if (!query) return name;
  const at = name.toLowerCase().indexOf(query);
  if (at < 0) return name;
  return (
    <>
      {name.slice(0, at)}
      <mark class="explorer-hl">{name.slice(at, at + query.length)}</mark>
      {name.slice(at + query.length)}
    </>
  );
}

// The type icon: brand diamond for `.koi` contexts, open/closed folder for dirs, neutral doc otherwise —
// ported verbatim (same classification + same SVG paths) from explorer.ts's classifyIcon()/ICON. Kept as
// literal JSX <svg> (not dangerouslySetInnerHTML'd markup strings) per the project's innerHTML ban
// (eslint.config.mjs's `no-restricted-syntax` gate — MdHtml.tsx is the only permitted innerHTML sink).
function ItemIcon({ kind, name, expanded }: { kind: FsEntry['kind']; name: string; expanded: boolean }): JSX.Element {
  if (kind === 'dir') {
    return (
      <span class="explorer-icon explorer-icon--dir" aria-hidden="true">
        {expanded ? <FolderOpenGlyph /> : <FolderGlyph />}
      </span>
    );
  }
  const isKoi = name.toLowerCase().endsWith('.koi');
  return (
    <span class={`explorer-icon ${isKoi ? 'explorer-icon--koi' : 'explorer-icon--file'}`} aria-hidden="true">
      {isKoi ? <KoiGlyph /> : <FileGlyph />}
    </span>
  );
}

function KoiGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.4 14.6 8 8 14.6 1.4 8z" />
    </svg>
  );
}

function FolderGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M1.7 4.4c0-.6.5-1.1 1.1-1.1h3c.4 0 .7.2.9.5l.6.9h6c.6 0 1.1.5 1.1 1.1v6c0 .6-.5 1.1-1.1 1.1H2.8c-.6 0-1.1-.5-1.1-1.1z" />
    </svg>
  );
}

function FolderOpenGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M1.7 4.4c0-.6.5-1.1 1.1-1.1h3c.4 0 .7.2.9.5l.6.9h6c.6 0 1.1.5 1.1 1.1v1.1H4.5c-.5 0-1 .4-1.1.9L1.7 13z" />
      <path opacity=".5" d="M4.5 7.1h10.3c.5 0 .9.5.7 1l-1.2 4.3c-.1.5-.6.8-1.1.8H2.1c-.5 0-.9-.5-.7-1l1.2-4.3c.1-.5.6-.8 1.1-.8z" />
    </svg>
  );
}

function FileGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" d="M4 1.9h4.8L12 5.1v9H4z" />
    </svg>
  );
}
