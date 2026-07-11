// About panel facade for Koine Studio (#991 task 4): a thin adapter between the pre-existing
// `createAboutPanel(): { el, refresh }` contract — unchanged, so `prefsSections/about.ts` (and through
// it `prefs.ts:1979`) needs no update — and the Preact `About` component (About.tsx, the panel's real
// content). `refresh()` bumps a `refreshToken` and re-renders; About.tsx's own effect (keyed on that
// token) does the actual version (re)fetch and chip fill/hide — see its doc comment for that contract.
//
// Kept a plain `.ts` file (no JSX) per the migration plan's file list, so the vnode is built with
// `createElement` — the same idiom `src/ai/aiPanel.ts`'s `rerender()` facade already uses for a
// re-render-on-demand `.ts` host around a Preact component.
import { createElement, render } from 'preact';
import { getPlatform } from '@/host';
// Explicit `.tsx` extension (not the bare `@/settings/About` specifier): this directory has both a
// lowercase `about.ts` (this facade) and a capitalized `About.tsx` (the component) — on a case-
// INSENSITIVE filesystem (default macOS/Windows), Vite's extension-probing checks `About.ts` before
// `About.tsx` and that probe case-insensitively matches THIS file, silently importing `about.ts` from
// itself (About resolves to `undefined`, and Preact stringifies the resulting vnode's props object as
// literal DOM text — "[object Object]"). Reproduced and root-caused locally (#991 task 4); verified the
// explicit extension resolves correctly regardless of filesystem case-sensitivity.
import { About } from '@/settings/About.tsx';

/** A built About panel: the content element plus a hook to refresh the version chip. */
export interface AboutPanel {
  /** The panel content, to drop into a Settings tab panel. */
  readonly el: HTMLElement;
  /** Re-fetch the app version and (re)fill or hide the build chip. Safe to call on every open. */
  refresh(): void;
}

/** Build the About panel content (once) and return it with a version-refresh hook. */
export function createAboutPanel(): AboutPanel {
  const platform = getPlatform();

  // `el` carries the `.koi-about` layout class ITSELF — not a transparent wrapper around a child
  // `.koi-about` node — matching the node identity the pre-Preact builder returned (about.test.ts
  // asserts `about.el.classList.contains('koi-about')` directly). About.tsx renders its content as a
  // Fragment (no owning wrapper div) for exactly this reason.
  const root = document.createElement('div');
  root.className = 'koi-about';

  // refreshToken starts at 0 ("never refreshed"); About.tsx's fetch effect treats 0 as inert so mount
  // alone never fetches — only a refresh() call does, matching the original chip's hidden-until-
  // refresh() contract.
  let refreshToken = 0;
  function paint(): void {
    render(createElement(About, { platform, refreshToken }), root);
  }
  paint();

  function refresh(): void {
    refreshToken += 1;
    paint();
  }

  return { el: root, refresh };
}
