// The Koine colophon: the single source of truth for the app's project links, creator credit, tagline
// and the version-chip fill logic. Both surfaces that show "what version am I on, where are the docs,
// who made this" consume it — the Settings → About tab (settings/about.ts) and the Home/welcome footer
// (welcome/welcome.ts) — so a link rename or byline tweak is a one-line edit that updates both.
import type { Platform } from '@/host';

/** Where the project lives. Order here is the on-screen order of the link grid / row. */
export interface ProjectLink {
  label: string;
  hint: string;
  href: string;
  icon: string; // inline 16×16 SVG, drawn in the toolbar's line-icon idiom (filled for GitHub)
}

export const PROJECT_LINKS: ProjectLink[] = [
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

export const CREATOR_URL = 'https://github.com/phmatray';
export const CREATOR_NAME = 'Philippe Matray';

/** The byline, split so each surface can render the author as a link: `CREDIT_PREFIX` + <a>name</a> + '.'. */
export const CREDIT_PREFIX = 'The Koine language and this studio are designed & built by ';

export const TAGLINE = 'Write a bounded context once. Generate the code.';

/**
 * Lazily fetch the app version and (re)fill or hide the build chip. The version comes only from
 * `platform.appVersion()` — the `app_version` Tauri command on desktop, a build-time constant in the
 * browser. A slow/absent command never blocks construction; a failed/empty fetch simply leaves the
 * chip hidden rather than surfacing an error. Safe to call repeatedly.
 */
export function fillVersionChip(chip: HTMLElement, platform: Platform): void {
  void platform
    .appVersion()
    .then((v) => {
      chip.textContent = v ? `v${v}` : '';
      chip.hidden = !v;
    })
    .catch(() => {
      chip.hidden = true;
    });
}
