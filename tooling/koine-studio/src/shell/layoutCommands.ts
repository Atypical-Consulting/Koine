// The five view-layout commands the shell spreads into its command-palette provider — editor split,
// split orientation, close-group, and the panel/side-rail repositioning toggles. Lifted into its own
// pure module (out of ide.tsx's giant init() closure) so the command list is unit-testable: it takes a
// LayoutActions bag of injected effects and returns plain Command records whose run() just calls the
// matching action. The actions themselves (mutate layoutStore → re-apply the #split data-* attributes →
// open/close group B → re-clamp the divider) live in ide.tsx where the DOM + editorSession + resizers
// are; this module knows nothing about them. Keep it app-agnostic of those internals — it is the seam,
// not the wiring.
import type { Command } from '@/shared/palette';

/** The layout effects ide.tsx injects; each maps 1:1 to one palette command's run(). */
export interface LayoutActions {
  /** Open the second editor group (group B) over the shared buffers, or focus it if already open. */
  split(): void;
  /** Flip the split between side-by-side (horizontal) and stacked (vertical). */
  toggleOrientation(): void;
  /** Close the second editor group, returning to a single full-width editor. */
  closeGroup(): void;
  /** Move the bottom panel (Problems / Events / …) between the bottom edge and the right edge. */
  togglePanelSide(): void;
  /** Move the side rail (the element inspector) between the right edge and the left edge. */
  toggleSideRail(): void;
  /** Open/close the right Properties panel — the tool-window stripe's collapse toggle (#500). */
  toggleProperties(): void;
}

/**
 * Build the six layout palette commands. Ids are pinned (`editor.split`, `editor.toggleOrientation`,
 * `editor.closeGroup`, `layout.panelSide`, `layout.sideRail`, `layout.toggleProperties`) so anything
 * keyed on them stays stable; each command's run() invokes exactly the matching action.
 */
export function layoutCommands(actions: LayoutActions): Command[] {
  return [
    { id: 'editor.split', title: 'Split editor', group: 'View', run: () => actions.split() },
    {
      id: 'editor.toggleOrientation',
      title: 'Toggle split orientation',
      group: 'View',
      run: () => actions.toggleOrientation(),
    },
    { id: 'editor.closeGroup', title: 'Close editor group', group: 'View', run: () => actions.closeGroup() },
    { id: 'layout.panelSide', title: 'Move panel (bottom / right)', group: 'View', run: () => actions.togglePanelSide() },
    { id: 'layout.sideRail', title: 'Move side rail (left / right)', group: 'View', run: () => actions.toggleSideRail() },
    { id: 'layout.toggleProperties', title: 'Toggle Properties panel', group: 'View', run: () => actions.toggleProperties() },
  ];
}
