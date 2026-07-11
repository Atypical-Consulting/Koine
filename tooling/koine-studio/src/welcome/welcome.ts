// The routed Home view for Koine Studio — a thin facade over the Preact `Home` component (#991 task 3).
// `mountHome` renders `Home` into a caller-supplied container (not `document.body`) and returns an
// imperative `HomeHandle` so `main.ts` (its single caller) never changed across the migration. The
// component is store-free (it renders pre-IDE-boot): props + callbacks + `settings/persistence` reads
// only. The pure gallery helpers (`filterTemplates` / `DIFFICULTY_ORDER`) and the `WelcomeCallbacks` /
// `TemplateFilter` types live in `Home.tsx` and are re-exported here so importers are unaffected.
import { h, render as preactRender } from 'preact';
import {
  Home,
  filterTemplates,
  DIFFICULTY_ORDER,
  type WelcomeCallbacks,
  type TemplateFilter,
  type HomeControls,
} from '@/welcome/Home';
import { TEMPLATES, type Template } from '@/welcome/templates';

export { filterTemplates, DIFFICULTY_ORDER };
export type { WelcomeCallbacks, TemplateFilter };

/**
 * The routed Home view's imperative handle (returned by {@link mountHome}). Beyond teardown it exposes
 * the seams the boot layer drives when an open-recent start-intent fails: {@link refreshRecent} to
 * rebuild the recents list in place, {@link recover} to run the dead-recent recovery on Home (#391), and
 * {@link notifyClonedEmpty} to surface the "cloned, but empty" outcome (#1017).
 */
export interface HomeHandle {
  destroy(): void;
  /** Rebuild the recent-folders list from storage, in place. */
  refreshRecent(): void;
  /** Confirm "Remove from Recent?" on this view and, on accept, forget the dead entry + refresh the list. */
  recover(path: string): Promise<void>;
  /** Tell the user a clone succeeded but has no `.koi` files yet, offering "Open anyway" (#1017). */
  notifyClonedEmpty(path: string): Promise<void>;
}

/**
 * Mount the welcome screen as a routed, full-page Home view inside `container` — the Home half of issue
 * #368's distinct Home/Editor routes. No `document.body` overlay and no `hidden` toggle: the card shows
 * the moment it mounts, recents rendered immediately. `destroy()` unmounts the Preact tree (running every
 * effect cleanup — the document-level keydown listener and any open gallery overlay registration) and
 * detaches it when the router swaps to the editor. Pass `opts.warm` when the editor is live this session
 * so the resume card's live "ping" dot shows; the card self-gates on the persisted last-session snapshot.
 */
export function mountHome(
  container: HTMLElement,
  cb: WelcomeCallbacks,
  templates: readonly Template[] = TEMPLATES,
  canOpenFolders = true,
  opts: { warm?: boolean; canClone?: boolean; canResume?: boolean } = {},
): HomeHandle {
  // The component registers its imperative seams here on mount (via a layout effect), so the handle's
  // methods delegate through this ref — set synchronously by the time `mountHome` returns.
  const controls: { current: HomeControls | null } = { current: null };

  preactRender(
    h(Home, {
      cb,
      templates,
      canOpenFolders,
      warm: opts.warm,
      canClone: opts.canClone,
      canResume: opts.canResume,
      controls,
    }),
    container,
  );

  return {
    destroy: () => preactRender(null, container),
    refreshRecent: () => controls.current?.refreshRecent(),
    recover: (path) => controls.current?.recover(path) ?? Promise.resolve(),
    notifyClonedEmpty: (path) => controls.current?.notifyClonedEmpty(path) ?? Promise.resolve(),
  };
}
