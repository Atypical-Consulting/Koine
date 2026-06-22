// About dialog for Koine Studio: the app's colophon. Uses the shared createModal() chrome to show
// the brand monogram, the wordmark + a mono build chip (version from the platform — the `app_version`
// Tauri command on desktop, a build-time constant in the browser), a tagline, a grid of links out to
// the project (GitHub, home, docs, blog), and a creator credit. The version is (re)fetched each time
// the dialog opens; a failed fetch simply hides the chip. Project links are routed through
// `platform.openExternal` so they open in the system browser on both the desktop and web hosts.
import { getPlatform } from '@/host';
import { createModal } from '@/shared/overlay';
import { koineMark } from '@/shared/logo';

export interface AboutHandle {
  open(): void;
  close(): void;
}

const TAGLINE = 'Write a bounded context once. Generate the code.';

/** Where the project lives. Order here is the on-screen order of the link grid. */
interface ProjectLink {
  label: string;
  hint: string;
  href: string;
  icon: string; // inline 16×16 SVG, drawn in the toolbar's line-icon idiom (filled for GitHub)
}

const LINKS: ProjectLink[] = [
  {
    label: 'GitHub',
    hint: 'Source & issues',
    href: 'https://github.com/Atypical-Consulting/Koine',
    icon: '<svg class="tb-ico" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" stroke="none" d="M8 .2a8 8 0 0 0-2.53 15.6c.4.07.55-.17.55-.38v-1.35c-2.22.48-2.69-1.07-2.69-1.07-.36-.92-.89-1.17-.89-1.17-.72-.5.06-.49.06-.49.8.06 1.22.83 1.22.83.71 1.22 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.77-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.03 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 8 .2z"/></svg>',
  },
  {
    label: 'Home',
    hint: 'Project landing page',
    href: 'https://atypical-consulting.github.io/Koine/',
    icon: '<svg class="tb-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.6 7.6 8 3l5.4 4.6M4 6.4V13h8V6.4"/></svg>',
  },
  {
    label: 'Docs',
    hint: 'Guides & reference',
    href: 'https://atypical-consulting.github.io/Koine/start/what-is-koine/',
    icon: '<svg class="tb-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.6h4.7L12 5.9v7.5H4z"/><path d="M8.4 2.7v3.2h3.2M6.1 8.7h3.8M6.1 10.9h3.8"/></svg>',
  },
  {
    label: 'Blog',
    hint: 'Notes & releases',
    href: 'https://atypical-consulting.github.io/Koine/blog/',
    icon: '<svg class="tb-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.4h10M3 8h10M3 11.6h6"/></svg>',
  },
];

const CREATOR_URL = 'https://github.com/phmatray';

/** Build the About modal (once) and return an `{ open, close }` handle. */
export function createAboutDialog(): AboutHandle {
  const platform = getPlatform();
  const modal = createModal({ title: 'About', ariaLabel: 'About Koine Studio' });

  const logo = document.createElement('div');
  logo.className = 'koi-welcome-logo koi-about-logo'; // shared logo container
  logo.setAttribute('aria-hidden', 'true');
  // koineMark() mints a fresh gradient id, so this monogram never collides with the welcome overlay's
  // copy (a shared id would leave this tile unfilled once the overlay is dismissed to display:none).
  logo.innerHTML = koineMark();

  const wordmark = document.createElement('p');
  wordmark.className = 'koi-about-wordmark';
  wordmark.append('Koine ');
  const studio = document.createElement('span');
  studio.textContent = 'Studio';
  wordmark.append(studio);

  // Mono build chip — filled in with the version on open(), hidden until then (and if a fetch fails).
  const chip = document.createElement('span');
  chip.className = 'koi-about-chip';
  chip.hidden = true;

  const tagline = document.createElement('p');
  tagline.className = 'koi-about-tagline';
  tagline.textContent = TAGLINE;

  // Open an external link through the platform (new tab in the browser, OS handoff on desktop)
  // rather than letting the <a> navigate the webview. href stays real for a11y / copy-link / middle-click.
  function openLink(e: MouseEvent, href: string): void {
    e.preventDefault();
    platform.openExternal(href);
  }

  const links = document.createElement('div');
  links.className = 'koi-about-links';
  for (const link of LINKS) {
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
    a.addEventListener('click', (e) => openLink(e, link.href));
    links.append(a);
  }

  // Creator credit — the one human fact this dialog exists to carry.
  const credit = document.createElement('p');
  credit.className = 'koi-about-credit';
  credit.append('The Koine language and this studio are designed & built by ');
  const author = document.createElement('a');
  author.className = 'koi-about-author';
  author.href = CREATOR_URL;
  author.target = '_blank';
  author.rel = 'noopener noreferrer';
  author.textContent = 'Philippe Matray';
  author.addEventListener('click', (e) => openLink(e, CREATOR_URL));
  credit.append(author, '.');

  modal.body.append(logo, wordmark, chip, tagline, links, credit);

  // Fetch the version lazily on each open so a slow/absent command never blocks construction.
  // A failed invoke just leaves the chip hidden rather than surfacing an error.
  modal.onOpen(() => {
    void platform
      .appVersion()
      .then((v) => {
        chip.textContent = v ? `v${v}` : '';
        chip.hidden = !v;
      })
      .catch(() => {
        chip.hidden = true;
      });
  });

  return { open: modal.open, close: modal.close };
}
