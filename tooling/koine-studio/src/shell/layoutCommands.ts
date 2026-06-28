// The view-layout commands the shell spreads into its command-palette provider — the panel/side-rail
// repositioning toggles and the Properties-panel collapse. Lifted into its own pure module (out of
// ide.tsx's giant init() closure) so the command list is unit-testable: it takes a LayoutActions bag of
// injected effects and returns plain Command records whose run() just calls the matching action. The
// actions themselves (mutate layoutStore → re-apply the #split data-* attributes → re-clamp the rail
// resizers) live in ide.tsx where the DOM + resizers are; this module knows nothing about them. Keep it
// app-agnostic of those internals — it is the seam, not the wiring.
//
// (The editor A/B split commands — split / toggleOrientation / closeGroup — were retired: the center
// split-pane system (#720) is the one splitting primitive now.)
import type { Command } from '@/shared/palette';

/** The layout effects ide.tsx injects; each maps 1:1 to one palette command's run(). */
export interface LayoutActions {
  /** Move the bottom panel (Problems / Events / …) between the bottom edge and the right edge. */
  togglePanelSide(): void;
  /** Move the side rail (the element inspector) between the right edge and the left edge. */
  toggleSideRail(): void;
  /** Open/close the right Properties panel — the tool-window stripe's collapse toggle (#500). */
  toggleProperties(): void;
}

/**
 * Build the layout palette commands. Ids are pinned (`layout.panelSide`, `layout.sideRail`,
 * `layout.toggleProperties`) so anything keyed on them stays stable; each command's run() invokes
 * exactly the matching action.
 */
export function layoutCommands(actions: LayoutActions): Command[] {
  return [
    { id: 'layout.panelSide', title: 'Move panel (bottom / right)', group: 'View', run: () => actions.togglePanelSide() },
    { id: 'layout.sideRail', title: 'Move side rail (left / right)', group: 'View', run: () => actions.toggleSideRail() },
    { id: 'layout.toggleProperties', title: 'Toggle Properties panel', group: 'View', run: () => actions.toggleProperties() },
  ];
}
