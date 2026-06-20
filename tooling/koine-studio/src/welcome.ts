// Welcome / empty-state overlay for Koine Studio. Self-mounts a full-cover screen to
// document.body once (sits above #app, below modals) offering the first actions: start a
// scratch model, open a folder, or reopen a recent folder. The recent list is rebuilt from
// store.getRecentFolders() on every show() so it always reflects the latest history.
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

/**
 * Build the welcome overlay (once) and return show/hide controls. On show() the recent
 * list is rebuilt from getRecentFolders(); any action invokes its callback then hides.
 */
export function createWelcome(cb: WelcomeCallbacks, templates: readonly Template[] = TEMPLATES): WelcomeHandle {
  let shown = false;

  const root = document.createElement('div');
  root.className = 'koi-welcome';
  root.hidden = true;
  // Clicking the dimmed area outside the card returns to the editor — mirrors the modal
  // backdrop convention now that the start screen is reachable on demand (logo / palette).
  root.addEventListener('mousedown', (e) => {
    if (e.target === root) hide();
  });

  const card = document.createElement('div');
  card.className = 'koi-welcome-card';
  root.appendChild(card);

  // Dismiss back to the current editor. Invisible Esc was the only exit before; now that "home"
  // is a deliberate destination, the way back has to be visible.
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'koi-welcome-close';
  closeBtn.setAttribute('aria-label', 'Back to editor');
  closeBtn.title = 'Back to editor';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => hide());
  card.appendChild(closeBtn);

  // Logo container — the inline SVG (currentColor wordmark) themes with the surrounding text.
  const logo = document.createElement('div');
  logo.className = 'koi-welcome-logo';
  logo.innerHTML = LOGO_SVG;
  card.appendChild(logo);

  const title = document.createElement('h1');
  title.className = 'koi-welcome-title';
  title.textContent = 'Koine Studio';
  card.appendChild(title);

  const tagline = document.createElement('p');
  tagline.className = 'koi-welcome-tagline';
  tagline.textContent = 'A studio for the Koine DDD language.';
  card.appendChild(tagline);

  // Primary actions.
  const actions = document.createElement('div');
  actions.className = 'koi-welcome-actions';
  card.appendChild(actions);

  const newBtn = document.createElement('button');
  newBtn.type = 'button';
  newBtn.className = 'koi-welcome-action primary';
  newBtn.textContent = 'New model';
  newBtn.addEventListener('click', () => {
    hide();
    cb.onNewModel();
  });
  actions.appendChild(newBtn);

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'koi-welcome-action';
  openBtn.textContent = 'Open folder…';
  openBtn.addEventListener('click', () => {
    hide();
    cb.onOpenFolder();
  });
  actions.appendChild(openBtn);

  // Example gallery — a searchable, filterable, difficulty-grouped catalogue that scales from a
  // handful of starters to ~100 templates. The card-click still opens its template (preserved).
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

  const galleryTitle = document.createElement('h2');
  galleryTitle.className = 'koi-welcome-recent-title';
  galleryTitle.id = `${uid}-title`;
  galleryTitle.textContent = 'Start from an example';
  gallery.appendChild(galleryTitle);

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
  gallery.appendChild(searchWrap);

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

  // Recent folders — populated on each show().
  const recent = document.createElement('div');
  recent.className = 'koi-welcome-recent';
  card.appendChild(recent);

  function renderRecent(): void {
    recent.innerHTML = '';

    const heading = document.createElement('div');
    heading.className = 'koi-welcome-recent-title';
    heading.textContent = 'Recent folders';
    recent.appendChild(heading);

    const folders = getRecentFolders();
    if (!folders.length) {
      const empty = document.createElement('p');
      empty.className = 'koi-welcome-empty';
      empty.textContent = 'No recent folders yet.';
      recent.appendChild(empty);
      return;
    }

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
      recent.appendChild(item);
    }
  }

  // Registered with the shared overlay stack while shown, so Esc dismisses the welcome screen
  // (revealing the seeded scratch editor behind it) and layered overlays close top-first.
  let unregister: (() => void) | null = null;

  function show(): void {
    if (shown) return;
    renderRecent();
    root.hidden = false;
    shown = true;
    unregister = registerOverlay(hide);
    newBtn.focus();
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
