// The routed Home view for Koine Studio — mounts into a container provided by the router rather than as
// a full-cover overlay on document.body. Offers the first actions: start a new model, open a folder, or
// reopen a recent one. The hero shows the product's thesis as a live artifact — a real `.koi` snippet
// (the ubiquitous language) that Koine turns into idiomatic code — rather than describing it in prose.
// The recent list is a managed history rebuilt from getRecentFolders() on each mount; each row
// can be opened, pinned (pinned entries float to the top and survive the cap), have its path copied, or
// be removed; a search filter appears once the history grows past a threshold, a clear-all control
// forgets everything, and the list scrolls within its own container so a long history never grows the card.
import {
  getRecentFolders,
  removeRecentFolder,
  pinRecentFolder,
  clearRecentFolders,
  getLastSession,
  type RecentFolder,
} from '@/settings/persistence';
import { getPlatform } from '@/host';
import { EMIT_TARGETS } from '@/shared/emitTargets';
import { registerOverlay, koiConfirm } from '@atypical/koine-ui';
import { PROJECT_LINKS, CREATOR_URL, CREATOR_NAME, CREDIT_PREFIX, fillVersionChip, wireExternalLink } from '@/shared/colophon';
import { TEMPLATES, type Template } from '@/welcome/templates';
import { wrapIndex } from '@/shared/wrapIndex';
import { basename } from '@/shared/path';
import { koineMark } from '@/shared/logo';
import { toggleTheme } from '@/settings/theme';
import { MOD } from '@/shared/platform';

/** What the welcome actions delegate to; the host (ide.ts) performs the real work. */
export interface WelcomeCallbacks {
  onNewModel(): void;
  onOpenFolder(): void;
  onOpenRecent(path: string): void;
  /** Open one of the starter templates as a workspace. */
  onOpenExample(template: Template): void;
  /**
   * Return to the user's editor session — fired by the rich resume-session card (#1005), rendered at the
   * top of the launch rail whenever a persisted last-session snapshot exists (getLastSession). Unlike the
   * start actions it sets no template/folder intent; what it resolves to is the caller's concern (issues
   * #392 / #766): a pure route swap back into a still-live session, or a cold boot that restores the last
   * workspace. Optional: callers that don't offer a resume path can omit it.
   */
  onResume?(): void;
  /**
   * Open the Settings surface — fired by the top bar's gear button. Home can't render Settings itself
   * (it's an editor-hosted overlay), so the caller (main.ts) routes to the editor and shows the overlay
   * there. Optional: callers with nowhere to route settings can omit it, and the gear no-ops.
   */
  onOpenSettings?(): void;
  /**
   * Clone the git repository at `url` — fired by the Home "Clone repository" inline form (#1005), which
   * only renders when the host reports the `canClone` capability. The caller (main.ts) picks a parent
   * folder, runs `Platform.gitClone`, records the clone as a recent, and opens it. The form awaits this:
   * a REJECTION is surfaced inline (an error under the URL, the form left open to retry), and a RESOLVE
   * means the caller has taken over navigation. Optional: hosts that can't clone omit it and no row shows.
   */
  onClone?(url: string): Promise<void>;
}

/**
 * A repository URL the Home clone form accepts: an http(s), scp-style `git@host:…`, or `ssh://` URL,
 * each followed by at least one non-space character. Deliberately permissive — the real validation is
 * the clone attempt itself; this only gates the button so an obviously-empty/garbage value can't submit.
 */
const CLONE_URL_RE = /^(https?:\/\/|git@|ssh:\/\/)\S+/;

/** Canonical difficulty ordering — starters first, advanced last. Drives grouping and chip order. */
export const DIFFICULTY_ORDER: Template['difficulty'][] = ['starter', 'beginner', 'intermediate', 'advanced'];

/** The recent list shows this many rows collapsed; a "View all" toggle then reveals the rest. */
const RECENT_COLLAPSE_LIMIT = 6;

/** The active gallery filters. Any field left undefined/empty is treated as "no constraint". */
export interface TemplateFilter {
  /** Free-text query matched (case-insensitive) against name, tagline and tags. */
  query?: string;
  /** A single tag the template must carry. */
  tag?: string;
  /** A single difficulty the template must be. */
  difficulty?: Template['difficulty'];
}

/**
 * Pure, side-effect-free filter over a template list — the testable core of the gallery. Preserves
 * input order. A template passes when it satisfies *all* of the supplied constraints (logical AND):
 * the query substring-matches its name/tagline/any tag, and the tag/difficulty (if given) match.
 */
export function filterTemplates(templates: readonly Template[], filter: TemplateFilter): Template[] {
  const q = (filter.query ?? '').trim().toLowerCase();
  return templates.filter((t) => {
    if (filter.difficulty && t.difficulty !== filter.difficulty) return false;
    if (filter.tag && !t.tags.includes(filter.tag)) return false;
    if (q) {
      const haystack = [t.name, t.tagline, ...t.tags].join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

/**
 * A compact, human relative-time label for the resume card's last-edit stamp: "just now" under a
 * minute, then "N min ago", "Nh ago", "Nd ago". Pure over an explicit `now` so it's deterministic to
 * test. A future/clock-skewed `then` is clamped to "just now" rather than showing a negative age.
 */
function timeAgo(then: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - then) / 1000));
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/** Whether the user asks for less motion — so the resume card's live ping never animates for them. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

// The hero artifact: the canonical Money value object, lifted verbatim from the billing starter
// (templates/starters/billing). Syntax-coloured with the editor's own token hues (--koi-hl-*) so the
// snippet reads as real Koine, not a marketing mock. Content is fully static — no user input — so an
// innerHTML template is safe here and far more legible than building each <span> imperatively.
const HERO_SNIPPET = `<span class="koi-syn-kw">value</span> <span class="koi-syn-type">Money</span> <span class="koi-syn-punct">{</span>
  <span class="koi-syn-id">amount</span><span class="koi-syn-punct">:</span>   <span class="koi-syn-type">Decimal</span>
  <span class="koi-syn-id">currency</span><span class="koi-syn-punct">:</span> <span class="koi-syn-type">Currency</span>
  <span class="koi-syn-kw">invariant</span> <span class="koi-syn-id">amount</span> <span class="koi-syn-punct">&gt;=</span> <span class="koi-syn-num">0</span> <span class="koi-syn-str">"a monetary amount cannot be negative"</span>
<span class="koi-syn-punct">}</span>`;

/** Plus / folder marks reused from the toolbar's New / Open buttons so the start actions read as the
 *  same controls a user meets later in the chrome (one vocabulary, learned once). */
const ICON_NEW = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.4v9.2M3.4 8h9.2"/></svg>';
const ICON_OPEN =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.2 4.3c0-.7.5-1.3 1.2-1.3h2.9l1.3 1.6h4.9c.7 0 1.3.6 1.3 1.3v6c0 .7-.6 1.2-1.3 1.2H3.4c-.7 0-1.2-.5-1.2-1.2z"/></svg>';
/** A 2×2 grid of cells — the example catalogue, drawn in the same stroked 16×16 style as New / Open. */
const ICON_GALLERY =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.4" y="2.4" width="4.4" height="4.4" rx="1"/><rect x="9.2" y="2.4" width="4.4" height="4.4" rx="1"/><rect x="2.4" y="9.2" width="4.4" height="4.4" rx="1"/><rect x="9.2" y="9.2" width="4.4" height="4.4" rx="1"/></svg>';
/** A left-pointing arrow — the "back to the start console" affordance on the gallery view. */
const ICON_BACK =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 3.5 5 8l4.5 4.5"/></svg>';
/** A right chevron — the quiet "opens this example" disclosure on each gallery card. */
const ICON_ARROW =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';
/** A crescent moon — the top-bar theme toggle, in the same stroked 16×16 style as the actions above. */
const ICON_THEME =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.2 9.3A5.4 5.4 0 0 1 6.7 2.8 5.4 5.4 0 1 0 13.2 9.3z"/></svg>';
/** A cog — the Settings gear: a toothed wheel (eight trapezoidal teeth) around a centre hub, drawn in the
 *  same stroked 16×16 style. A proper geared rim (not radial spokes, which read as a sun). */
const ICON_SETTINGS =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12.39 6.82L14.44 7.10L14.44 8.90L12.39 9.18L11.94 10.27L13.19 11.91L11.91 13.19L10.28 11.94L9.18 12.39L8.90 14.44L7.10 14.44L6.82 12.39L5.73 11.94L4.09 13.19L2.81 11.91L4.06 10.27L3.61 9.18L1.56 8.90L1.56 7.10L3.61 6.82L4.06 5.72L2.81 4.09L4.09 2.81L5.72 4.06L6.82 3.61L7.10 1.56L8.90 1.56L9.18 3.61L10.28 4.06L11.91 2.81L13.19 4.09L11.94 5.72Z"/><circle cx="8" cy="8" r="2.1"/></svg>';
/** A filled play triangle — the resume-session card's tile (#1005), the "continue where you left off" cue. */
const ICON_PLAY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.4v9.2L12.5 8z" fill="currentColor" stroke="none"/></svg>';
/** A git-branch glyph — marks the branch a recent folder was last opened on (teal, in the dense row). */
const ICON_BRANCH =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.5" cy="4" r="1.4"/><circle cx="4.5" cy="12" r="1.4"/><circle cx="11.5" cy="5.5" r="1.4"/><path d="M4.5 5.4v5.2M4.5 8.4c0-1.8 1-2.9 3.4-2.9h1"/></svg>';

/** Emit-target id → short display label (e.g. `csharp` → `C#`) for a recent row's language tag. Reads
 *  `EMIT_TARGETS` LIVE (it's replaced in place at boot with backend-seeded targets — see emitTargets.ts),
 *  never a module-load snapshot, so a custom target shows its name rather than its raw id. Falls back to
 *  the id when unknown. */
function langLabel(id: string): string {
  return EMIT_TARGETS.find((t) => t.id === id)?.displayName ?? id;
}

// The Start-action keycaps (#1005): the platform-aware primary modifier (MOD — ⌘ on mac, Ctrl
// elsewhere) plus the action's letter, with a leading ⇧ for the shift combos. Rendered as a quiet
// <kbd> on the right of each action and MIRRORED by buildHome's document-level keydown handler, so the
// on-screen hint and the shortcut that actually fires it can never drift apart.
const KEYCAP_SHIFT = '⇧';
const KEYCAP_NEW = `${MOD}N`;
const KEYCAP_EXAMPLE = `${MOD}E`;
const KEYCAP_CLONE = `${KEYCAP_SHIFT}${MOD}C`;
const KEYCAP_OPEN = `${KEYCAP_SHIFT}${MOD}O`;

/** Append a quiet, decorative keycap (`.koi-welcome-keycap` <kbd>) to a Start action/trigger. The glyph
 *  is set via textContent (platform-derived, not user input) and marked aria-hidden — the action's
 *  visible label already carries the accessible name (WCAG 2.5.3); the keycap is a redundant hint. */
function appendKeycap(host: HTMLElement, keycap: string): void {
  const cap = document.createElement('kbd');
  cap.className = 'koi-welcome-keycap';
  cap.setAttribute('aria-hidden', 'true');
  cap.textContent = keycap;
  host.appendChild(cap);
}

/** Build a start action as a button with an icon, a label and a one-line description. */
function makeAction(opts: {
  icon: string;
  label: string;
  desc: string;
  primary?: boolean;
  disabled?: boolean;
  /** Stable semantic hook (sets `data-action`) for tests and the routed Home's navigation wiring. */
  action?: string;
  /** An optional keyboard-shortcut keycap rendered on the right (e.g. `⌘N`); see the KEYCAP_* glyphs. */
  keycap?: string;
  onClick: () => void;
}): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = opts.primary ? 'koi-welcome-action primary' : 'koi-welcome-action';
  // No explicit aria-label: the accessible name is computed from the visible label + description
  // (the icon is aria-hidden), so it always contains the on-screen text — WCAG 2.5.3 (Label in Name).
  if (opts.disabled) btn.disabled = true;
  if (opts.action) btn.dataset.action = opts.action;

  const icon = document.createElement('span');
  icon.className = 'koi-welcome-action-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = opts.icon;

  const text = document.createElement('span');
  text.className = 'koi-welcome-action-text';
  const label = document.createElement('span');
  label.className = 'koi-welcome-action-label';
  label.textContent = opts.label;
  const desc = document.createElement('span');
  desc.className = 'koi-welcome-action-desc';
  desc.textContent = opts.desc;
  text.append(label, desc);

  btn.append(icon, text);
  if (opts.keycap) appendKeycap(btn, opts.keycap);
  btn.addEventListener('click', opts.onClick);
  return btn;
}

interface BuildWelcomeOpts {
  /**
   * The editor is live *this session* (issue #392) — the IDE booted behind the route. This is the ONLY
   * thing the caller still tells Home about resuming: whether to show the live "ping" dot on the resume
   * card. The card itself self-gates on the persisted last-session snapshot (getLastSession), so it
   * appears in both the warm (`warm: true`) and cold (`warm` absent, a prior snapshot on disk) cases.
   */
  warm?: boolean;
  /**
   * Whether this host can clone a git repository (#1005) — true on the desktop (real `git`), false in
   * the browser. Threaded from `Platform.canUseGit` by the caller. Gates the "Clone repository" Start
   * row and its inline form: rendered ONLY when true, mirroring how `canOpenFolders` gates "Open folder…".
   */
  canClone?: boolean;
  /**
   * There is a session to return to even if no rich snapshot exists (#766): the editor booted this
   * session, or a prior visit left the workspace-opened flag. The resume card shows whenever this is
   * true OR a {@link getLastSession} snapshot exists — with a snapshot it renders the full metadata,
   * without one it degrades to a minimal "Resume editing" card. Keeps the returning-user one-click
   * Resume that #766 guarantees, independent of whether Task 4's snapshot happens to be present.
   */
  canResume?: boolean;
}

/** What {@link buildHome} returns: the root element plus the seams {@link mountHome} re-exports. */
interface BuiltHome {
  readonly root: HTMLElement;
  destroy(): void;
  /** Rebuild the recent-folders list from storage, in place. */
  refreshRecent(): void;
  /** Surface the dead-recent recovery confirm and, on accept, forget the entry + refresh the list (#391). */
  recover(path: string): Promise<void>;
}

/**
 * The routed Home view's imperative handle (returned by {@link mountHome}). Beyond teardown it exposes
 * the two seams the boot layer drives when an open-recent start-intent fails: {@link refreshRecent} to
 * rebuild the recents list in place, and {@link recover} to run the dead-recent recovery on Home (#391)
 * instead of painting the legacy overlay over the editor.
 */
export interface HomeHandle {
  destroy(): void;
  /** Rebuild the recent-folders list from storage, in place. */
  refreshRecent(): void;
  /** Confirm "Remove from Recent?" on this view and, on accept, forget the dead entry + refresh the list. */
  recover(path: string): Promise<void>;
}

/**
 * Build the routed Home console: mounts into a caller-supplied container (not `document.body`), renders
 * recents immediately, and returns teardown and refresh seams. Torn down by {@link HomeHandle.destroy}
 * when the router navigates to the editor.
 */
function buildHome(
  cb: WelcomeCallbacks,
  templates: readonly Template[],
  canOpenFolders: boolean,
  opts: BuildWelcomeOpts,
): BuiltHome {
  // Live recent-folders filter query — closure-scoped so it survives renderRecent() re-renders but
  // resets per Home instance.
  let recentQuery = '';
  // Whether the recent list is expanded past its collapsed cap (View all / Show less). Sticky per Home
  // instance so a re-render (filter keystroke, pin, remove) preserves the user's expand choice.
  let recentExpanded = false;

  // The clone row's toggle trigger, captured when the clone Start row is built (canClone hosts only) so
  // the ⇧mod+C keyboard shortcut can activate it — null on hosts without git, where no row renders.
  let cloneTriggerEl: HTMLButtonElement | null = null;

  const root = document.createElement('div');
  root.className = 'koi-welcome koi-welcome-embedded';
  // Clicking the backdrop of the card pops one layer: if the gallery is open, close it; otherwise
  // there is nothing to dismiss (the routed Home is a destination, not an overlay over the editor).
  root.addEventListener('mousedown', (e) => {
    if (e.target !== root) return;
    if (galleryOpen) closeGallery();
  });

  // The app top bar region — a full-width strip above the card that persists across console↔gallery
  // swaps (it lives outside the card so both views share it): the brand on the left, the theme toggle
  // and Settings gear on the right. It uses a NEW `.koi-home-brand` class, never `.koi-welcome-brand`
  // (a suppression test asserts the legacy card-brand class stays absent on Home).
  const topbar = document.createElement('header');
  topbar.className = 'koi-home-topbar';
  const topbarStart = document.createElement('div');
  topbarStart.className = 'koi-home-topbar-slot koi-home-topbar-start';
  const topbarEnd = document.createElement('div');
  topbarEnd.className = 'koi-home-topbar-slot koi-home-topbar-end';

  // Brand lockup: the κ monogram tile + a "Koine" / "STUDIO" wordmark. The lockup carries the
  // accessible name; the monogram SVG and the wordmark text are decorative (aria-hidden) so the name
  // reads once, cleanly, as "Koine Studio". `koineMark('home')` gets a stable gradient id so this
  // single copy never collides with another mark elsewhere in the document.
  const brand = document.createElement('div');
  brand.className = 'koi-home-brand';
  brand.setAttribute('role', 'img');
  brand.setAttribute('aria-label', 'Koine Studio');

  const brandMark = document.createElement('span');
  brandMark.className = 'koi-home-brand-mark';
  brandMark.setAttribute('aria-hidden', 'true');
  brandMark.innerHTML = koineMark('home');

  const brandWord = document.createElement('span');
  brandWord.className = 'koi-home-brand-word';
  brandWord.setAttribute('aria-hidden', 'true');
  const brandName = document.createElement('span');
  brandName.className = 'koi-home-brand-name';
  brandName.textContent = 'Koine';
  const brandSub = document.createElement('span');
  brandSub.className = 'koi-home-brand-sub';
  brandSub.textContent = 'STUDIO';
  brandWord.append(brandName, brandSub);

  brand.append(brandMark, brandWord);
  topbarStart.appendChild(brand);

  // A quiet top-bar icon button (theme / settings), matching the toolbar's `.icon-btn` vocabulary.
  function makeTopbarIconButton(opts: { icon: string; label: string; onClick: () => void }): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'koi-home-iconbtn';
    btn.setAttribute('aria-label', opts.label);
    btn.title = opts.label;
    btn.innerHTML = opts.icon;
    btn.addEventListener('click', opts.onClick);
    return btn;
  }

  // Theme toggle: flips + applies + persists + notifies (theme.ts flips document root's data-theme).
  topbarEnd.appendChild(
    makeTopbarIconButton({
      icon: ICON_THEME,
      label: 'Toggle theme',
      onClick: () => {
        toggleTheme();
      },
    }),
  );
  // Settings gear: Home routes this to the editor's Settings overlay via the optional callback.
  topbarEnd.appendChild(
    makeTopbarIconButton({
      icon: ICON_SETTINGS,
      label: 'Settings',
      onClick: () => cb.onOpenSettings?.(),
    }),
  );

  topbar.append(topbarStart, topbarEnd);
  root.appendChild(topbar);

  const card = document.createElement('div');
  card.className = 'koi-welcome-card';
  root.appendChild(card);

  // The console and the example gallery are two views inside this one persistent card, not two separate
  // cards: switching between them swaps only the inner content (with a quiet fade) so the modal frame
  // stays put instead of tearing down and re-entering.
  const consoleView = document.createElement('div');
  consoleView.className = 'koi-welcome-view';
  card.appendChild(consoleView);

  // --- body: the thesis (left) + get-to-work rail (right), as a two-column grid ---
  // Full-bleed shell: a grid with the hero lede on the left and the launch rail (a fixed 424px
  // column) on the right, split by a 1px hairline. The right column scrolls independently. This
  // replaces the old .koi-welcome-hero wrapper; the lede/launch classes and their children are intact.
  const body = document.createElement('section');
  body.className = 'koi-home-body';
  consoleView.appendChild(body);

  // Left: eyebrow + editorial statement + the live snippet (the signature).
  const lede = document.createElement('div');
  lede.className = 'koi-welcome-lede';

  const eyebrow = document.createElement('p');
  eyebrow.className = 'koi-welcome-eyebrow';
  eyebrow.textContent = 'The language of your domain';

  const statement = document.createElement('h1');
  statement.className = 'koi-welcome-statement';
  // The brand word carries the gradient; the rest stays monochrome so the snippet keeps the spotlight.
  statement.innerHTML = 'Describe the domain.<br><span class="koi-welcome-grad">Koine</span> writes the code.';

  const figure = document.createElement('figure');
  figure.className = 'koi-welcome-snippet';

  const snipBar = document.createElement('figcaption');
  snipBar.className = 'koi-welcome-snippet-bar';
  const snipFile = document.createElement('span');
  snipFile.className = 'koi-welcome-snippet-file';
  snipFile.textContent = 'billing.koi';
  const snipKind = document.createElement('span');
  snipKind.className = 'koi-welcome-snippet-kind';
  snipKind.textContent = 'value object';
  snipBar.append(snipFile, snipKind);

  const pre = document.createElement('pre');
  pre.className = 'koi-welcome-snippet-code';
  pre.setAttribute('aria-label', 'A Koine value object: Money, with a non-negative invariant');
  const code = document.createElement('code');
  code.innerHTML = HERO_SNIPPET;
  pre.appendChild(code);

  const emit = document.createElement('p');
  emit.className = 'koi-welcome-snippet-emit';
  // Four language dots — one per emit target — each tinted with that target's own --lang-* token (the
  // tokens ship in @atypical/koine-ui; we only reference them). Together they show Koine's multi-target
  // reach at a glance, so the caption reads "one model → many languages", not C# alone.
  const emitDots = document.createElement('span');
  emitDots.className = 'koi-welcome-emit-dots';
  emitDots.setAttribute('aria-hidden', 'true');
  for (const lang of ['csharp', 'typescript', 'python', 'php']) {
    const dot = document.createElement('span');
    dot.className = 'koi-welcome-emit-dot';
    // The dot (and its halo, in SCSS) derive from this custom property so each language keeps its hue.
    dot.style.setProperty('--emit-dot', `var(--lang-${lang})`);
    emitDots.appendChild(dot);
  }
  const emitText = document.createElement('span');
  emitText.textContent = 'One model → idiomatic C#, TypeScript, Python & PHP.';
  emit.append(emitDots, emitText);

  figure.append(snipBar, pre, emit);
  lede.append(eyebrow, statement, figure);
  body.appendChild(lede);

  // Right: the launch rail — the resume card (when there's a session), then primary actions, then recents.
  const launch = document.createElement('div');
  launch.className = 'koi-welcome-launch';

  // The rich resume-session card (#1005): the "continue where you left off" affordance, pinned at the
  // TOP of the launch rail above the "Start" actions (per the hi-fi mock). It shows whenever there is a
  // persisted last-session snapshot (getLastSession — kept fresh on every open/save/dirty-change, Task 4)
  // OR the caller signals a resumable session (`opts.canResume`, the #766 returning-user guarantee). With
  // a snapshot it renders full metadata (project · file · relative time · unsaved); without one it
  // degrades to a minimal "Resume editing" card so the returning-user one-click Resume never disappears.
  // The whole card is the resume control (a real <button>, keyboard-operable), firing onResume; a live
  // "ping" dot marks a warm session, and every unknown field is simply omitted.
  const session = getLastSession();
  if (session || opts.canResume) {
    const resumeCard = document.createElement('button');
    resumeCard.type = 'button';
    resumeCard.className = 'koi-home-resume';
    resumeCard.dataset.action = 'resume';
    resumeCard.title = 'Return to your editor session';
    resumeCard.addEventListener('click', () => cb.onResume?.());

    const tile = document.createElement('span');
    tile.className = 'koi-home-resume-tile';
    tile.setAttribute('aria-hidden', 'true');
    tile.innerHTML = ICON_PLAY;
    // The live "ping" dot appears only for a warm session (editor mounted this session). Under
    // prefers-reduced-motion the dot still renders but drops its animating `is-live` class, so the CSS
    // ping never plays (belt-and-suspenders with the global reduced-motion collapse).
    if (opts.warm) {
      const ping = document.createElement('span');
      ping.className = 'koi-home-resume-ping';
      if (!prefersReducedMotion()) ping.classList.add('is-live');
      tile.appendChild(ping);
    }

    const bodyCol = document.createElement('span');
    bodyCol.className = 'koi-home-resume-body';

    const resumeEyebrow = document.createElement('span');
    resumeEyebrow.className = 'koi-home-resume-eyebrow';
    resumeEyebrow.textContent = 'Last session';
    bodyCol.appendChild(resumeEyebrow);

    // project · file — the file bit is omitted entirely when the snapshot has no active file.
    const meta = document.createElement('span');
    meta.className = 'koi-home-resume-meta';
    const project = document.createElement('span');
    project.className = 'koi-home-resume-project';
    // With a snapshot we show the real project name; without one (the #766 fallback — a returning user
    // whose one-click Resume is owed even before Task 4's snapshot is written) the card degrades to a
    // minimal "Resume editing" label and omits the file/time/unsaved detail entirely.
    project.textContent = session ? session.project : 'Resume editing';
    meta.appendChild(project);
    if (session?.file) {
      const sep = document.createElement('span');
      sep.className = 'koi-home-resume-sep';
      sep.setAttribute('aria-hidden', 'true');
      sep.textContent = '·';
      const file = document.createElement('span');
      file.className = 'koi-home-resume-file';
      file.textContent = basename(session.file);
      meta.append(sep, file);
    }
    bodyCol.appendChild(meta);

    if (session) {
      // relative time · unsaved count — the unsaved bit is omitted when unknown or zero.
      const detail = document.createElement('span');
      detail.className = 'koi-home-resume-detail';
      const time = document.createElement('span');
      time.className = 'koi-home-resume-time';
      time.textContent = timeAgo(session.editedAt, Date.now());
      detail.appendChild(time);
      if (session.unsavedCount && session.unsavedCount > 0) {
        const unsaved = document.createElement('span');
        unsaved.className = 'koi-home-resume-unsaved';
        unsaved.textContent = `${session.unsavedCount} unsaved`;
        detail.appendChild(unsaved);
      }
      bodyCol.appendChild(detail);
    }

    resumeCard.append(tile, bodyCol);
    launch.appendChild(resumeCard);
  }

  // The launch rail's heading row: the "Start" title. (The old right-aligned "Resume editing" pill is
  // gone — resuming now lives in the richer card above, #1005.)
  const launchHead = document.createElement('div');
  launchHead.className = 'koi-welcome-rail-head';

  const launchTitle = document.createElement('h2');
  launchTitle.className = 'koi-welcome-rail-title';
  launchTitle.textContent = 'Start';
  launchHead.appendChild(launchTitle);

  launch.appendChild(launchHead);

  const actions = document.createElement('div');
  actions.className = 'koi-welcome-actions';
  actions.appendChild(
    makeAction({
      icon: ICON_NEW,
      label: 'New model',
      desc: 'Begin with an empty context',
      primary: true,
      action: 'new-model',
      keycap: KEYCAP_NEW,
      onClick: () => {
        cb.onNewModel();
      },
    }),
  );
  // Opens the example gallery as a second view layered over this console (it does not leave the
  // welcome screen). Kept as a handle so focus can return here on close.
  const exampleAction = makeAction({
    icon: ICON_GALLERY,
    label: 'Start from an example',
    desc: 'Open a ready-made domain',
    action: 'open-example',
    keycap: KEYCAP_EXAMPLE,
    onClick: () => showGallery(),
  });
  actions.appendChild(exampleAction);
  actions.appendChild(
    makeAction({
      icon: ICON_OPEN,
      label: 'Open folder…',
      // Opening a folder needs the File System Access API (Chromium-only). Where it's missing, show the
      // action as disabled with an honest reason rather than a button that errors on click.
      desc: canOpenFolders ? 'Work on an existing workspace' : 'Needs a Chromium-based browser (Chrome / Edge)',
      disabled: !canOpenFolders,
      action: 'open-folder',
      // Only hint the shortcut where it works — the handler self-gates on canOpenFolders too.
      keycap: canOpenFolders ? KEYCAP_OPEN : undefined,
      onClick: () => {
        cb.onOpenFolder();
      },
    }),
  );

  // Clone repository (#1005) — a Start row that reveals an inline URL form, rendered ONLY when the host
  // can clone (`canClone`, from Platform.canUseGit) so the browser tab never shows an action it can't
  // honour (mirrors how "Open folder…" self-gates on canOpenFolders). The whole block is one wrapper the
  // toggle listens on; the trigger is a real button (keyboard-operable — its click, mouse OR Enter/Space,
  // bubbles up to toggle) and the form is its sibling below. Every click inside the form is contained
  // (stopPropagation) so interacting with the field/button never bubbles up to re-collapse the row.
  if (opts.canClone) {
    const cloneFormId = `koi-welcome-clone-form-${Math.random().toString(36).slice(2, 8)}`;
    let cloneOpen = false;

    const cloneRow = document.createElement('div');
    cloneRow.className = 'koi-welcome-clone';
    cloneRow.dataset.action = 'clone';

    // The visible row: same anatomy + styling as a makeAction Start button (icon tile + label/desc),
    // built inline so it carries NO own click handler — its click bubbles to cloneRow, the single toggle.
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'koi-welcome-action koi-welcome-clone-trigger';
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', cloneFormId);
    const triggerIcon = document.createElement('span');
    triggerIcon.className = 'koi-welcome-action-icon';
    triggerIcon.setAttribute('aria-hidden', 'true');
    triggerIcon.innerHTML = ICON_BRANCH;
    const triggerText = document.createElement('span');
    triggerText.className = 'koi-welcome-action-text';
    const triggerLabel = document.createElement('span');
    triggerLabel.className = 'koi-welcome-action-label';
    triggerLabel.textContent = 'Clone repository';
    const triggerDesc = document.createElement('span');
    triggerDesc.className = 'koi-welcome-action-desc';
    triggerDesc.textContent = 'Clone a git repository by URL';
    triggerText.append(triggerLabel, triggerDesc);
    trigger.append(triggerIcon, triggerText);
    appendKeycap(trigger, KEYCAP_CLONE);
    cloneTriggerEl = trigger; // let the ⇧mod+C shortcut activate this toggle

    const cloneForm = document.createElement('div');
    cloneForm.className = 'koi-welcome-clone-form';
    cloneForm.id = cloneFormId;
    cloneForm.hidden = true;
    // Contain every click inside the form so none bubbles to cloneRow's toggle (which would collapse the
    // form mid-interaction). This is the single guard the "click inside must not re-toggle" rule needs.
    cloneForm.addEventListener('click', (e) => e.stopPropagation());

    const controls = document.createElement('div');
    controls.className = 'koi-welcome-clone-controls';

    const urlInput = document.createElement('input');
    urlInput.type = 'text'; // NOT type=url: scp-style `git@host:…` URLs aren't valid <input type=url> values
    urlInput.className = 'koi-welcome-clone-url';
    urlInput.placeholder = 'https://github.com/user/repo.git';
    urlInput.setAttribute('aria-label', 'Repository URL to clone');
    urlInput.autocomplete = 'off';
    urlInput.spellcheck = false;

    const cloneSubmit = document.createElement('button');
    cloneSubmit.type = 'button';
    cloneSubmit.className = 'koi-welcome-clone-submit';
    cloneSubmit.textContent = 'Clone';
    cloneSubmit.disabled = true; // enabled once the URL validates (see below)

    controls.append(urlInput, cloneSubmit);

    const hint = document.createElement('p');
    hint.className = 'koi-welcome-clone-hint';
    hint.textContent = 'HTTPS or SSH URL — cloned into a folder you choose.';

    const errorEl = document.createElement('p');
    errorEl.className = 'koi-welcome-clone-error';
    errorEl.setAttribute('role', 'alert');
    errorEl.hidden = true;

    cloneForm.append(controls, hint, errorEl);
    cloneRow.append(trigger, cloneForm);

    const isValidUrl = (): boolean => CLONE_URL_RE.test(urlInput.value.trim());

    function toggleCloneForm(): void {
      cloneOpen = !cloneOpen;
      cloneForm.hidden = !cloneOpen;
      trigger.setAttribute('aria-expanded', String(cloneOpen));
      if (cloneOpen) urlInput.focus();
    }

    // Guards a clone in progress: blocks a second concurrent submit, and freezes the input handler from
    // re-enabling the button mid-flight. Without it, editing the URL during a multi-second clone would
    // re-enable a "Cloning…"-labelled button and Enter could fire a second onClone.
    let cloneInFlight = false;

    async function submitClone(): Promise<void> {
      const url = urlInput.value.trim();
      if (cloneInFlight || !isValidUrl()) return;
      errorEl.hidden = true;
      errorEl.textContent = '';
      cloneInFlight = true;
      cloneSubmit.disabled = true;
      cloneSubmit.textContent = 'Cloning…';
      try {
        await cb.onClone?.(url);
        // Resolved: on the happy path onClone opens the freshly-cloned folder, tearing this Home down.
        // But onClone ALSO resolves without navigating when the user dismisses the folder picker — so the
        // finally below must restore the control rather than assuming a teardown.
      } catch (err) {
        // Rejected: surface the reason inline (via textContent — never innerHTML for user/host strings)
        // and leave the form open so the user can fix the URL and retry.
        errorEl.textContent = err instanceof Error && err.message ? err.message : 'Clone failed. Check the URL and try again.';
        errorEl.hidden = false;
      } finally {
        // Restore on every non-navigating outcome (cancelled folder pick / error): the button must never
        // stay stuck on "Cloning…". On the happy path Home is already detached, so this is a harmless
        // no-op on removed nodes.
        cloneInFlight = false;
        cloneSubmit.textContent = 'Clone';
        cloneSubmit.disabled = !isValidUrl();
      }
    }

    urlInput.addEventListener('input', () => {
      if (!cloneInFlight) cloneSubmit.disabled = !isValidUrl();
    });
    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !cloneInFlight && isValidUrl()) {
        e.preventDefault();
        void submitClone();
      }
    });
    cloneSubmit.addEventListener('click', () => void submitClone());
    cloneRow.addEventListener('click', () => toggleCloneForm());

    actions.appendChild(cloneRow);
  }

  launch.appendChild(actions);

  // Recent folders — populated immediately on mount via refreshRecent(). The header (title + count
  // pill) and the free-text filter are created once here (like the gallery's search input) and persist
  // across renderRecent() rebuilds: the filter re-renders the list on every keystroke, so rebuilding
  // the input itself would tear down the element being typed into and drop keyboard focus.
  const recent = document.createElement('div');
  recent.className = 'koi-welcome-recent';

  // Header row: the "Recent" title + a live count pill (total recents). The pill text and the header's
  // count/filter visibility are updated per render; the elements themselves never rebuild.
  const recentHead = document.createElement('div');
  recentHead.className = 'koi-welcome-recent-head';

  const recentHeading = document.createElement('h2');
  recentHeading.className = 'koi-welcome-rail-title';
  recentHeading.textContent = 'Recent';

  const recentCount = document.createElement('span');
  recentCount.className = 'koi-welcome-recent-count';
  recentHead.append(recentHeading, recentCount);

  const recentFilterId = `koi-welcome-recent-filter-${Math.random().toString(36).slice(2, 8)}`;

  const recentFilterLabel = document.createElement('label');
  recentFilterLabel.className = 'koi-sr-only';
  recentFilterLabel.htmlFor = recentFilterId;
  recentFilterLabel.textContent = 'Filter recent folders';

  const recentFilter = document.createElement('input');
  recentFilter.type = 'search';
  recentFilter.id = recentFilterId;
  recentFilter.className = 'koi-welcome-recent-filter';
  recentFilter.placeholder = 'Filter recent folders…';
  recentFilter.addEventListener('input', () => {
    recentQuery = recentFilter.value;
    renderRecent();
  });

  // Only this container is rebuilt per render (rows / View-all toggle / clear-all, or the empty copy).
  // The header + filter above it are built once and always mounted — a filter keystroke re-renders the
  // rows WITHOUT tearing down the input being typed into (they hide, not detach, on an empty list).
  const recentBody = document.createElement('div');
  recentBody.className = 'koi-welcome-recent-body';

  recent.append(recentHead, recentFilterLabel, recentFilter, recentBody);
  launch.appendChild(recent);
  body.appendChild(launch);

  // --- colophon footer: version + project links + byline (issue #403) --------
  // The onboarding essentials a newcomer needs at first contact — what version am I on, where are the
  // docs, who made this — surfaced from the shared colophon (settings/about.ts shows the same content).
  // It is pinned to the bottom of the hero's left column (.koi-welcome-lede) via margin-top:auto, so the
  // lede pushes it down as its own footer; the lede owns the scroll, so a long hero never hides it.
  const colophonChip = document.createElement('span');
  colophonChip.className = 'koi-home-colophon-chip';
  colophonChip.hidden = true; // filled lazily by fillVersionChip; stays hidden until a version resolves

  function buildColophonFooter(): HTMLElement {
    const platform = getPlatform();

    const footer = document.createElement('footer');
    footer.className = 'koi-home-colophon';

    const links = document.createElement('nav');
    links.className = 'koi-home-colophon-links';
    links.setAttribute('aria-label', 'Koine project links');
    for (const link of PROJECT_LINKS) {
      const a = document.createElement('a');
      a.className = 'koi-home-colophon-link';
      a.href = link.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = link.hint;

      const icon = document.createElement('span');
      icon.className = 'koi-home-colophon-link-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = link.icon;

      a.append(icon, link.label);
      wireExternalLink(a, link.href, platform); // open in the system browser, not the webview
      links.append(a);
    }

    const credit = document.createElement('p');
    credit.className = 'koi-home-colophon-credit';
    credit.append(CREDIT_PREFIX);
    const author = document.createElement('a');
    author.className = 'koi-home-colophon-author';
    author.href = CREATOR_URL;
    author.target = '_blank';
    author.rel = 'noopener noreferrer';
    author.textContent = CREATOR_NAME;
    wireExternalLink(author, CREATOR_URL, platform);
    credit.append(author, '.');

    footer.append(colophonChip, links, credit);
    // Fill the chip on build so a slow/absent version command never blocks construction.
    fillVersionChip(colophonChip, platform);
    return footer;
  }

  // Append the colophon as the hero lede's last child — its footer, pinned to the bottom (see SCSS).
  lede.appendChild(buildColophonFooter());

  function renderRecent(): void {
    recentBody.innerHTML = '';

    const all = getRecentFolders();

    // The count pill and the header filter only make sense once there's history: keep them out of the
    // way (and out of the a11y tree) on an empty list, where the empty-state copy tells the whole
    // story. They are hidden, never detached — so a mid-typing filter keystroke never loses focus.
    const hasAny = all.length > 0;
    recentCount.textContent = hasAny ? String(all.length) : '';
    recentCount.hidden = !hasAny;
    recentFilter.hidden = !hasAny;
    recentFilterLabel.hidden = !hasAny;
    // Sync the value only when a render was triggered by something other than the input itself
    // (e.g. clear-all resetting the query) — same-value writes could still move the caret.
    if (recentFilter.value !== recentQuery) recentFilter.value = recentQuery;

    if (!hasAny) {
      const empty = document.createElement('p');
      empty.className = 'koi-welcome-empty';
      empty.textContent = 'Folders you open will show up here.';
      recentBody.appendChild(empty);
      return;
    }

    const q = recentQuery.trim().toLowerCase();
    const folders = q
      ? all.filter((r) => r.path.toLowerCase().includes(q) || basename(r.path).toLowerCase().includes(q))
      : all;

    const list = document.createElement('div');
    list.className = 'koi-welcome-recent-list';
    folders.forEach((entry, i) => {
      const row = buildRecentRow(entry);
      // Collapsed: rows past the cap stay in the DOM (so a filter-count assertion still sees them) but
      // hide behind the "View all" toggle — the SCSS overrides the row's flex display for [hidden].
      if (!recentExpanded && i >= RECENT_COLLAPSE_LIMIT) row.hidden = true;
      list.appendChild(row);
    });
    recentBody.appendChild(list);

    // View all / Show less — only when the (filtered) list is longer than the collapsed cap.
    if (folders.length > RECENT_COLLAPSE_LIMIT) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'koi-welcome-recent-toggle';
      toggle.setAttribute('aria-expanded', String(recentExpanded));
      toggle.textContent = recentExpanded ? 'Show less' : `View all ${folders.length}`;
      toggle.addEventListener('click', () => {
        recentExpanded = !recentExpanded;
        renderRecent();
      });
      recentBody.appendChild(toggle);
    }

    // Clear-all sits below the list whenever there's any history (independent of an active filter).
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'koi-welcome-recent-clear';
    clear.textContent = 'Clear recent folders';
    clear.addEventListener('click', () => {
      void koiConfirm({
        title: 'Clear recent folders?',
        message: 'This removes every folder from the Recent list. Your projects on disk are untouched.',
        confirmLabel: 'Clear',
      }).then((ok) => {
        if (!ok) return;
        clearRecentFolders();
        recentQuery = '';
        recentExpanded = false;
        renderRecent();
      });
    });
    recentBody.appendChild(clear);
  }

  /**
   * Build one dense recent row: a teal monogram tile (the folder's initial), a two-line main column —
   * the name plus an optional emit-language tag, then an optional git branch and the relative open time
   * — and the hover/focus-revealed pin, copy and remove controls (their aria-labels/behaviour unchanged
   * from the previous list). Absent branch/language fields are simply omitted.
   */
  function buildRecentRow(entry: RecentFolder): HTMLElement {
    const path = entry.path;
    const name = basename(path);

    const item = document.createElement('div');
    item.className = 'koi-welcome-recent-item';
    if (entry.pinned) item.classList.add('is-pinned');

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'koi-welcome-recent-open';
    open.title = path; // full path on hover (the row no longer prints the whole path inline)
    open.addEventListener('click', () => {
      cb.onOpenRecent(path);
    });

    // Teal monogram — the folder's initial in an accent-cyan tile; decorative (the name carries the label).
    const mono = document.createElement('span');
    mono.className = 'koi-welcome-recent-mono';
    mono.setAttribute('aria-hidden', 'true');
    mono.textContent = (name.charAt(0) || '?').toUpperCase();

    const main = document.createElement('span');
    main.className = 'koi-welcome-recent-main';

    // Line 1: the folder name + an optional emit-language tag (id mapped to its short label).
    const line = document.createElement('span');
    line.className = 'koi-welcome-recent-line';
    const nameEl = document.createElement('span');
    nameEl.className = 'koi-welcome-recent-item-name';
    nameEl.textContent = name;
    line.appendChild(nameEl);
    if (entry.language) {
      const lang = document.createElement('span');
      lang.className = 'koi-welcome-recent-lang';
      lang.textContent = langLabel(entry.language);
      line.appendChild(lang);
    }

    // Line 2: an optional git branch (teal glyph + name) then the relative open time.
    const metaLine = document.createElement('span');
    metaLine.className = 'koi-welcome-recent-meta';
    if (entry.branch) {
      const branch = document.createElement('span');
      branch.className = 'koi-welcome-recent-branch';
      branch.title = `Branch: ${entry.branch}`;
      const glyph = document.createElement('span');
      glyph.className = 'koi-welcome-recent-branch-icon';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.innerHTML = ICON_BRANCH;
      const branchName = document.createElement('span');
      branchName.className = 'koi-welcome-recent-branch-name';
      branchName.textContent = entry.branch;
      branch.append(glyph, branchName);
      metaLine.appendChild(branch);
    }
    // Relative open time — omitted when unknown: getRecentFolders coerces a missing openedAt to 0, and
    // timeAgo(0, now) would otherwise render an absurd "~20800d ago" for a pre-metadata entry.
    if (entry.openedAt > 0) {
      const time = document.createElement('span');
      time.className = 'koi-welcome-recent-time';
      time.textContent = timeAgo(entry.openedAt, Date.now());
      metaLine.appendChild(time);
    }

    main.append(line, metaLine);
    open.append(mono, main);
    item.appendChild(open);

    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'koi-welcome-recent-pin';
    pin.setAttribute('aria-pressed', String(!!entry.pinned));
    pin.setAttribute('aria-label', `${entry.pinned ? 'Unpin' : 'Pin'} ${name}`);
    pin.title = entry.pinned ? 'Unpin' : 'Pin';
    pin.textContent = '★';
    pin.addEventListener('click', () => {
      pinRecentFolder(path, !entry.pinned);
      renderRecent();
    });
    item.appendChild(pin);

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'koi-welcome-recent-copy';
    copy.setAttribute('aria-label', `Copy path of ${name}`);
    copy.title = 'Copy path';
    copy.textContent = '⧉';
    copy.addEventListener('click', () => {
      void navigator.clipboard?.writeText(path).catch(() => {});
    });
    item.appendChild(copy);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'koi-welcome-recent-remove';
    remove.setAttribute('aria-label', `Remove ${name} from recent folders`);
    remove.title = 'Remove from recent folders';
    remove.textContent = '✕';
    remove.addEventListener('click', () => {
      removeRecentFolder(path);
      renderRecent();
    });
    item.appendChild(remove);

    return item;
  }

  // --- example gallery: search + difficulty-grouped cards -------------------
  // Scales from a handful of starters to ~100 templates. The card-click opens its template.
  // Deliberately chrome-light: difficulty is carried by the section grouping and free-text search
  // already matches tags, so the gallery needs no chip walls — one search input, not thirty-odd chips.
  const uid = `koi-welcome-${Math.random().toString(36).slice(2, 8)}`;

  // Difficulties that actually occur, in canonical order — one vertical tab is drawn per level.
  const presentLevels = DIFFICULTY_ORDER.filter((d) => templates.some((t) => t.difficulty === d));

  // Live filter state — the search query plus the active level tab; any change re-renders the panel.
  const state: { query: string; level: Template['difficulty'] } = {
    query: '',
    level: presentLevels[0] ?? 'starter',
  };

  const gallery = document.createElement('section');
  gallery.className = 'koi-welcome-gallery';
  gallery.setAttribute('aria-label', 'Example templates');

  // Gallery header row: a titled lede (left) + search (right) on wide screens, stacked on narrow.
  // The lede echoes the hero's eyebrow → statement → subline rhythm so the gallery reads as the same
  // product, one step in — not a relocated strip.
  const galleryHead = document.createElement('div');
  galleryHead.className = 'koi-welcome-gallery-head';

  const galleryLede = document.createElement('div');
  galleryLede.className = 'koi-welcome-gallery-lede';

  const galleryEyebrow = document.createElement('p');
  galleryEyebrow.className = 'koi-welcome-eyebrow';
  galleryEyebrow.textContent = 'Worked examples';

  const galleryTitle = document.createElement('h2');
  galleryTitle.className = 'koi-welcome-section-title';
  galleryTitle.id = `${uid}-title`;
  galleryTitle.textContent = 'Start from an example';

  const gallerySub = document.createElement('p');
  gallerySub.className = 'koi-welcome-gallery-sub';
  const domainCount = templates.length === 1 ? '1 ready-made domain' : `${templates.length} ready-made domains`;
  gallerySub.textContent = `${domainCount} — open any one as an editable workspace.`;

  galleryLede.append(galleryEyebrow, galleryTitle, gallerySub);
  galleryHead.appendChild(galleryLede);

  // --- labelled, debounced search box ---------------------------------------
  const searchWrap = document.createElement('div');
  searchWrap.className = 'koi-welcome-search';

  const searchLabel = document.createElement('label');
  searchLabel.className = 'koi-sr-only';
  searchLabel.htmlFor = `${uid}-search`;
  searchLabel.textContent = 'Search example templates';

  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.id = `${uid}-search`;
  searchInput.className = 'koi-welcome-search-input';
  searchInput.placeholder = 'Search by name or tag…';
  searchInput.autocomplete = 'off';

  let debounce: ReturnType<typeof setTimeout> | undefined;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.query = searchInput.value;
      renderGallery();
    }, 150);
  });
  // Esc inside the search clears it (without bubbling up to dismiss the whole screen).
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && searchInput.value) {
      e.stopPropagation();
      searchInput.value = '';
      state.query = '';
      renderGallery();
    }
  });
  searchWrap.append(searchLabel, searchInput);
  galleryHead.appendChild(searchWrap);
  gallery.appendChild(galleryHead);

  // --- vertical level tabs (left) + the panel they drive (right) ------------
  // One tab per present difficulty carries the level navigation as a single quiet component (no chip
  // row), each tab showing a live count. The panel shows just the active level's cards.
  const galleryMain = document.createElement('div');
  galleryMain.className = 'koi-welcome-gallery-main';

  const tablist = document.createElement('div');
  tablist.className = 'koi-welcome-tablist';
  tablist.setAttribute('role', 'tablist');
  tablist.setAttribute('aria-orientation', 'vertical');
  tablist.setAttribute('aria-label', 'Example difficulty');

  const panel = document.createElement('div');
  panel.className = 'koi-welcome-tabpanel';
  panel.id = `${uid}-panel`;
  panel.setAttribute('role', 'tabpanel');
  panel.tabIndex = 0;

  // Per-level tab buttons; their counts are refreshed on every render.
  const tabs = new Map<Template['difficulty'], { tab: HTMLButtonElement; count: HTMLElement }>();
  const levelCounts: Partial<Record<Template['difficulty'], number>> = {};

  for (const level of presentLevels) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'koi-welcome-tab';
    tab.id = `${uid}-tab-${level}`;
    tab.dataset.level = level;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', panel.id);

    const label = document.createElement('span');
    label.className = 'koi-welcome-tab-label';
    label.textContent = level;

    const count = document.createElement('span');
    count.className = 'koi-welcome-tab-count';

    tab.append(label, count);
    tab.addEventListener('click', () => selectLevel(level));
    tablist.appendChild(tab);
    tabs.set(level, { tab, count });
  }

  // Roving-tabindex arrow-key navigation across the enabled (non-empty) tabs — the ARIA tablist pattern.
  tablist.addEventListener('keydown', (e) => {
    const enabled = presentLevels.filter((l) => (levelCounts[l] ?? 0) > 0);
    if (!enabled.length) return;
    const here = Math.max(0, enabled.indexOf(state.level));
    let next = here;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = wrapIndex(here, +1, enabled.length); // shared wrap helper
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = wrapIndex(here, -1, enabled.length); // shared wrap helper
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = enabled.length - 1;
    else return;
    e.preventDefault();
    selectLevel(enabled[next], true);
  });

  galleryMain.append(tablist, panel);
  gallery.appendChild(galleryMain);

  /** Switch the active level (ignoring empty tabs), re-render, and optionally move focus to the tab. */
  function selectLevel(level: Template['difficulty'], focus = false): void {
    if ((levelCounts[level] ?? 0) === 0) return;
    state.level = level;
    renderGallery();
    if (focus) tabs.get(level)?.tab.focus();
  }

  /** Build one template card: an icon tile with the name + tagline beside it, and an open chevron.
   *  No badges — the level lives in the tab, tags are searchable; the card stays a quiet row. */
  function makeCard(template: Template): HTMLButtonElement {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'koi-welcome-example';
    item.setAttribute('aria-label', `${template.name} — ${template.tagline}`);

    const icon = document.createElement('span');
    icon.className = 'koi-welcome-example-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = template.icon;

    const body = document.createElement('span');
    body.className = 'koi-welcome-example-body';

    const name = document.createElement('span');
    name.className = 'koi-welcome-example-name';
    name.textContent = template.name;

    const blurb = document.createElement('span');
    blurb.className = 'koi-welcome-example-blurb';
    blurb.textContent = template.tagline;

    body.append(name, blurb);

    const arrow = document.createElement('span');
    arrow.className = 'koi-welcome-example-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.innerHTML = ICON_ARROW;

    item.append(icon, body, arrow);
    item.addEventListener('click', () => {
      cb.onOpenExample(template);
    });
    return item;
  }

  /** Re-render the tab counts and the active level's panel, or a global empty state when nothing matches. */
  function renderGallery(): void {
    const matches = filterTemplates(templates, { query: state.query });

    // Refresh each tab's count and enabled/disabled state.
    for (const level of presentLevels) {
      const inLevel = matches.filter((t) => t.difficulty === level).length;
      levelCounts[level] = inLevel;
      const { tab, count } = tabs.get(level)!;
      count.textContent = String(inLevel);
      tab.classList.toggle('is-empty', inLevel === 0);
      tab.setAttribute('aria-disabled', String(inLevel === 0));
    }

    // Keep the active level valid: if a search emptied it, jump to the first level that still has matches.
    if ((levelCounts[state.level] ?? 0) === 0) {
      state.level = presentLevels.find((l) => (levelCounts[l] ?? 0) > 0) ?? state.level;
    }

    // Reflect selection (roving tabindex + aria-selected) and label the panel by the active tab.
    for (const level of presentLevels) {
      const { tab } = tabs.get(level)!;
      const selected = level === state.level;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    panel.setAttribute('aria-labelledby', `${uid}-tab-${state.level}`);

    panel.innerHTML = '';
    if (!matches.length) {
      const empty = document.createElement('p');
      empty.className = 'koi-welcome-gallery-empty';
      empty.setAttribute('role', 'status');
      empty.setAttribute('aria-live', 'polite');
      empty.textContent = 'No examples match your search.';
      panel.appendChild(empty);
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'koi-welcome-gallery-grid';
    for (const template of matches.filter((t) => t.difficulty === state.level)) {
      grid.appendChild(makeCard(template));
    }
    panel.appendChild(grid);
  }

  renderGallery();

  // --- gallery view: the example catalogue, swapped in over the console -------------------------
  // Lifting the gallery off the start screen lets the hero snippet own the first frame; the catalogue
  // then gets a full, scrollable canvas of its own, reached on demand via the "Start from an example"
  // action. It lives inside the same card as the console (only one view shows at a time), and carries
  // its own bar: a back affordance (to the console).
  const galleryView = document.createElement('div');
  galleryView.className = 'koi-welcome-view koi-gallery-view';
  galleryView.hidden = true;
  galleryView.setAttribute('role', 'region');
  galleryView.setAttribute('aria-labelledby', `${uid}-title`);

  const galleryBar = document.createElement('div');
  galleryBar.className = 'koi-welcome-bar koi-gallery-bar';

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'koi-welcome-back';
  backBtn.setAttribute('aria-label', 'Back to the start console');
  const backIcon = document.createElement('span');
  backIcon.className = 'koi-welcome-back-icon';
  backIcon.setAttribute('aria-hidden', 'true');
  backIcon.innerHTML = ICON_BACK;
  const backText = document.createElement('span');
  backText.textContent = 'Back to start';
  backBtn.append(backIcon, backText);
  backBtn.addEventListener('click', () => closeGallery());

  // The routed Home is a destination, not an overlay — there is no dismiss-✕ in the gallery bar.
  // Only the "Back to start" affordance remains (navigation lives on the toolbar).
  galleryBar.appendChild(backBtn);
  galleryView.append(galleryBar, gallery);
  card.appendChild(galleryView); // sits beside the console view in the same card; only one shows at a time

  // --- view swap: console <-> gallery ------------------------------------------------------------
  // The gallery is a second layer over the console, not a separate screen: opening it pushes its own
  // Esc handler onto the overlay stack (so Esc returns here first), closing it pops back to the console.
  let galleryOpen = false;
  let galleryUnregister: (() => void) | null = null;

  function showGallery(): void {
    if (galleryOpen) return;
    consoleView.hidden = true;
    galleryView.hidden = false;
    galleryOpen = true;
    galleryUnregister = registerOverlay(closeGallery);
    searchInput.focus(); // land in search so a newcomer can start narrowing immediately
  }

  function closeGallery(): void {
    if (!galleryOpen) return;
    galleryView.hidden = true;
    consoleView.hidden = false;
    galleryOpen = false;
    galleryUnregister?.();
    galleryUnregister = null;
    exampleAction.focus(); // return focus to the control that opened the gallery
  }

  /** Drop the gallery layer without animating focus — used when the whole welcome screen tears down. */
  function resetGallery(): void {
    galleryUnregister?.();
    galleryUnregister = null;
    galleryOpen = false;
    galleryView.hidden = true;
    consoleView.hidden = false;
  }

  // --- Home keyboard shortcuts (#1005) ----------------------------------------------------------
  // Mirror the Start-action keycaps: mod+N new model, mod+E example gallery, ⇧mod+O open folder,
  // ⇧mod+C toggle the clone form. 'mod' is ⌘ on mac / Ctrl elsewhere — like chordFromEvent we treat
  // metaKey OR ctrlKey as the primary modifier. The listener lives on `document` (so it fires wherever
  // focus sits on Home) and is removed in destroy(), so a torn-down Home leaves no live handler (#1000/#980).

  /** Whether focus is in a text-entry control, so a stray modifier never hijacks typing — the recents
   *  filter, the clone URL field and the gallery search must keep every "n"/"e"/"o"/"c" keystroke. */
  function isTextEntryFocused(): boolean {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  function onHomeKeydown(e: KeyboardEvent): void {
    if (!(e.metaKey || e.ctrlKey)) return; // needs the primary modifier (⌘ / Ctrl)
    // These are the console's shortcuts: stand down while the gallery is layered over it (it owns its
    // own keys, incl. Esc) or while the user is typing into a field, so a stray modifier never jumps.
    if (galleryOpen || isTextEntryFocused()) return;
    const key = e.key.toLowerCase();
    if (e.shiftKey) {
      if (key === 'o' && canOpenFolders) {
        e.preventDefault();
        cb.onOpenFolder();
      } else if (key === 'c' && opts.canClone) {
        e.preventDefault();
        cloneTriggerEl?.click(); // reuse the clone row's own toggle
      }
      return;
    }
    if (key === 'n') {
      e.preventDefault();
      cb.onNewModel();
    } else if (key === 'e') {
      e.preventDefault();
      showGallery();
    }
  }
  document.addEventListener('keydown', onHomeKeydown);

  // Tear the view down: detach the root AND drop the document-level keydown listener so a destroyed
  // Home leaves no live handler behind (the repo actively guards against listener leaks — #1000/#980).
  function destroy(): void {
    resetGallery();
    document.removeEventListener('keydown', onHomeKeydown);
    root.remove();
  }

  // Dead-recent recovery (#391): surface the "Remove from Recent?" confirm on this view and, on accept,
  // forget the entry then rebuild the recents list in place. The routed Home calls this when an
  // open-recent start-intent failed because the folder is gone — recovery now lives here, on Home,
  // rather than as an overlay painted over the editor. The folder is named with basename() so the
  // prompt labels it exactly as its recents row does.
  async function recover(path: string): Promise<void> {
    const forget = await koiConfirm({
      title: `"${basename(path)}" is no longer available`,
      message: 'Its folder may have moved, been deleted, or had its permission revoked. Remove it from Recent?',
      confirmLabel: 'Remove from Recent',
      danger: true,
    });
    if (forget) {
      removeRecentFolder(path);
      renderRecent(); // rebuild the list in place
    }
  }

  return {
    // Rebuild the recent list in place — so a caller that mutated the recents (e.g. after forgetting a
    // dead entry) can refresh the list without a full remount.
    refreshRecent: renderRecent,
    recover,
    root,
    destroy,
  };
}

/**
 * Mount the welcome screen as a routed, full-page Home view inside `container` — the Home half of
 * issue #368's distinct Home/Editor routes. No `document.body` overlay and no `hidden` toggle: the
 * card is shown the moment it mounts, recents rendered immediately. `destroy()` detaches it when the
 * router swaps to the editor. Pass `opts.warm` when the editor is live this session so the resume card's
 * live "ping" dot shows; the card itself self-gates on the persisted last-session snapshot (#392 / #1005).
 */
export function mountHome(
  container: HTMLElement,
  cb: WelcomeCallbacks,
  templates: readonly Template[] = TEMPLATES,
  canOpenFolders = true,
  opts: { warm?: boolean; canClone?: boolean; canResume?: boolean } = {},
): HomeHandle {
  const home = buildHome(cb, templates, canOpenFolders, {
    warm: opts.warm,
    canClone: opts.canClone,
    canResume: opts.canResume,
  });
  home.refreshRecent();
  container.appendChild(home.root);
  return { destroy: home.destroy, refreshRecent: home.refreshRecent, recover: home.recover };
}
