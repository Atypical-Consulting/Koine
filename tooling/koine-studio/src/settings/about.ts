// About panel for Koine Studio: the app's colophon, shown as the last tab of the Settings dialog.
// Builds the brand monogram, the wordmark + a mono build chip (version from the platform — the
// `app_version` Tauri command on desktop, a build-time constant in the browser), a tagline, a grid of
// links out to the project (GitHub, home, docs, blog), and a creator credit. `refresh()` (re)fetches
// the version each time Settings opens; a failed fetch simply hides the chip. The colophon content —
// the links, creator URL, byline and the version-chip fill logic — lives in `@/shared/colophon`, the
// single source of truth this panel and the Home footer (welcome.ts) both consume; links are routed
// through `platform.openExternal` so they open in the system browser on both the desktop and web hosts.
import { getPlatform } from '@/host';
import { koineMark } from '@/shared/logo';
import { PROJECT_LINKS, CREATOR_URL, CREATOR_NAME, CREDIT_PREFIX, TAGLINE, fillVersionChip, wireExternalLink } from '@/shared/colophon';

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

  const root = document.createElement('div');
  root.className = 'koi-about';

  const logo = document.createElement('div');
  logo.className = 'koi-welcome-logo koi-about-logo'; // shared logo container
  logo.setAttribute('aria-hidden', 'true');
  // The shared, single-ink brand mark (logo.ts): id-free, so this copy and the welcome overlay's can
  // never collide, and it tracks the theme via stroke=var(--koi-accent).
  logo.innerHTML = koineMark();

  const wordmark = document.createElement('p');
  wordmark.className = 'koi-about-wordmark';
  wordmark.append('Koine ');
  const studio = document.createElement('span');
  studio.textContent = 'Studio';
  wordmark.append(studio);

  // Mono build chip — filled in by refresh(), hidden until then (and if a fetch fails).
  const chip = document.createElement('span');
  chip.className = 'koi-about-chip';
  chip.hidden = true;

  const tagline = document.createElement('p');
  tagline.className = 'koi-about-tagline';
  tagline.textContent = TAGLINE;

  const links = document.createElement('div');
  links.className = 'koi-about-links';
  for (const link of PROJECT_LINKS) {
    const a = document.createElement('a');
    a.className = 'koi-about-link';
    a.href = link.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';

    const icon = document.createElement('span');
    icon.className = 'koi-about-link-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = link.icon;

    const text = document.createElement('span');
    text.className = 'koi-about-link-text';
    const label = document.createElement('span');
    label.className = 'koi-about-link-label';
    label.textContent = link.label;
    const hint = document.createElement('span');
    hint.className = 'koi-about-link-hint';
    hint.textContent = link.hint;
    text.append(label, hint);

    a.append(icon, text);
    wireExternalLink(a, link.href, platform);
    links.append(a);
  }

  // Creator credit — the one human fact this panel exists to carry.
  const credit = document.createElement('p');
  credit.className = 'koi-about-credit';
  credit.append(CREDIT_PREFIX);
  const author = document.createElement('a');
  author.className = 'koi-about-author';
  author.href = CREATOR_URL;
  author.target = '_blank';
  author.rel = 'noopener noreferrer';
  author.textContent = CREATOR_NAME;
  wireExternalLink(author, CREATOR_URL, platform);
  credit.append(author, '.');

  root.append(logo, wordmark, chip, tagline, links, credit);

  // Fetch the version lazily on each open so a slow/absent command never blocks construction.
  // A failed invoke just leaves the chip hidden rather than surfacing an error.
  function refresh(): void {
    fillVersionChip(chip, platform);
  }

  return { el: root, refresh };
}
