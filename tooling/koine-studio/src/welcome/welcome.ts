// The routed Home view for Koine Studio — mounts into a container provided by the router rather than as
// a full-cover overlay on document.body. Offers the first actions: start a new model, open a folder, or
// reopen a recent one. The hero shows the product's thesis as a live artifact — a real `.koi` snippet
// (the ubiquitous language) that Koine turns into idiomatic code — rather than describing it in prose.
// The recent list is a managed history rebuilt from getRecentFolders() on each mount; each row
// can be opened, pinned (pinned entries float to the top and survive the cap), have its path copied, or
// be removed; a search filter appears once the history grows past a threshold, a clear-all control
// forgets everything, and the list scrolls within its own container so a long history never grows the card.
import { getRecentFolders, removeRecentFolder, pinRecentFolder, clearRecentFolders } from '@/settings/persistence';
import { getPlatform } from '@/host';
import { registerOverlay, koiConfirm } from '@atypical/koine-ui';
import { PROJECT_LINKS, CREATOR_URL, CREATOR_NAME, CREDIT_PREFIX, fillVersionChip, wireExternalLink } from '@/shared/colophon';
import { TEMPLATES, type Template } from '@/welcome/templates';
import { wrapIndex } from '@/shared/wrapIndex';
import { basename } from '@/shared/path';
import { koineMark } from '@/shared/logo';
import { toggleTheme } from '@/settings/theme';

/** What the welcome actions delegate to; the host (ide.ts) performs the real work. */
export interface WelcomeCallbacks {
  onNewModel(): void;
  onOpenFolder(): void;
  onOpenRecent(path: string): void;
  /** Open one of the starter templates as a workspace. */
  onOpenExample(template: Template): void;
  /**
   * Return to the user's editor session — fired by the "Resume editing" control, rendered only when
   * there is something to resume ({@link BuildWelcomeOpts.canResume}). Unlike the start actions it sets
   * no template/folder intent; what it resolves to is the caller's concern (issues #392 / #766): a pure
   * route swap back into a still-live session, or a cold boot that restores the last workspace. Optional:
   * Optional: callers that don't offer a resume path can omit it.
   */
  onResume?(): void;
  /**
   * Open the Settings surface — fired by the top bar's gear button. Home can't render Settings itself
   * (it's an editor-hosted overlay), so the caller (main.ts) routes to the editor and shows the overlay
   * there. Optional: callers with nowhere to route settings can omit it, and the gear no-ops.
   */
  onOpenSettings?(): void;
}

/** Canonical difficulty ordering — starters first, advanced last. Drives grouping and chip order. */
export const DIFFICULTY_ORDER: Template['difficulty'][] = ['starter', 'beginner', 'intermediate', 'advanced'];

/** Recents past this count gain a free-text filter input above the list. */
const FILTER_THRESHOLD = 8;

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
/** Two sliders — the Settings gear, matching the toolbar's own Settings glyph (index.html #btn-prefs). */
const ICON_SETTINGS =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 5.5h11M2.5 10.5h11"/><circle cx="6" cy="5.5" r="1.7"/><circle cx="10" cy="10.5" r="1.7"/></svg>';

/** Build a start action as a button with an icon, a label and a one-line description. */
function makeAction(opts: {
  icon: string;
  label: string;
  desc: string;
  primary?: boolean;
  disabled?: boolean;
  /** Stable semantic hook (sets `data-action`) for tests and the routed Home's navigation wiring. */
  action?: string;
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
  btn.addEventListener('click', opts.onClick);
  return btn;
}

interface BuildWelcomeOpts {
  /**
   * There is a session or a previously-opened workspace to return to (issues #392 / #766): either the
   * IDE is already live behind the route, or a prior visit left a workspace the caller can restore. When
   * true, render a "Resume editing" control that fires {@link WelcomeCallbacks.onResume}. A pristine
   * first-load Home leaves this false, so the control stays absent and Home stays clean.
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

  // Right: the launch rail — primary actions, then recent folders.
  const launch = document.createElement('div');
  launch.className = 'koi-welcome-launch';

  // The launch rail's heading row: the "Start" title on the left and — when there is a session or a
  // previously-opened workspace to return to — the "Resume editing" control aligned on its right (issue
  // #490). The control is the purpose-built return-to-session affordance (issues #392 / #766); rendered
  // only when `canResume`, so a pristine first-load Home stays clean. On embedded Home the card's own top bar is gone, so this row
  // is the only place the control can live.
  const launchHead = document.createElement('div');
  launchHead.className = 'koi-welcome-rail-head';

  const launchTitle = document.createElement('h2');
  launchTitle.className = 'koi-welcome-rail-title';
  launchTitle.textContent = 'Start';
  launchHead.appendChild(launchTitle);

  if (opts.canResume) {
    const resumeBtn = document.createElement('button');
    resumeBtn.type = 'button';
    resumeBtn.className = 'koi-welcome-resume';
    resumeBtn.dataset.action = 'resume';
    resumeBtn.title = 'Return to your editor session';
    resumeBtn.textContent = 'Resume editing';
    resumeBtn.addEventListener('click', () => cb.onResume?.());
    launchHead.appendChild(resumeBtn);
  }

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
      onClick: () => {
        cb.onOpenFolder();
      },
    }),
  );
  launch.appendChild(actions);

  // Recent folders — populated immediately on mount via refreshRecent(). The heading and the
  // free-text filter are created once here (like the gallery's search input) and persist across
  // renderRecent() rebuilds: the filter re-renders the list on every keystroke, so rebuilding the
  // input itself would tear down the element being typed into and drop keyboard focus.
  const recent = document.createElement('div');
  recent.className = 'koi-welcome-recent';

  const recentHeading = document.createElement('h2');
  recentHeading.className = 'koi-welcome-rail-title';
  recentHeading.textContent = 'Recent';

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

  // Only this container is rebuilt per render (empty copy / rows / clear-all). The filter label +
  // input above are attached before it only while the history is long enough to warrant them.
  const recentBody = document.createElement('div');
  recentBody.className = 'koi-welcome-recent-body';

  recent.append(recentHeading, recentBody);
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

    // Past a handful of recents, show the free-text filter (name or full path). The input is the
    // persistent one built above: attach/detach it here rather than rebuilding it, and never move
    // it while it is already connected — either would drop the focus of a user mid-typing.
    const showFilter = all.length > FILTER_THRESHOLD;
    if (showFilter && !recentFilter.isConnected) {
      recent.insertBefore(recentFilterLabel, recentBody);
      recent.insertBefore(recentFilter, recentBody);
    } else if (!showFilter) {
      recentFilterLabel.remove();
      recentFilter.remove();
    }
    // Sync the value only when a render was triggered by something other than the input itself
    // (e.g. clear-all resetting the query) — same-value writes could still move the caret.
    if (recentFilter.value !== recentQuery) recentFilter.value = recentQuery;

    if (!all.length) {
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
    for (const entry of folders) {
      const path = entry.path;
      const item = document.createElement('div');
      item.className = 'koi-welcome-recent-item';
      if (entry.pinned) item.classList.add('is-pinned');

      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'koi-welcome-recent-open';
      open.title = path; // full path on hover
      const name = document.createElement('span');
      name.className = 'koi-welcome-recent-item-name';
      name.textContent = basename(path);
      const full = document.createElement('span');
      full.className = 'koi-welcome-recent-item-path';
      full.textContent = path;
      open.append(name, full);
      open.addEventListener('click', () => {
        cb.onOpenRecent(path);
      });
      item.appendChild(open);

      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'koi-welcome-recent-pin';
      pin.setAttribute('aria-pressed', String(!!entry.pinned));
      pin.setAttribute('aria-label', `${entry.pinned ? 'Unpin' : 'Pin'} ${basename(path)}`);
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
      copy.setAttribute('aria-label', `Copy path of ${basename(path)}`);
      copy.title = 'Copy path';
      copy.textContent = '⧉';
      copy.addEventListener('click', () => {
        void navigator.clipboard?.writeText(path).catch(() => {});
      });
      item.appendChild(copy);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'koi-welcome-recent-remove';
      remove.setAttribute('aria-label', `Remove ${basename(path)} from recent folders`);
      remove.title = 'Remove from recent folders';
      remove.textContent = '✕';
      remove.addEventListener('click', () => {
        removeRecentFolder(path);
        renderRecent();
      });
      item.appendChild(remove);

      list.appendChild(item);
    }
    recentBody.appendChild(list);

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
        renderRecent();
      });
    });
    recentBody.appendChild(clear);
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

  // Tear the view down: detach the root. Used by mountHome's caller (the boot router) when swapping
  // Home → Editor.
  function destroy(): void {
    resetGallery();
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
 * router swaps to the editor. Pass `opts.canResume` when there is a session or a previously-opened
 * workspace to return to, so Home offers a "Resume editing" control back into it (issues #392 / #766).
 */
export function mountHome(
  container: HTMLElement,
  cb: WelcomeCallbacks,
  templates: readonly Template[] = TEMPLATES,
  canOpenFolders = true,
  opts: { canResume?: boolean } = {},
): HomeHandle {
  const home = buildHome(cb, templates, canOpenFolders, { canResume: opts.canResume });
  home.refreshRecent();
  container.appendChild(home.root);
  return { destroy: home.destroy, refreshRecent: home.refreshRecent, recover: home.recover };
}
