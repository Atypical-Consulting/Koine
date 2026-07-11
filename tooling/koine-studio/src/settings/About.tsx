// About panel content for Koine Studio (#991 task 4): the app's colophon, shown as the last tab of the
// Settings dialog. Renders the brand monogram, the wordmark + a mono build chip (version resolved via
// `platform.appVersion()` — the `app_version` Tauri command on desktop, a build-time constant in the
// browser), a tagline, a grid of links out to the project (GitHub, home, docs, blog), and a creator
// credit. The colophon CONTENT — the links, creator URL, byline and the version-chip fill logic — lives
// in `@/shared/colophon`, the single source of truth this panel and the Home footer (`welcome/welcome.ts`,
// not yet migrated) both consume; links are routed through `wireExternalLink`/`platform.openExternal` so
// they open in the system browser on both the desktop and web hosts, never navigating the webview.
//
// Rendered as a Fragment — no owning wrapper `<div class="koi-about">`. The `createAboutPanel()` facade
// (`about.ts`) mounts this INTO a host div it already stamped with that class itself, preserving the
// exact node identity `about.test.ts` asserts on directly (`about.el.classList.contains('koi-about')`) —
// the same "governs a pre-classed host" shape as `CONTRIBUTING-preact-migration.md`'s `UnsavedIndicator`
// variant, adapted for a panel that owns real children rather than driving attributes on a static node.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { Platform } from '@/host';
import { koineMark } from '@/shared/logo';
import { PROJECT_LINKS, CREATOR_URL, CREATOR_NAME, CREDIT_PREFIX, TAGLINE, wireExternalLink } from '@/shared/colophon';

export interface AboutProps {
  /** Injected (never read via `getPlatform()` internally) so stories/tests can seed a fake — mirrors
   *  `SourceControlPanel`'s injected `git` surface. */
  platform: Platform;
  /** Bumped by the `createAboutPanel()` facade's `refresh()` on every Settings open. `0` means "never
   *  refreshed yet" — the version-fetch effect below stays inert until the first bump, matching the
   *  original DOM builder's hidden-until-refresh() chip contract. */
  refreshToken: number;
}

/** The About panel content: brand mark, wordmark, mono build chip, tagline, project-link grid and
 *  creator credit. */
export function About({ platform, refreshToken }: AboutProps) {
  const [version, setVersion] = useState<string | null>(null);

  // Fetch lazily: mount alone (refreshToken === 0) never fetches — only a refresh() call (which bumps
  // the token) does. A failed OR empty resolution puts (or leaves) the chip hidden, exactly like the
  // original `fillVersionChip` (@/shared/colophon) this replaces.
  useEffect(() => {
    if (refreshToken === 0) return;
    let cancelled = false;
    platform
      .appVersion()
      .then((v) => {
        if (!cancelled) setVersion(v ? `v${v}` : null);
      })
      .catch(() => {
        if (!cancelled) setVersion(null);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken, platform]);

  return (
    <>
      {/* The shared, single-ink brand mark (logo.ts): id-free, so this copy and the Home footer's copy
          (welcome.ts) never collide, and it tracks the theme via stroke=var(--koi-accent). */}
      <div
        class="koi-welcome-logo koi-about-logo"
        aria-hidden="true"
        // eslint-disable-next-line no-restricted-syntax -- static, trusted brand mark from logo.ts (koineMark returns a fixed SVG); ide.tsx:199 carries the identical disable for the same call
        dangerouslySetInnerHTML={{ __html: koineMark() }}
      />

      <p class="koi-about-wordmark">
        Koine <span>Studio</span>
      </p>

      <span class="koi-about-chip" hidden={version === null}>
        {version ?? ''}
      </span>

      <p class="koi-about-tagline">{TAGLINE}</p>

      <div class="koi-about-links">
        {PROJECT_LINKS.map((link) => (
          <ExternalLink key={link.label} class="koi-about-link" href={link.href} platform={platform}>
            <span
              class="koi-about-link-icon"
              aria-hidden="true"
              // eslint-disable-next-line no-restricted-syntax -- static, trusted icon markup from the PROJECT_LINKS constant (@/shared/colophon), not user input
              dangerouslySetInnerHTML={{ __html: link.icon }}
            />
            <span class="koi-about-link-text">
              <span class="koi-about-link-label">{link.label}</span>
              <span class="koi-about-link-hint">{link.hint}</span>
            </span>
          </ExternalLink>
        ))}
      </div>

      <p class="koi-about-credit">
        {CREDIT_PREFIX}
        <ExternalLink class="koi-about-author" href={CREATOR_URL} platform={platform}>
          {CREATOR_NAME}
        </ExternalLink>
        .
      </p>
    </>
  );
}

/** An external `<a target="_blank" rel="noopener noreferrer">` wired through `wireExternalLink` /
 *  `platform.openExternal` instead of a webview navigation — shared by the project-link grid and the
 *  creator credit. Wired once per (href, platform) via a ref effect, so the click handler is the exact
 *  same shared helper the Home footer (`welcome.ts`) uses, not a re-implementation. */
function ExternalLink(props: { class: string; href: string; platform: Platform; children: ComponentChildren }) {
  const ref = useRef<HTMLAnchorElement | null>(null);
  useEffect(() => {
    if (ref.current) wireExternalLink(ref.current, props.href, props.platform);
  }, [props.href, props.platform]);
  return (
    <a ref={ref} class={props.class} href={props.href} target="_blank" rel="noopener noreferrer">
      {props.children}
    </a>
  );
}
