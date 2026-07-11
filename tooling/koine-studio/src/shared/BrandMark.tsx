import type { JSX } from 'preact';
import { koineMark } from '@/shared/logo';

/**
 * The Koine brand mark (hexagon-κ) as a reusable Preact component. Renders the static,
 * trusted SVG from `koineMark()` as real JSX instead of dangerouslySetInnerHTML, allowing
 * the consuming panels (About, Home) to remove their per-line eslint-disable comments.
 * The SVG is single-ink, theme-tracking (strokes via `var(--koi-accent)`), and id-free.
 */
export function BrandMark(props: { class?: string }): JSX.Element {
  return (
    <span
      class={props.class}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: koineMark() }}
    />
  );
}
