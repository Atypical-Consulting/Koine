import { useEffect, useRef } from 'preact/hooks';
import type { ComponentChildren, JSX } from 'preact';
import type { Platform } from '@/host';
import { wireExternalLink } from '@/shared/colophon';

/** An external `<a target="_blank" rel="noopener noreferrer">` wired through `wireExternalLink` /
 *  `platform.openExternal` (so it opens in the system browser, not the webview) — the same helper the
 *  About panel uses.
 *
 *  Hoisted out of `welcome/Home.tsx` (#1926) so any surface can offer a real off-app link: Home's
 *  colophon, and the Source Control panel's browser empty state pointing at the desktop downloads. The
 *  `platform` prop is narrowed to just the method it calls, so a caller holding a slice of the platform
 *  (e.g. `SourceControlPanel`'s injected `GitSurface`) can pass it directly — a full {@link Platform}
 *  satisfies it structurally. */
export function ExternalLink(props: {
  class: string;
  href: string;
  title?: string;
  platform: Pick<Platform, 'openExternal'>;
  children: ComponentChildren;
}): JSX.Element {
  const ref = useRef<HTMLAnchorElement | null>(null);
  useEffect(() => {
    if (ref.current) wireExternalLink(ref.current, props.href, props.platform);
  }, [props.href, props.platform]);
  return (
    <a ref={ref} class={props.class} href={props.href} title={props.title} target="_blank" rel="noopener noreferrer">
      {props.children}
    </a>
  );
}
