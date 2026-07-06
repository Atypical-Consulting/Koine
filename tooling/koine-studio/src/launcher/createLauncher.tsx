// Imperative mount for the Spotlight launcher (issue #1143, task 3): a host div appended to
// document.body, mounted once and toggled via a `visible` prop — the same pattern as
// createSearchPanel/SearchPanel (src/shell/searchController.tsx). The shell wires this handle to ⌘K
// in Task 8 (retargeting commandWiring.ts's PALETTE_COMMAND_ID off the old command-palette overlay).
//
// This is a .tsx (not .ts) file: buildCatalog.test.ts's architecture check requires every plain .ts
// file directly under src/launcher/ to stay DOM/framework-free (value-import only from other launcher
// modules) — catalog.ts/fuzzy.ts/buildCatalog.ts are the pure join+ranker. This module's whole job is
// the opposite (mounting Preact into the document), so it lives outside that rule as a .tsx file, same
// as LauncherPanel.tsx.
import { render } from 'preact';
import { el } from '@atypical/koine-ui';
import type { LauncherSources } from '@/launcher/buildCatalog';
import { LauncherPanel } from '@/launcher/LauncherPanel';

/** Imperative handle the shell drives from the ⌘K shortcut. */
export interface LauncherHandle {
  open(): void;
  close(): void;
  toggle(): void;
  readonly isOpen: boolean;
}

/**
 * Mount the launcher into the document (once) and return the imperative handle. The panel stays
 * mounted across open/close (a `visible` prop flip) — cheaper than remounting, and matches
 * createSearchPanel's approach — so `sources` is captured once at construction time.
 */
export function createLauncher(sources: LauncherSources): LauncherHandle {
  const host = el('div', { class: 'lx-host' });
  document.body.appendChild(host);
  let isOpen = false;
  let opener: HTMLElement | null = null; // element focused before the launcher opened, restored on close

  function paint(): void {
    render(<LauncherPanel sources={sources} visible={isOpen} onClose={close} />, host);
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

  paint(); // mount once, hidden — toggling afterward is just a visibility prop flip
  return {
    open,
    close,
    toggle() {
      if (isOpen) close();
      else open();
    },
    get isOpen() {
      return isOpen;
    },
  };
}
