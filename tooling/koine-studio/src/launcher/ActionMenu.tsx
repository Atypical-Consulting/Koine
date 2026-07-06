// The Spotlight launcher's `.lx-actmenu` popover (issue #1143, task 6): lists a result's quick
// actions (from `actionsFor`, actions.ts) with their keycaps, bottom-right anchored inside `.lx`. Pure
// presentation over the `LauncherAction[]` view-model data — no DOM/LSP knowledge of its own, mirroring
// `ResultRow.tsx`'s glyph-path pattern for the per-action icons. `LauncherPanel.tsx` owns the actual
// `menuOpen`/`menuIndex` state and mounts/unmounts this component; full ↑/↓ + ↵ keyboard driving of
// `selectedIndex` is Task 7 — this task wires mouse hover/click plus a self-contained Esc-to-close.
import type { ActionIcon, LauncherAction } from '@/launcher/actions';
import { GlyphPaths } from '@/launcher/ResultRow';

/** The line-icon glyphs a quick action can render, ported verbatim (path data unchanged) from the
 * prototype's `I` map in design/design_handoff_git_spotlight_logos/koine-launcher.js. The four glyphs
 * shared with the result list (`file`/`gloss`/`commit`/`state`) reuse `ResultRow`'s exported `GlyphPaths`
 * instead of re-hardcoding identical path data (issue #1145 review); the rest are unique to this menu. */
function ActionIconPaths({ kind }: { kind: ActionIcon }) {
  switch (kind) {
    case 'goto':
      return <path d="M3 8h8M8 5l3 3-3 3" />;
    case 'ref':
      return (
        <>
          <circle cx="8" cy="8" r="2" />
          <path d="M8 2v2M8 12v2M2 8h2M12 8h2" />
        </>
      );
    case 'peek':
      return (
        <>
          <rect x="2.5" y="3.5" width="11" height="9" rx="1.4" />
          <path d="M2.5 6.5h11" />
        </>
      );
    case 'rename':
      return <path d="M9.5 3.5 12.5 6.5 6 13H3v-3z" />;
    case 'copy':
      return (
        <>
          <rect x="5" y="5" width="8" height="8" rx="1.4" />
          <path d="M3 10.5V4a1 1 0 0 1 1-1h6.5" />
        </>
      );
    case 'run':
      return <path d="M5 3.5 12 8l-7 4.5z" />;
    case 'file':
      return <GlyphPaths kind="file" />;
    case 'diff':
      return <path d="M4 3.5v6M4 12.5v.01M4 9.5a1.5 1.5 0 0 0 1.5 1.5h3M12 12.5v-6M12 3.5v.01" />;
    case 'gloss':
      return <GlyphPaths kind="gloss" />;
    case 'search':
      return (
        <>
          <circle cx="7" cy="7" r="4.2" />
          <path d="M10.2 10.2 14 14" />
        </>
      );
    case 'commit':
      return <GlyphPaths kind="commit" />;
    case 'state':
      return <GlyphPaths kind="state" />;
    case 'open':
      return (
        <>
          <path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4Z" />
          <circle cx="8" cy="8" r="1.8" />
        </>
      );
  }
}

export interface ActionMenuProps {
  /** The selected result's quick actions, in `actionsFor` order (index 0 is the default, ↵). */
  actions: LauncherAction[];
  /** The result's title, shown as the popover's header — ported from the prototype's `.lx-actmenu-head`. */
  title: string;
  selectedIndex: number;
  onSelect(index: number): void;
  onRun(index: number): void;
  onClose(): void;
}

/**
 * The `.lx-actmenu` popover: a header naming the result, then one `.lx-actitem` row per action with
 * its icon/label/keycap. Mouse move selects a row (mirrors the result list's hover-to-select), click
 * runs it. `role="menu"`/`menuitem` + Esc-to-close (with `stopPropagation` so it doesn't also bubble
 * into the launcher's own Escape-closes-overlay handler) satisfy the popover a11y pattern; full ↑/↓
 * keyboard driving of `selectedIndex` from outside is Task 7's (`LauncherPanel` owns the state this
 * component only renders).
 */
export function ActionMenu(props: ActionMenuProps) {
  const { actions, title, selectedIndex, onSelect, onRun, onClose } = props;

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }

  return (
    <div
      class="lx-actmenu"
      role="menu"
      aria-label={`Actions for ${title}`}
      tabIndex={-1}
      // The active row is tracked in state (focus stays in the launcher input), so it's announced via
      // aria-activedescendant on the menu — NOT aria-selected on the menuitems, which is the wrong pairing
      // for role="menu"/"menuitem" (aria-selected belongs to option/tab/etc.) (issue #1145 review).
      aria-activedescendant={`lx-act-${selectedIndex}`}
      onKeyDown={onKeyDown}
    >
      <div class="lx-actmenu-head">{title}</div>
      {actions.map((action, i) => (
        <div
          key={action.label}
          id={`lx-act-${i}`}
          class={i === selectedIndex ? 'lx-actitem sel' : 'lx-actitem'}
          role="menuitem"
          tabIndex={0}
          onMouseMove={() => onSelect(i)}
          onClick={() => onRun(i)}
        >
          <svg class="lx-ic" viewBox="0 0 16 16" aria-hidden="true">
            {action.icon && <ActionIconPaths kind={action.icon} />}
          </svg>
          <span class="ai-label">{action.label}</span>
          <span class="ai-kbd">{action.keycap}</span>
        </div>
      ))}
    </div>
  );
}
