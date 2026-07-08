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
import type { LauncherActionDeps } from '@/launcher/actions';
import type { LauncherSources } from '@/launcher/buildCatalog';
import type { CatalogEntry } from '@/launcher/catalog';
import { LauncherPanel } from '@/launcher/LauncherPanel';

/** Imperative handle the shell drives from the ⌘K shortcut. */
export interface LauncherHandle {
  open(): void;
  close(): void;
  toggle(): void;
  readonly isOpen: boolean;
  /** Raise the launcher's own `.lx-toast` from shell code (issue #1145 review): the binding for a
   * degraded quick-action that must honestly say "not available yet" instead of a misleading no-op. */
  toast(message: string): void;
  /** Pin an entry's read-only preview into the panel's preview pane (issue #1165): the `peek` quick
   * action's non-navigating quick-look, WITHOUT touching the editor or moving the keyboard selection. */
  peek(entry: CatalogEntry): void;
}

/**
 * Mount the launcher into the document (once) and return the imperative handle. The panel stays
 * mounted across open/close (a `visible` prop flip) — cheaper than remounting, and matches
 * createSearchPanel's approach — so `sources`/`actionDeps` are captured once at construction time.
 * `actionDeps` (issue #1143, task 6) is the per-result quick-action effect seam `actionsFor` calls
 * into; Task 8 supplies the concrete binding to `lsp`/`platform`/`openUri`/clipboard.
 */
export function createLauncher(sources: LauncherSources, actionDeps: LauncherActionDeps): LauncherHandle {
  const host = el('div', { class: 'lx-host' });
  document.body.appendChild(host);
  let isOpen = false;
  let opener: HTMLElement | null = null; // element focused before the launcher opened, restored on close
  // Set once by the mounted panel (onRegisterToast) so `handle.toast(...)` can raise its `.lx-toast`.
  let requestToast: ((message: string) => void) | null = null;
  // Set once by the mounted panel (onRegisterPeek) so `handle.peek(entry)` can pin its preview (#1165).
  let requestPeek: ((entry: CatalogEntry) => void) | null = null;

  function paint(): void {
    render(
      <LauncherPanel
        sources={sources}
        visible={isOpen}
        onClose={close}
        actionDeps={actionDeps}
        onRegisterToast={(fn) => {
          requestToast = fn;
        }}
        onRegisterPeek={(fn) => {
          requestPeek = fn;
        }}
      />,
      host,
    );
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
    toast(message: string) {
      requestToast?.(message);
    },
    peek(entry: CatalogEntry) {
      requestPeek?.(entry);
    },
  };
}
