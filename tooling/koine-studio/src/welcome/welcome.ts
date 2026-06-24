// Welcome / start console for Koine Studio. Self-mounts a full-cover screen to document.body once
// (sits above #app, below modals) and offers the first actions: start a new model, open a folder, or
// reopen a recent one. The hero shows the product's thesis as a live artifact — a real `.koi` snippet
// (the ubiquitous language) that Koine turns into idiomatic code — rather than describing it in prose.
// The recent list is a managed history rebuilt from store.getRecentFolders() on every show(): each row
// can be opened, pinned (pinned entries float to the top and survive the cap), have its path copied, or
// be removed; a search filter appears once the history grows past a threshold, a clear-all control
// forgets everything, and the list scrolls within its own container so a long history never grows the card.
import { getRecentFolders, removeRecentFolder, pinRecentFolder, clearRecentFolders } from '@/settings/persistence';
import { LOGO_SVG } from '@/shared/logo';
import { registerOverlay, koiConfirm } from '@/shared/overlay';
import { TEMPLATES, type Template } from '@/welcome/templates';

/** What the welcome actions delegate to; the host (ide.ts) performs the real work. */
export interface WelcomeCallbacks {
  onNewModel(): void;
  onOpenFolder(): void;
  onOpenRecent(path: string): void;
  /** Open one of the starter templates as a workspace. */
  onOpenExample(template: Template): void;
}

/** Imperative handle returned by createWelcome. */
export interface WelcomeHandle {
  show(): void;
  hide(): void;
  /** Rebuild the recent-folders list in place, whether or not the welcome is already shown. */
  refreshRecent(): void;
  readonly visible: boolean;
}

/** Shorten an absolute path to its last segment for a compact recent-item label. */
function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
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
  <span class="koi-syn-kw">invariant</span> <span class="koi-syn-id">amount</span> <span class="koi-syn-punct">&gt;=</span> <span class="koi-syn-num">0</span>   <span class="koi-syn-str">"a monetary amount cannot be negative"</span>
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

/** Build a start action as a button with an icon, a label and a one-line description. */
function makeAction(opts: {
  icon: string;
  label: string;
  desc: string;
  primary?: boolean;
  disabled?: boolean;
  onClick: () => void;
}): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = opts.primary ? 'koi-welcome-action primary' : 'koi-welcome-action';
  // No explicit aria-label: the accessible name is computed from the visible label + description
  // (the icon is aria-hidden), so it always contains the on-screen text — WCAG 2.5.3 (Label in Name).
  if (opts.disabled) btn.disabled = true;

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

/**
 * Build the welcome console (once) and return show/hide controls. On show() the recent list is rebuilt
 * from getRecentFolders(); any action invokes its callback then hides.
 */
export function createWelcome(
  cb: WelcomeCallbacks,
  templates: readonly Template[] = TEMPLATES,
  canOpenFolders = true,
): WelcomeHandle {
  let shown = false;
  // Live recent-folders filter query — closure-scoped so it survives renderRecent() re-renders but
  // resets per welcome instance (two welcome handles never share a query).
  let recentQuery = '';

  const root = document.createElement('div');
  root.className = 'koi-welcome';
  root.hidden = true;
  // Clicking the dimmed area pops one layer: from the gallery back to the console, or from the console
  // out to the editor — mirroring the Esc behaviour and the modal backdrop convention.
  root.addEventListener('mousedown', (e) => {
    if (e.target !== root) return;
    if (galleryOpen) closeGallery();
    else hide();
  });

  const card = document.createElement('div');
  card.className = 'koi-welcome-card';
  root.appendChild(card);

  // --- top bar: wordmark (left) + dismiss (right) ---------------------------
  const bar = document.createElement('div');
  bar.className = 'koi-welcome-bar';
  card.appendChild(bar);

  const brand = document.createElement('div');
  brand.className = 'koi-welcome-brand';
  const logo = document.createElement('span');
  logo.className = 'koi-welcome-logo';
  logo.setAttribute('aria-hidden', 'true');
  logo.innerHTML = LOGO_SVG; // inline SVG (currentColor wordmark) themes with the surrounding text
  const wordmark = document.createElement('span');
  wordmark.className = 'koi-welcome-wordmark';
  const wordName = document.createElement('span');
  wordName.className = 'koi-welcome-wordmark-name';
  wordName.textContent = 'Koine';
  const wordKicker = document.createElement('span');
  wordKicker.className = 'koi-welcome-wordmark-kicker';
  wordKicker.textContent = 'Studio';
  wordmark.append(wordName, wordKicker);
  brand.append(logo, wordmark);
  bar.appendChild(brand);

  // Visible way back to the editor (Esc was the only exit before, which is invisible now that the
  // screen is a deliberate destination).
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'koi-welcome-close';
  closeBtn.setAttribute('aria-label', 'Back to editor');
  closeBtn.title = 'Back to editor';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => hide());
  bar.appendChild(closeBtn);

  // --- hero: the thesis (left) + get-to-work rail (right) -------------------
  const hero = document.createElement('section');
  hero.className = 'koi-welcome-hero';
  card.appendChild(hero);

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
  const emitDot = document.createElement('span');
  emitDot.className = 'koi-welcome-emit-dot';
  emitDot.setAttribute('aria-hidden', 'true');
  const emitText = document.createElement('span');
  emitText.textContent = 'Emits idiomatic C# — value object, guards, equality.';
  emit.append(emitDot, emitText);

  figure.append(snipBar, pre, emit);
  lede.append(eyebrow, statement, figure);
  hero.appendChild(lede);

  // Right: the launch rail — primary actions, then recent folders.
  const launch = document.createElement('div');
  launch.className = 'koi-welcome-launch';

  const launchTitle = document.createElement('h2');
  launchTitle.className = 'koi-welcome-rail-title';
  launchTitle.textContent = 'Start';
  launch.appendChild(launchTitle);

  const actions = document.createElement('div');
  actions.className = 'koi-welcome-actions';
  actions.appendChild(
    makeAction({
      icon: ICON_NEW,
      label: 'New model',
      desc: 'Begin with an empty context',
      primary: true,
      onClick: () => {
        hide();
        cb.onNewModel();
      },
    }),
  );
  // Opens the example gallery as a second view layered over this console (it does not leave the
  // welcome screen, so it doesn't call hide()). Kept as a handle so focus can return here on close.
  const exampleAction = makeAction({
    icon: ICON_GALLERY,
    label: 'Start from an example',
    desc: 'Open a ready-made domain',
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
      onClick: () => {
        hide();
        cb.onOpenFolder();
      },
    }),
  );
  launch.appendChild(actions);

  // Recent folders — populated on each show().
  const recent = document.createElement('div');
  recent.className = 'koi-welcome-recent';
  launch.appendChild(recent);
  hero.appendChild(launch);

  function renderRecent(): void {
    recent.innerHTML = '';

    const heading = document.createElement('h2');
    heading.className = 'koi-welcome-rail-title';
    heading.textContent = 'Recent';
    recent.appendChild(heading);

    const all = getRecentFolders();
    if (!all.length) {
      const empty = document.createElement('p');
      empty.className = 'koi-welcome-empty';
      empty.textContent = 'Folders you open will show up here.';
      recent.appendChild(empty);
      return;
    }

    // Past a handful of recents, offer a free-text filter (name or full path). The query is
    // closure-scoped so it persists across the input-driven re-renders.
    if (all.length > FILTER_THRESHOLD) {
      const filterId = `koi-welcome-recent-filter-${Math.random().toString(36).slice(2, 8)}`;

      const filterLabel = document.createElement('label');
      filterLabel.className = 'koi-sr-only';
      filterLabel.htmlFor = filterId;
      filterLabel.textContent = 'Filter recent folders';

      const filter = document.createElement('input');
      filter.type = 'search';
      filter.id = filterId;
      filter.className = 'koi-welcome-recent-filter';
      filter.placeholder = 'Filter recent folders…';
      filter.value = recentQuery;
      filter.addEventListener('input', () => {
        recentQuery = filter.value;
        renderRecent();
      });
      recent.appendChild(filterLabel);
      recent.appendChild(filter);
    }

    const q = recentQuery.trim().toLowerCase();
    const folders = q
      ? all.filter((r) => r.path.toLowerCase().includes(q) || baseName(r.path).toLowerCase().includes(q))
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
      name.textContent = baseName(path);
      const full = document.createElement('span');
      full.className = 'koi-welcome-recent-item-path';
      full.textContent = path;
      open.append(name, full);
      open.addEventListener('click', () => {
        hide();
        cb.onOpenRecent(path);
      });
      item.appendChild(open);

      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'koi-welcome-recent-pin';
      pin.setAttribute('aria-pressed', String(!!entry.pinned));
      pin.setAttribute('aria-label', `${entry.pinned ? 'Unpin' : 'Pin'} ${baseName(path)}`);
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
      copy.setAttribute('aria-label', `Copy path of ${baseName(path)}`);
      copy.title = 'Copy path';
      copy.textContent = '⧉';
      copy.addEventListener('click', () => {
        void navigator.clipboard?.writeText(path).catch(() => {});
      });
      item.appendChild(copy);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'koi-welcome-recent-remove';
      remove.setAttribute('aria-label', `Remove ${baseName(path)} from recent folders`);
      remove.title = 'Remove from recent folders';
      remove.textContent = '✕';
      remove.addEventListener('click', () => {
        removeRecentFolder(path);
        renderRecent();
      });
      item.appendChild(remove);

      list.appendChild(item);
    }
    recent.appendChild(list);

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
    recent.appendChild(clear);
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
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (here + 1) % enabled.length;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (here - 1 + enabled.length) % enabled.length;
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
      hide();
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

  // --- gallery view: the example catalogue as its own card, swapped in over the console ----------
  // Lifting the gallery off the start screen lets the hero snippet own the first frame; the catalogue
  // then gets a full, scrollable canvas of its own, reached on demand via the "Start from an example"
  // action. Its own bar carries a back affordance (to the console) and the same dismiss (to the editor).
  const galleryCard = document.createElement('div');
  galleryCard.className = 'koi-welcome-card koi-gallery-card';
  galleryCard.hidden = true;
  galleryCard.setAttribute('role', 'region');
  galleryCard.setAttribute('aria-labelledby', `${uid}-title`);

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

  const galleryClose = document.createElement('button');
  galleryClose.type = 'button';
  galleryClose.className = 'koi-welcome-close';
  galleryClose.setAttribute('aria-label', 'Back to editor');
  galleryClose.title = 'Back to editor';
  galleryClose.textContent = '✕';
  galleryClose.addEventListener('click', () => hide());

  galleryBar.append(backBtn, galleryClose);
  galleryCard.append(galleryBar, gallery);
  root.appendChild(galleryCard); // sits beside `card`; only one of the two is visible at a time

  // Registered with the shared overlay stack while shown, so Esc dismisses the welcome screen
  // (revealing the seeded editor behind it) and layered overlays close top-first.
  let unregister: (() => void) | null = null;

  // --- view swap: console <-> gallery ------------------------------------------------------------
  // The gallery is a second layer over the console, not a separate screen: opening it pushes its own
  // Esc handler onto the overlay stack (so Esc returns here first), closing it pops back to the console.
  let galleryOpen = false;
  let galleryUnregister: (() => void) | null = null;

  function showGallery(): void {
    if (galleryOpen) return;
    card.hidden = true;
    galleryCard.hidden = false;
    galleryOpen = true;
    galleryUnregister = registerOverlay(closeGallery);
    searchInput.focus(); // land in search so a newcomer can start narrowing immediately
  }

  function closeGallery(): void {
    if (!galleryOpen) return;
    galleryCard.hidden = true;
    card.hidden = false;
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
    galleryCard.hidden = true;
    card.hidden = false;
  }

  function show(): void {
    if (shown) return;
    resetGallery(); // always open on the console, even if the gallery was last on screen
    renderRecent();
    root.hidden = false;
    shown = true;
    unregister = registerOverlay(hide);
    // Focus the start console so Esc/Tab land here, but don't yank focus to a control — the snippet is
    // the first thing to read. The console is programmatically focusable via tabindex in the SCSS-less
    // DOM; fall back to the New action if the host expects an immediate control focus.
    (card.querySelector<HTMLElement>('.koi-welcome-action.primary') ?? card).focus();
  }

  function hide(): void {
    if (!shown) return;
    resetGallery();
    root.hidden = true;
    shown = false;
    unregister?.();
    unregister = null;
  }

  document.body.appendChild(root);

  return {
    show,
    hide,
    // Rebuild the recent list in place. Unlike show(), this runs even when already shown — so a caller
    // that mutated the recents (e.g. after forgetting a dead entry) can refresh the list without the
    // `if (shown) return` early-out swallowing the re-render.
    refreshRecent: renderRecent,
    get visible() {
      return shown;
    },
  };
}
