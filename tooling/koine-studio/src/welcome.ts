// Welcome / start console for Koine Studio. Self-mounts a full-cover screen to document.body once
// (sits above #app, below modals) and offers the first actions: start a new model, open a folder, or
// reopen a recent one. The hero shows the product's thesis as a live artifact — a real `.koi` snippet
// (the ubiquitous language) that Koine turns into idiomatic code — rather than describing it in prose.
// The recent list is rebuilt from store.getRecentFolders() on every show() so it always reflects the
// latest history.
import { getRecentFolders } from './store';
import { LOGO_SVG } from './logo';
import { registerOverlay } from './overlay';
import { TEMPLATES, type Template } from './templates';

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
  readonly visible: boolean;
}

/** Shorten an absolute path to its last segment for a compact recent-item label. */
function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Canonical difficulty ordering — starters first, advanced last. Drives grouping and chip order. */
export const DIFFICULTY_ORDER: Template['difficulty'][] = ['starter', 'beginner', 'intermediate', 'advanced'];

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

/** The union of every tag across the templates, in first-seen order — backs the tag filter chips. */
function collectTags(templates: readonly Template[]): string[] {
  const seen = new Set<string>();
  for (const t of templates) {
    for (const tag of t.tags) seen.add(tag);
  }
  return [...seen];
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

/** Build a start action as a button with an icon, a label and a one-line description. */
function makeAction(opts: {
  icon: string;
  label: string;
  desc: string;
  primary?: boolean;
  onClick: () => void;
}): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = opts.primary ? 'koi-welcome-action primary' : 'koi-welcome-action';
  btn.setAttribute('aria-label', opts.label);

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
export function createWelcome(cb: WelcomeCallbacks, templates: readonly Template[] = TEMPLATES): WelcomeHandle {
  let shown = false;

  const root = document.createElement('div');
  root.className = 'koi-welcome';
  root.hidden = true;
  // Clicking the dimmed area outside the console returns to the editor — mirrors the modal backdrop
  // convention now that the start screen is reachable on demand (logo / palette).
  root.addEventListener('mousedown', (e) => {
    if (e.target === root) hide();
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
  actions.appendChild(
    makeAction({
      icon: ICON_OPEN,
      label: 'Open folder…',
      desc: 'Work on an existing workspace',
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

    const folders = getRecentFolders();
    if (!folders.length) {
      const empty = document.createElement('p');
      empty.className = 'koi-welcome-empty';
      empty.textContent = 'Folders you open will show up here.';
      recent.appendChild(empty);
      return;
    }

    const list = document.createElement('div');
    list.className = 'koi-welcome-recent-list';
    for (const path of folders) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'koi-welcome-recent-item';
      item.title = path; // full path on hover

      const name = document.createElement('span');
      name.className = 'koi-welcome-recent-item-name';
      name.textContent = baseName(path);
      item.appendChild(name);

      const full = document.createElement('span');
      full.className = 'koi-welcome-recent-item-path';
      full.textContent = path;
      item.appendChild(full);

      item.addEventListener('click', () => {
        hide();
        cb.onOpenRecent(path);
      });
      list.appendChild(item);
    }
    recent.appendChild(list);
  }

  // --- example gallery: searchable, filterable, difficulty-grouped ----------
  // Scales from a handful of starters to ~100 templates. The card-click opens its template.
  const uid = `koi-welcome-${Math.random().toString(36).slice(2, 8)}`;
  const allTags = collectTags(templates);

  // Live filter state; any change re-renders the grid via renderGallery().
  const state: { query: string; tag: string | null; difficulty: Template['difficulty'] | null } = {
    query: '',
    tag: null,
    difficulty: null,
  };

  const gallery = document.createElement('section');
  gallery.className = 'koi-welcome-gallery';
  gallery.setAttribute('aria-label', 'Example templates');

  // Gallery header row: title (left) + search (right) on wide screens, stacked on narrow.
  const galleryHead = document.createElement('div');
  galleryHead.className = 'koi-welcome-gallery-head';

  const galleryTitle = document.createElement('h2');
  galleryTitle.className = 'koi-welcome-section-title';
  galleryTitle.id = `${uid}-title`;
  galleryTitle.textContent = 'Start from an example';
  galleryHead.appendChild(galleryTitle);

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
  searchInput.placeholder = 'Search examples…';
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

  // --- filter chips: difficulty, then the union of tags ---------------------
  function makeChip(kind: 'difficulty' | 'tag', value: string, label: string): HTMLButtonElement {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'koi-welcome-chip';
    chip.dataset.kind = kind;
    chip.dataset.value = value;
    chip.textContent = label;
    chip.setAttribute('aria-pressed', 'false');
    chip.addEventListener('click', () => {
      if (kind === 'difficulty') {
        state.difficulty = state.difficulty === (value as Template['difficulty']) ? null : (value as Template['difficulty']);
      } else {
        state.tag = state.tag === value ? null : value;
      }
      renderGallery();
    });
    return chip;
  }

  const filterBar = document.createElement('div');
  filterBar.className = 'koi-welcome-filters';
  filterBar.setAttribute('role', 'group');
  filterBar.setAttribute('aria-label', 'Filter examples');

  // Only offer difficulty chips that actually occur, in canonical order.
  const presentDifficulties = DIFFICULTY_ORDER.filter((d) => templates.some((t) => t.difficulty === d));
  if (presentDifficulties.length) {
    const diffRow = document.createElement('div');
    diffRow.className = 'koi-welcome-chip-row';
    const diffLabel = document.createElement('span');
    diffLabel.className = 'koi-welcome-chip-label';
    diffLabel.textContent = 'Level';
    diffRow.appendChild(diffLabel);
    for (const d of presentDifficulties) diffRow.appendChild(makeChip('difficulty', d, d));
    filterBar.appendChild(diffRow);
  }

  if (allTags.length) {
    const tagRow = document.createElement('div');
    tagRow.className = 'koi-welcome-chip-row';
    const tagLabel = document.createElement('span');
    tagLabel.className = 'koi-welcome-chip-label';
    tagLabel.textContent = 'Tags';
    tagRow.appendChild(tagLabel);
    for (const tag of allTags) tagRow.appendChild(makeChip('tag', tag, tag));
    filterBar.appendChild(tagRow);
  }
  gallery.appendChild(filterBar);

  // --- the grid the filters drive -------------------------------------------
  const galleryBody = document.createElement('div');
  galleryBody.className = 'koi-welcome-gallery-body';
  gallery.appendChild(galleryBody);

  /** Build one template card as a focusable <button> with icon, name, tagline and badges. */
  function makeCard(template: Template): HTMLButtonElement {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'koi-welcome-example';
    item.setAttribute('aria-label', `${template.name} — ${template.tagline}`);

    const head = document.createElement('span');
    head.className = 'koi-welcome-example-head';

    const icon = document.createElement('span');
    icon.className = 'koi-welcome-example-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = template.icon;

    const name = document.createElement('span');
    name.className = 'koi-welcome-example-name';
    name.textContent = template.name;
    head.append(icon, name);

    const blurb = document.createElement('span');
    blurb.className = 'koi-welcome-example-blurb';
    blurb.textContent = template.tagline;

    const badges = document.createElement('span');
    badges.className = 'koi-welcome-badges';
    const diffBadge = document.createElement('span');
    diffBadge.className = `koi-welcome-badge koi-welcome-badge--diff koi-welcome-badge--${template.difficulty}`;
    diffBadge.textContent = template.difficulty;
    badges.appendChild(diffBadge);
    for (const tag of template.tags.slice(0, 3)) {
      const tagBadge = document.createElement('span');
      tagBadge.className = 'koi-welcome-badge koi-welcome-badge--tag';
      tagBadge.textContent = tag;
      badges.appendChild(tagBadge);
    }

    item.append(head, blurb, badges);
    item.addEventListener('click', () => {
      hide();
      cb.onOpenExample(template);
    });
    return item;
  }

  /** Re-render the grouped grid for the current filter state, or an empty state when nothing matches. */
  function renderGallery(): void {
    galleryBody.innerHTML = '';

    // Reflect active filters onto the chips.
    for (const chip of filterBar.querySelectorAll<HTMLButtonElement>('.koi-welcome-chip')) {
      const active =
        (chip.dataset.kind === 'difficulty' && chip.dataset.value === state.difficulty) ||
        (chip.dataset.kind === 'tag' && chip.dataset.value === state.tag);
      chip.setAttribute('aria-pressed', String(Boolean(active)));
    }

    const matches = filterTemplates(templates, {
      query: state.query,
      tag: state.tag ?? undefined,
      difficulty: state.difficulty ?? undefined,
    });

    if (!matches.length) {
      const empty = document.createElement('p');
      empty.className = 'koi-welcome-gallery-empty';
      empty.setAttribute('role', 'status');
      empty.setAttribute('aria-live', 'polite');
      empty.textContent = 'No examples match your search and filters.';
      galleryBody.appendChild(empty);
      return;
    }

    // Group by difficulty, starters first; only render groups that have matches.
    for (const difficulty of DIFFICULTY_ORDER) {
      const inGroup = matches.filter((t) => t.difficulty === difficulty);
      if (!inGroup.length) continue;

      const group = document.createElement('div');
      group.className = 'koi-welcome-group';

      const heading = document.createElement('h3');
      heading.className = 'koi-welcome-group-title';
      heading.textContent = difficulty;
      group.appendChild(heading);

      const grid = document.createElement('div');
      grid.className = 'koi-welcome-gallery-grid';
      for (const template of inGroup) grid.appendChild(makeCard(template));
      group.appendChild(grid);

      galleryBody.appendChild(group);
    }
  }

  renderGallery();
  card.appendChild(gallery);

  // Registered with the shared overlay stack while shown, so Esc dismisses the welcome screen
  // (revealing the seeded editor behind it) and layered overlays close top-first.
  let unregister: (() => void) | null = null;

  function show(): void {
    if (shown) return;
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
    root.hidden = true;
    shown = false;
    unregister?.();
    unregister = null;
  }

  document.body.appendChild(root);

  return {
    show,
    hide,
    get visible() {
      return shown;
    },
  };
}
