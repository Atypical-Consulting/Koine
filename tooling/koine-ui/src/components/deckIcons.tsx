// Small line-icon closures used internally by DeckCard/DeckSpine (the deck's close / overview / split /
// swap glyphs). Ported from Koine Studio's `src/shell/deck/surfaces.tsx` icon registry (issue #905,
// Task 4 + concept-7) — only the icons the moved components render INTERNALLY (not supplied via a prop)
// came along; the full Canvas/Code/Output/Docs surface registry is Koine-Studio-specific domain data and
// stays in the app (see DeckCard.tsx's top-of-file note on the DeckCardSurface boundary).
import type { JSX } from 'preact';

function svg(children: JSX.Element, opts: { strokeWidth?: number; lineCap?: boolean } = {}) {
  return (props: { class?: string }) => (
    <svg
      class={props.class}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={opts.strokeWidth ?? 1.7}
      stroke-linecap={opts.lineCap ? 'round' : undefined}
      stroke-linejoin={opts.lineCap ? 'round' : undefined}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** DeckCard's close-button glyph. */
export const IconClose = svg(<path d="M6 6l12 12M18 6 6 18" />, { strokeWidth: 2, lineCap: true });

/** DeckSpine's Overview-toggle glyph — a 2x2 grid. */
export const IconOverview = svg(
  <>
    <rect x="3" y="3" width="8" height="8" rx="1.5" />
    <rect x="13" y="3" width="8" height="8" rx="1.5" />
    <rect x="3" y="13" width="8" height="8" rx="1.5" />
    <rect x="13" y="13" width="8" height="8" rx="1.5" />
  </>,
);

/** DeckSpine's "open beside" glyph — a split rectangle. */
export const IconSplit = svg(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M12 4v16" />
  </>,
);

/** DeckSpine's 2-up "swap sides" glyph — two opposed arrows (docked at the seam). */
export const IconSwap = svg(<path d="M7 4 3 8l4 4M3 8h13M17 20l4-4-4-4M21 16H8" />, { strokeWidth: 1.8, lineCap: true });
