import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest';
import { mountHome, filterTemplates, DIFFICULTY_ORDER, type WelcomeCallbacks } from '@/welcome/welcome';
import type { Template } from '@/welcome/templates';
import { MOD } from '@/shared/platform';

// Each test mounts a fresh welcome root into a container appended to document.body; the global
// afterEach wipes the body so roots/handlers don't leak across cases.
afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

/** A minimal Template factory — only the fields the gallery reads need realistic values. */
function tpl(over: Partial<Template> & Pick<Template, 'id' | 'name' | 'difficulty'>): Template {
  return {
    tagline: '',
    description: '',
    tags: [],
    contexts: [],
    coreAggregate: 'Root',
    entryFile: `${over.id}.koi`,
    teaches: [],
    icon: '📦',
    source: '',
    ...over,
  } as Template;
}

// A small spread across difficulties and tags so grouping + filtering have something to chew on.
const SAMPLE: Template[] = [
  tpl({ id: 'billing', name: 'Billing', tagline: 'Money and orders', difficulty: 'starter', tags: ['money', 'orders'] }),
  tpl({ id: 'ordering', name: 'Ordering', tagline: 'A state machine', difficulty: 'starter', tags: ['state-machine'] }),
  tpl({ id: 'library', name: 'Library', tagline: 'Loans and fines', difficulty: 'intermediate', tags: ['state-machine', 'ddd'] }),
  tpl({ id: 'saas', name: 'SaaS Subscription', tagline: 'Multi-tenant metering', difficulty: 'advanced', tags: ['saas', 'ddd'] }),
];

function makeCallbacks(): WelcomeCallbacks {
  return {
    onNewModel: vi.fn(),
    onOpenFolder: vi.fn(),
    onOpenRecent: vi.fn(),
    onOpenExample: vi.fn(),
  };
}

function cardNames(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>('.koi-welcome-example .koi-welcome-example-name')).map(
    (n) => n.textContent ?? '',
  );
}

/** The level tab whose data-level matches. */
function tabFor(root: HTMLElement, level: string): HTMLButtonElement {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('.koi-welcome-tab')).find((t) => t.dataset.level === level)!;
}

/** The live count shown on a level tab. */
function tabCount(root: HTMLElement, level: string): string | null | undefined {
  return tabFor(root, level).querySelector('.koi-welcome-tab-count')?.textContent;
}

describe('filterTemplates (pure)', () => {
  test('no filters returns every template', () => {
    expect(filterTemplates(SAMPLE, {}).map((t) => t.id)).toEqual(['billing', 'ordering', 'library', 'saas']);
  });

  test('matches search text against name, tagline and tags (case-insensitive)', () => {
    expect(filterTemplates(SAMPLE, { query: 'BILL' }).map((t) => t.id)).toEqual(['billing']); // name
    expect(filterTemplates(SAMPLE, { query: 'metering' }).map((t) => t.id)).toEqual(['saas']); // tagline
    expect(filterTemplates(SAMPLE, { query: 'state-machine' }).map((t) => t.id)).toEqual(['ordering', 'library']); // tag
  });

  test('filters by a selected tag', () => {
    expect(filterTemplates(SAMPLE, { tag: 'ddd' }).map((t) => t.id)).toEqual(['library', 'saas']);
  });

  test('filters by a selected difficulty', () => {
    expect(filterTemplates(SAMPLE, { difficulty: 'starter' }).map((t) => t.id)).toEqual(['billing', 'ordering']);
  });

  test('combines search + tag + difficulty (AND)', () => {
    expect(filterTemplates(SAMPLE, { query: 'state', tag: 'ddd', difficulty: 'intermediate' }).map((t) => t.id)).toEqual([
      'library',
    ]);
  });

  test('returns nothing when nothing matches', () => {
    expect(filterTemplates(SAMPLE, { query: 'zzz-nothing' })).toEqual([]);
  });
});

describe('DIFFICULTY_ORDER', () => {
  test('orders starters first, advanced last', () => {
    expect(DIFFICULTY_ORDER).toEqual(['starter', 'beginner', 'intermediate', 'advanced']);
  });
});

describe('welcome gallery', () => {
  let container: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  test("renders the active level's cards and opens a template on click", () => {
    const cb = makeCallbacks();
    mountHome(container, cb, SAMPLE);
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;

    // The first present level (Starter) is active by default; only its cards are in the panel.
    expect(cardNames(root).sort()).toEqual(['Billing', 'Ordering']);

    const billing = Array.from(root.querySelectorAll<HTMLElement>('.koi-welcome-example')).find(
      (b) => b.querySelector('.koi-welcome-example-name')?.textContent === 'Billing',
    )!;
    billing.click();
    expect((cb.onOpenExample as ReturnType<typeof vi.fn>).mock.calls[0][0].id).toBe('billing');
  });

  test('the title sits beside the icon, with a tagline and an open chevron — no badges', () => {
    const cb = makeCallbacks();
    mountHome(container, cb, SAMPLE);
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;

    const billing = Array.from(root.querySelectorAll<HTMLButtonElement>('button.koi-welcome-example')).find(
      (b) => b.querySelector('.koi-welcome-example-name')?.textContent === 'Billing',
    )!;
    expect(billing.tagName).toBe('BUTTON');
    expect(billing.getAttribute('aria-label')).toContain('Billing');
    expect(billing.getAttribute('aria-label')).toContain('Money and orders');
    // Icon, then the body (name + tagline), then the chevron — the title is beside the icon.
    expect(Array.from(billing.children).map((c) => c.className)).toEqual([
      'koi-welcome-example-icon',
      'koi-welcome-example-body',
      'koi-welcome-example-arrow',
    ]);
    expect(billing.querySelector('.koi-welcome-example-body .koi-welcome-example-name')?.textContent).toBe('Billing');
    expect(billing.querySelector('.koi-welcome-example-blurb')?.textContent).toBe('Money and orders');
    expect(billing.querySelector('.koi-welcome-badge')).toBeNull();
  });

  test('draws a vertical tab per present level, each with a live count', () => {
    const cb = makeCallbacks();
    mountHome(container, cb, SAMPLE);
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;

    const list = root.querySelector('.koi-welcome-tablist')!;
    expect(list.getAttribute('role')).toBe('tablist');
    expect(list.getAttribute('aria-orientation')).toBe('vertical');

    const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>('.koi-welcome-tab'));
    expect(tabs.map((t) => t.dataset.level)).toEqual(['starter', 'intermediate', 'advanced']);
    expect(tabs.every((t) => t.getAttribute('role') === 'tab')).toBe(true);
    expect(tabs.map((t) => t.querySelector('.koi-welcome-tab-count')?.textContent)).toEqual(['2', '1', '1']);
    expect(tabFor(root, 'starter').getAttribute('aria-selected')).toBe('true');
  });

  test('selecting a level tab swaps the panel to that level', () => {
    const cb = makeCallbacks();
    mountHome(container, cb, SAMPLE);
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;

    tabFor(root, 'intermediate').click();
    expect(cardNames(root)).toEqual(['Library']);
    expect(tabFor(root, 'intermediate').getAttribute('aria-selected')).toBe('true');
    expect(tabFor(root, 'starter').getAttribute('aria-selected')).toBe('false');

    tabFor(root, 'advanced').click();
    expect(cardNames(root)).toEqual(['SaaS Subscription']);
  });

  test('exposes no filter chips — search + level tabs are the only controls', () => {
    const cb = makeCallbacks();
    mountHome(container, cb, SAMPLE);
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;
    expect(root.querySelector('.koi-welcome-chip')).toBeNull();
    expect(root.querySelector('.koi-welcome-filters')).toBeNull();
    expect(root.querySelector('input[type="search"]')).not.toBeNull();
  });

  test('search narrows the active level and updates the tab counts (matching tags too)', () => {
    const cb = makeCallbacks();
    mountHome(container, cb, SAMPLE);
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;

    setSearch(root, 'state-machine'); // a tag: ordering (starter) + library (intermediate)
    expect(cardNames(root)).toEqual(['Ordering']); // active level stays Starter
    expect(tabCount(root, 'starter')).toBe('1');
    expect(tabCount(root, 'intermediate')).toBe('1');
    expect(tabCount(root, 'advanced')).toBe('0');
  });

  test('when a search empties the active level, the panel jumps to the first level with matches', () => {
    const cb = makeCallbacks();
    mountHome(container, cb, SAMPLE);
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;

    setSearch(root, 'ddd'); // a tag on library (intermediate) + saas (advanced); no starter match
    expect(tabCount(root, 'starter')).toBe('0');
    expect(tabFor(root, 'starter').classList.contains('is-empty')).toBe(true);
    expect(tabFor(root, 'intermediate').getAttribute('aria-selected')).toBe('true');
    expect(cardNames(root)).toEqual(['Library']);
  });

  test('shows an empty-state message when nothing matches', () => {
    const cb = makeCallbacks();
    mountHome(container, cb, SAMPLE);
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;

    setSearch(root, 'zzz-nothing-matches');
    expect(cardNames(root)).toEqual([]);
    const empty = root.querySelector<HTMLElement>('.koi-welcome-gallery-empty');
    expect(empty).not.toBeNull();
    expect(empty!.textContent?.toLowerCase()).toContain('no');
    // Empty state is announced for assistive tech.
    expect(empty!.getAttribute('aria-live')).toBe('polite');
  });
});

describe('welcome start actions ↔ gallery', () => {
  let container: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  /** The start action whose label matches `label`, e.g. "Start from an example". */
  function action(root: HTMLElement, label: string): HTMLButtonElement {
    return Array.from(root.querySelectorAll<HTMLButtonElement>('button.koi-welcome-action')).find(
      (b) => b.querySelector('.koi-welcome-action-label')?.textContent === label,
    )!;
  }

  const consoleView = (root: HTMLElement) => root.querySelector<HTMLElement>('.koi-welcome-view:not(.koi-gallery-view)')!;
  const galleryView = (root: HTMLElement) => root.querySelector<HTMLElement>('.koi-gallery-view')!;

  test('opens on the console with the gallery hidden behind a "Start from an example" action', () => {
    const cb = makeCallbacks();
    mountHome(container, cb, SAMPLE);
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;

    expect(consoleView(root).hidden).toBe(false);
    expect(galleryView(root).hidden).toBe(true);
    expect(action(root, 'Start from an example')).toBeTruthy();
  });

  test('both views live inside the one card, swapped in place (no second card)', () => {
    const cb = makeCallbacks();
    mountHome(container, cb, SAMPLE);
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;

    // A single persistent card frame holds both views — the modal never tears down on a view switch.
    expect(root.querySelectorAll('.koi-welcome-card').length).toBe(1);
    const card = root.querySelector<HTMLElement>('.koi-welcome-card')!;
    expect(card.contains(consoleView(root))).toBe(true);
    expect(card.contains(galleryView(root))).toBe(true);
  });

  test('the action swaps in the gallery; "Back to start" swaps back', () => {
    const cb = makeCallbacks();
    mountHome(container, cb, SAMPLE);
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;

    action(root, 'Start from an example').click();
    expect(consoleView(root).hidden).toBe(true);
    expect(galleryView(root).hidden).toBe(false);

    root.querySelector<HTMLButtonElement>('.koi-welcome-back')!.click();
    expect(consoleView(root).hidden).toBe(false);
    expect(galleryView(root).hidden).toBe(true);
  });

  test('opening the gallery does not leave the welcome screen (no callback, still visible)', () => {
    const cb = makeCallbacks();
    mountHome(container, cb, SAMPLE);
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;

    action(root, 'Start from an example').click();
    // No navigation callback fired — the gallery is a sub-view of the same surface.
    expect(cb.onNewModel).not.toHaveBeenCalled();
    expect(cb.onOpenFolder).not.toHaveBeenCalled();
  });
});

const KEY = 'koine.studio.recentFolders';

describe('welcome recent rows', () => {
  let container: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  test('renders one row per recent with open/remove/pin controls', () => {
    localStorage.setItem(KEY, JSON.stringify(['/a/one', '/b/two']));
    mountHome(container, makeCallbacks());
    expect(document.querySelectorAll('.koi-welcome-recent-item').length).toBe(2);
    expect(document.querySelector('.koi-welcome-recent-remove')).not.toBeNull();
    expect(document.querySelector('.koi-welcome-recent-pin')).not.toBeNull();
  });

  test('open control invokes onOpenRecent with the path', () => {
    localStorage.setItem(KEY, JSON.stringify(['/a/one']));
    const cb = makeCallbacks();
    mountHome(container, cb);
    (document.querySelector('.koi-welcome-recent-open') as HTMLElement).click();
    expect(cb.onOpenRecent).toHaveBeenCalledWith('/a/one');
  });

  test('remove deletes the row and updates storage', () => {
    localStorage.setItem(KEY, JSON.stringify(['/a/one', '/b/two']));
    mountHome(container, makeCallbacks());
    (document.querySelector('.koi-welcome-recent-remove') as HTMLElement).click();
    expect(document.querySelectorAll('.koi-welcome-recent-item').length).toBe(1);
    expect(JSON.parse(localStorage.getItem(KEY)!).length).toBe(1);
  });

  test('keeps recent rows inside the scroll list wrapper', () => {
    localStorage.setItem(KEY, JSON.stringify(['/a', '/b']));
    mountHome(container, makeCallbacks());
    const list = document.querySelector('.koi-welcome-recent-list');
    expect(list).not.toBeNull();
    expect(list!.querySelectorAll('.koi-welcome-recent-item').length).toBe(2);
  });
});

describe('welcome recent management', () => {
  let container: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('the header filter narrows the list by text (#1005: always available)', () => {
    const many = Array.from({ length: 10 }, (_, i) => `/proj/folder-${i}`);
    localStorage.setItem(KEY, JSON.stringify(many));
    mountHome(container, makeCallbacks());
    const filter = document.querySelector('.koi-welcome-recent-filter') as HTMLInputElement;
    expect(filter).not.toBeNull();
    filter.value = 'folder-3';
    filter.dispatchEvent(new Event('input'));
    expect(document.querySelectorAll('.koi-welcome-recent-item').length).toBe(1);
  });

  test('the filter input survives its own re-render and keeps keyboard focus while typing', () => {
    const many = Array.from({ length: 10 }, (_, i) => `/proj/folder-${i}`);
    localStorage.setItem(KEY, JSON.stringify(many));
    mountHome(container, makeCallbacks());
    const filter = document.querySelector('.koi-welcome-recent-filter') as HTMLInputElement;
    filter.focus();

    // First keystroke: the list re-renders, but the element the user is typing into must persist —
    // rebuilding it would drop focus to <body> and swallow every subsequent keystroke.
    filter.value = 'folder-3';
    filter.dispatchEvent(new Event('input'));
    expect(document.querySelector('.koi-welcome-recent-filter')).toBe(filter);
    expect(document.activeElement).toBe(filter);

    // A follow-up keystroke therefore still lands in the same input and keeps filtering.
    filter.value = 'folder';
    filter.dispatchEvent(new Event('input'));
    expect(document.activeElement).toBe(filter);
    expect(document.querySelectorAll('.koi-welcome-recent-item').length).toBe(10);
  });

  test('the filter is always available even while the list is short (#1005)', () => {
    localStorage.setItem(KEY, JSON.stringify(['/a', '/b']));
    mountHome(container, makeCallbacks());
    const filter = document.querySelector('.koi-welcome-recent-filter') as HTMLInputElement | null;
    // #1005: the recent filter is header-mounted and always available — present and perceivable
    // regardless of how few recents there are (it no longer waits for a length threshold).
    expect(filter).not.toBeNull();
    expect(filter!.hidden).toBe(false);
  });

  test('clear-all empties the list', async () => {
    localStorage.setItem(KEY, JSON.stringify(['/a', '/b']));
    mountHome(container, makeCallbacks());
    (document.querySelector('.koi-welcome-recent-clear') as HTMLElement).click();

    // Clearing now routes through Koine's confirm modal (not window.confirm); approve it.
    const confirmBtn = [...document.querySelectorAll<HTMLButtonElement>('.koi-confirm-btn')].find(
      (b) => b.textContent === 'Clear',
    );
    expect(confirmBtn).toBeDefined();
    confirmBtn!.click();
    await new Promise((r) => setTimeout(r, 0)); // let koiConfirm's promise resolve + re-render

    expect(document.querySelector('.koi-welcome-empty')).not.toBeNull();
  });
});

describe('Home dense recents (#1005)', () => {
  let container: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  /** Seed structured RecentFolder records (with optional branch/language/openedAt) into storage. */
  function seedRecents(
    items: Array<{ path: string; openedAt?: number; branch?: string; language?: string; pinned?: boolean }>,
  ): void {
    const now = Date.now();
    localStorage.setItem(KEY, JSON.stringify(items.map((r, i) => ({ openedAt: now - i * 60_000, ...r }))));
  }

  test('each row shows a teal monogram, the folder name and a relative time', () => {
    seedRecents([{ path: '/proj/billing', openedAt: Date.now() - 8 * 60_000 }]);
    mountHome(container, makeCallbacks());
    const item = document.querySelector<HTMLElement>('.koi-welcome-recent-item')!;
    // Monogram is the folder's LOWERCASE initial (decorative); the name is its basename; time is relative.
    expect(item.querySelector('.koi-welcome-recent-mono')?.textContent).toBe('b');
    expect(item.querySelector('.koi-welcome-recent-item-name')?.textContent).toBe('billing');
    expect(item.querySelector('.koi-welcome-recent-time')?.textContent).toMatch(/min ago/);
  });

  test('a language tag and a git branch render when the recent carries them', () => {
    seedRecents([{ path: '/proj/api', branch: 'main', language: 'csharp' }]);
    mountHome(container, makeCallbacks());
    const item = document.querySelector<HTMLElement>('.koi-welcome-recent-item')!;
    // The language id maps to its emit-target display label (csharp → C#).
    expect(item.querySelector('.koi-welcome-recent-lang')?.textContent).toBe('C#');
    const branch = item.querySelector<HTMLElement>('.koi-welcome-recent-branch');
    expect(branch).not.toBeNull();
    expect(branch!.textContent).toContain('main');
  });

  test('the language tag and branch are omitted when the recent lacks them', () => {
    seedRecents([{ path: '/proj/plain' }]);
    mountHome(container, makeCallbacks());
    const item = document.querySelector<HTMLElement>('.koi-welcome-recent-item')!;
    expect(item.querySelector('.koi-welcome-recent-lang')).toBeNull();
    expect(item.querySelector('.koi-welcome-recent-branch')).toBeNull();
  });

  test('a count pill shows the total number of recents', () => {
    seedRecents([{ path: '/a' }, { path: '/b' }, { path: '/c' }]);
    mountHome(container, makeCallbacks());
    expect(document.querySelector('.koi-welcome-recent-count')?.textContent).toBe('3');
  });

  test('collapses to six rows, with a View all / Show less toggle, past six recents', () => {
    seedRecents(Array.from({ length: 8 }, (_, i) => ({ path: `/proj/folder-${i}` })));
    mountHome(container, makeCallbacks());

    const visible = () => document.querySelectorAll('.koi-welcome-recent-item:not([hidden])').length;
    const toggle = () => document.querySelector<HTMLButtonElement>('.koi-welcome-recent-toggle')!;

    // Collapsed: all eight rows are in the DOM, but only the first six show; the rest hide behind the toggle.
    expect(document.querySelectorAll('.koi-welcome-recent-item').length).toBe(8);
    expect(visible()).toBe(6);
    expect(toggle().textContent).toContain('View all');

    // Expand → every row shows, the toggle flips to "Show less".
    toggle().click();
    expect(visible()).toBe(8);
    expect(toggle().textContent).toContain('Show less');

    // Collapse again → back to six.
    toggle().click();
    expect(visible()).toBe(6);
    expect(toggle().textContent).toContain('View all');
  });

  test('the View all / Show less toggle keeps keyboard focus across its re-render (#1005 review)', () => {
    seedRecents(Array.from({ length: 8 }, (_, i) => ({ path: `/proj/folder-${i}` })));
    mountHome(container, makeCallbacks());
    const toggle = () => document.querySelector<HTMLButtonElement>('.koi-welcome-recent-toggle')!;

    // Activating the toggle rebuilds the recents body (destroying the button); focus must land on the
    // rebuilt twin so a keyboard user isn't dropped to <body>.
    toggle().focus();
    toggle().click();
    expect(document.activeElement).toBe(toggle());
    toggle().click();
    expect(document.activeElement).toBe(toggle());
  });

  test('shows no collapse toggle when six or fewer recents', () => {
    seedRecents(Array.from({ length: 4 }, (_, i) => ({ path: `/proj/folder-${i}` })));
    mountHome(container, makeCallbacks());
    expect(document.querySelector('.koi-welcome-recent-toggle')).toBeNull();
    expect(document.querySelectorAll('.koi-welcome-recent-item:not([hidden])').length).toBe(4);
  });

  test('pin, copy and remove stay present and keyboard-focusable on each row', () => {
    seedRecents([{ path: '/proj/billing' }]);
    mountHome(container, makeCallbacks());
    const item = document.querySelector<HTMLElement>('.koi-welcome-recent-item')!;
    const pin = item.querySelector<HTMLButtonElement>('.koi-welcome-recent-pin')!;
    const copy = item.querySelector<HTMLButtonElement>('.koi-welcome-recent-copy')!;
    const remove = item.querySelector<HTMLButtonElement>('.koi-welcome-recent-remove')!;
    // The controls keep their existing accessible names.
    expect(pin.getAttribute('aria-label')).toBe('Pin billing');
    expect(copy.getAttribute('aria-label')).toBe('Copy path of billing');
    expect(remove.getAttribute('aria-label')).toBe('Remove billing from recent folders');
    // Each is a real, focusable button (keyboard-reachable even though hover-revealed).
    for (const btn of [pin, copy, remove]) {
      btn.focus();
      expect(document.activeElement).toBe(btn);
    }
  });
});

describe('Home clone row (#1005)', () => {
  let container: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  type CloneFn = NonNullable<WelcomeCallbacks['onClone']>;

  /** Mount Home with `canClone` on and a mock `onClone`; returns the root + the spy. */
  function mountWithClone(onClone: Mock<CloneFn> = vi.fn<CloneFn>().mockResolvedValue(undefined)): {
    root: HTMLElement;
    onClone: Mock<CloneFn>;
  } {
    const cb: WelcomeCallbacks = { ...makeCallbacks(), onClone };
    mountHome(container, cb, SAMPLE, true, { canClone: true });
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;
    return { root, onClone };
  }

  const trigger = (root: HTMLElement) => root.querySelector<HTMLButtonElement>('.koi-welcome-clone-trigger')!;
  const form = (root: HTMLElement) => root.querySelector<HTMLElement>('.koi-welcome-clone-form')!;
  const urlInput = (root: HTMLElement) => root.querySelector<HTMLInputElement>('.koi-welcome-clone-url')!;
  const submitBtn = (root: HTMLElement) => root.querySelector<HTMLButtonElement>('.koi-welcome-clone-submit')!;

  /** Open the form and type `url` into the input (dispatching input so validation runs). */
  function openAndType(root: HTMLElement, url: string): void {
    trigger(root).click();
    const input = urlInput(root);
    input.value = url;
    input.dispatchEvent(new Event('input'));
  }

  test('the clone row is absent when canClone is not passed', () => {
    mountHome(container, makeCallbacks(), SAMPLE, true, {});
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;
    expect(root.querySelector('[data-action="clone"]')).toBeNull();
  });

  test('the clone row is absent when canClone is false', () => {
    mountHome(container, makeCallbacks(), SAMPLE, true, { canClone: false });
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;
    expect(root.querySelector('[data-action="clone"]')).toBeNull();
  });

  test('the clone row renders (git-branch icon + label) when canClone is true', () => {
    const { root } = mountWithClone();
    const row = root.querySelector<HTMLElement>('[data-action="clone"]');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain('Clone repository');
    // The row carries the shared git-branch glyph (an inline SVG).
    expect(row!.querySelector('svg')).not.toBeNull();
  });

  test('clicking the row reveals the inline form (hidden until then)', () => {
    const { root } = mountWithClone();
    expect(form(root).hidden).toBe(true);
    trigger(root).click();
    expect(form(root).hidden).toBe(false);
    // Toggling again collapses it.
    trigger(root).click();
    expect(form(root).hidden).toBe(true);
  });

  test('the Clone button is disabled for an invalid URL and enabled for a valid one', () => {
    const { root } = mountWithClone();
    trigger(root).click();
    const submit = submitBtn(root);
    expect(submit.disabled).toBe(true); // empty → disabled

    const input = urlInput(root);
    input.value = 'not a url';
    input.dispatchEvent(new Event('input'));
    expect(submit.disabled).toBe(true); // junk → still disabled

    input.value = 'https://github.com/x/y.git';
    input.dispatchEvent(new Event('input'));
    expect(submit.disabled).toBe(false); // a real https clone URL → enabled
  });

  test('submitting a valid URL calls onClone with it', () => {
    const { root, onClone } = mountWithClone();
    openAndType(root, 'https://github.com/x/y.git');
    submitBtn(root).click();
    expect(onClone).toHaveBeenCalledWith('https://github.com/x/y.git');
  });

  test('Enter in the URL input submits when valid (scp-style git@ URL)', () => {
    const { root, onClone } = mountWithClone();
    openAndType(root, 'git@github.com:x/y.git');
    urlInput(root).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onClone).toHaveBeenCalledWith('git@github.com:x/y.git');
  });

  test('when onClone rejects, an inline error shows and the form stays open to retry', async () => {
    const onClone = vi.fn<CloneFn>().mockRejectedValue(new Error('Repository not found'));
    const { root } = mountWithClone(onClone);
    openAndType(root, 'https://github.com/x/y.git');
    submitBtn(root).click();
    await new Promise((r) => setTimeout(r, 0)); // let the rejected promise settle + re-render

    const err = root.querySelector<HTMLElement>('.koi-welcome-clone-error');
    expect(err).not.toBeNull();
    expect(err!.hidden).toBe(false);
    expect(err!.textContent).toContain('Repository not found');
    // The form is left open so the user can fix the URL and try again.
    expect(form(root).hidden).toBe(false);
  });

  test('a click inside the URL input does not collapse the open form', () => {
    const { root } = mountWithClone();
    trigger(root).click();
    expect(form(root).hidden).toBe(false);
    // A bubbling click landing in the input must be contained — it must NOT re-toggle (collapse) the row.
    urlInput(root).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(form(root).hidden).toBe(false);
  });
});

describe('Home keycaps + shortcuts (#1005)', () => {
  let container: HTMLElement;
  // The last-mounted Home, destroyed in afterEach so its document-level keydown listener never leaks
  // into the next case (the whole point of Task 11's teardown — #1000/#980).
  let home: ReturnType<typeof mountHome> | null;

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    home = null;
  });

  afterEach(() => {
    home?.destroy();
    home = null;
  });

  /** Mount Home (canClone/canOpenFolders default on) and return its root + the callback spies. */
  function mountFor(opts: { canClone?: boolean; canOpenFolders?: boolean } = {}): {
    root: HTMLElement;
    cb: WelcomeCallbacks;
  } {
    const cb = makeCallbacks();
    home = mountHome(container, cb, SAMPLE, opts.canOpenFolders ?? true, { canClone: opts.canClone ?? true });
    return { root: document.querySelector<HTMLElement>('.koi-welcome')!, cb };
  }

  /** The concatenated keys rendered on the Start action / clone row with this data-action — each key is
   *  its own boxed <kbd>, so the group's textContent is the chord (e.g. `⌘N`, `⇧⌘C`). */
  function keycapFor(root: HTMLElement, dataAction: string): string {
    const host = root.querySelector<HTMLElement>(`[data-action="${dataAction}"]`)!;
    return host.querySelector<HTMLElement>('.koi-welcome-keys')?.textContent ?? '';
  }

  /** Dispatch a document-level keydown (the handler listens on `document`). */
  function press(init: KeyboardEventInit): void {
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  }

  test('renders per-action boxed keys carrying the platform modifier glyph on the four Start actions', () => {
    const { root } = mountFor({ canClone: true });
    // Each action shows its keys as individual boxes (one <kbd class="koi-welcome-key"> per key); the
    // group's text is the whole chord. New / Example: mod+letter (MOD is ⌘ on mac, Ctrl elsewhere).
    expect(keycapFor(root, 'new-model')).toContain('N');
    expect(keycapFor(root, 'new-model')).toContain(MOD);
    expect(keycapFor(root, 'open-example')).toContain('E');
    expect(keycapFor(root, 'open-example')).toContain(MOD);
    // Open folder / Clone: shift combos carry the ⇧ marker on top of the modifier + letter.
    expect(keycapFor(root, 'open-folder')).toContain('O');
    expect(keycapFor(root, 'open-folder')).toContain(MOD);
    expect(keycapFor(root, 'open-folder')).toContain('⇧');
    expect(keycapFor(root, 'clone')).toContain('C');
    expect(keycapFor(root, 'clone')).toContain(MOD);
    expect(keycapFor(root, 'clone')).toContain('⇧');
    // The New action's keys are separate boxes — one carries the MOD glyph, one carries the letter.
    const newKeys = Array.from(
      root.querySelectorAll<HTMLElement>('[data-action="new-model"] .koi-welcome-key'),
    ).map((k) => k.textContent);
    expect(newKeys).toContain(MOD);
    expect(newKeys).toContain('N');
  });

  test('the clone keys only render when the clone row does (canClone off → no key group)', () => {
    const { root } = mountFor({ canClone: false });
    expect(root.querySelector('[data-action="clone"]')).toBeNull();
    // Only three key groups remain (New / Example / Open folder).
    expect(root.querySelectorAll('.koi-welcome-keys').length).toBe(3);
  });

  test('mod+N fires onNewModel — ⌘ and Ctrl both count as the primary modifier', () => {
    const { cb } = mountFor();
    press({ key: 'n', metaKey: true });
    expect(cb.onNewModel).toHaveBeenCalledTimes(1);
    press({ key: 'n', ctrlKey: true });
    expect(cb.onNewModel).toHaveBeenCalledTimes(2);
  });

  test('a bare key (no modifier) never fires the shortcut', () => {
    const { cb } = mountFor();
    press({ key: 'n' });
    expect(cb.onNewModel).not.toHaveBeenCalled();
  });

  test('⇧mod+O fires onOpenFolder', () => {
    const { cb } = mountFor();
    press({ key: 'o', metaKey: true, shiftKey: true });
    expect(cb.onOpenFolder).toHaveBeenCalledTimes(1);
  });

  test('⇧mod+O does NOT fire when the host cannot open folders', () => {
    const { cb } = mountFor({ canOpenFolders: false });
    press({ key: 'o', metaKey: true, shiftKey: true });
    expect(cb.onOpenFolder).not.toHaveBeenCalled();
  });

  test('mod+E opens the example gallery', () => {
    const { root } = mountFor();
    const galleryView = root.querySelector<HTMLElement>('.koi-gallery-view')!;
    expect(galleryView.hidden).toBe(true);
    press({ key: 'e', metaKey: true });
    expect(galleryView.hidden).toBe(false);
  });

  test('⇧mod+C toggles the clone form open when canClone', () => {
    const { root } = mountFor({ canClone: true });
    const form = root.querySelector<HTMLElement>('.koi-welcome-clone-form')!;
    expect(form.hidden).toBe(true);
    press({ key: 'c', metaKey: true, shiftKey: true });
    expect(form.hidden).toBe(false);
  });

  test('a shortcut does NOT fire while the recents filter is focused (typing is not hijacked)', () => {
    localStorage.setItem(KEY, JSON.stringify(['/a/one', '/b/two']));
    const { cb } = mountFor();
    const filter = document.querySelector<HTMLInputElement>('.koi-welcome-recent-filter')!;
    filter.focus();
    expect(document.activeElement).toBe(filter);
    press({ key: 'n', metaKey: true });
    expect(cb.onNewModel).not.toHaveBeenCalled();
  });

  test('a shortcut does NOT fire while the clone URL input is focused', () => {
    const { cb, root } = mountFor({ canClone: true });
    // Opening the form focuses the URL input; a stray mod+N there must not jump.
    root.querySelector<HTMLButtonElement>('.koi-welcome-clone-trigger')!.click();
    const url = root.querySelector<HTMLInputElement>('.koi-welcome-clone-url')!;
    expect(document.activeElement).toBe(url);
    press({ key: 'n', metaKey: true });
    expect(cb.onNewModel).not.toHaveBeenCalled();
  });

  test('a shortcut does NOT fire after destroy() — the keydown listener is removed', () => {
    const { cb } = mountFor();
    home!.destroy();
    home = null; // already destroyed — keep afterEach from double-tearing-down
    press({ key: 'n', metaKey: true });
    expect(cb.onNewModel).not.toHaveBeenCalled();
  });
});

describe('mountHome (routed Home view)', () => {
  test('renders the welcome card into the given container, not document.body', () => {
    const el = document.createElement('div');
    mountHome(el, makeCallbacks(), SAMPLE);
    expect(el.querySelector('.koi-welcome')).not.toBeNull();
    // Unlike the legacy overlay, the routed Home does not self-mount on the body.
    expect(document.body.querySelector('.koi-welcome')).toBeNull();
  });

  test('wires the open-folder action through to the callback', () => {
    const el = document.createElement('div');
    const cb = makeCallbacks();
    mountHome(el, cb, SAMPLE);
    el.querySelector<HTMLButtonElement>('[data-action="open-folder"]')!.click();
    expect(cb.onOpenFolder).toHaveBeenCalledTimes(1);
  });

  test('destroy() removes the mounted view', () => {
    const el = document.createElement('div');
    const home = mountHome(el, makeCallbacks(), SAMPLE);
    home.destroy();
    expect(el.querySelector('.koi-welcome')).toBeNull();
  });
});

describe('mountHome — dead-recent recovery (recover hook, #391)', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  test('recover(path) confirms, forgets the dead recent, and rebuilds the list in place', async () => {
    localStorage.setItem(KEY, JSON.stringify(['ghost']));
    const el = document.createElement('div');
    const home = mountHome(el, makeCallbacks(), SAMPLE);
    // The seeded recent renders one row.
    expect(el.querySelectorAll('.koi-welcome-recent-item').length).toBe(1);

    // recover() surfaces the "Remove from Recent?" confirm on the Home view (not via an overlay over the
    // editor) and, on accept, forgets the dead entry and refreshes the recents list in place.
    const recovered = home.recover('ghost');
    const okBtn = document.querySelector<HTMLButtonElement>('.koi-confirm-btn-danger');
    expect(okBtn).not.toBeNull();
    okBtn!.click();
    await recovered;

    expect(localStorage.getItem(KEY)).not.toContain('ghost');
    // It was the only recent, so the empty-state copy now shows in the rebuilt list.
    expect(el.querySelector('.koi-welcome-empty')).not.toBeNull();
    expect(el.querySelectorAll('.koi-welcome-recent-item').length).toBe(0);
  });

  test('recover(path) on cancel keeps the entry and leaves the list intact', async () => {
    localStorage.setItem(KEY, JSON.stringify(['ghost']));
    const el = document.createElement('div');
    const home = mountHome(el, makeCallbacks(), SAMPLE);

    const recovered = home.recover('ghost');
    const cancelBtn = [...document.querySelectorAll<HTMLButtonElement>('.koi-confirm-btn')].find(
      (b) => b.textContent === 'Cancel',
    );
    expect(cancelBtn).toBeDefined();
    cancelBtn!.click();
    await recovered;

    // Cancelled — the dead entry is still remembered and its row still shows.
    expect(localStorage.getItem(KEY)).toContain('ghost');
    expect(el.querySelectorAll('.koi-welcome-recent-item').length).toBe(1);
  });
});

describe('Home colophon footer', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  /** The colophon footer inside a welcome root, asserted present. */
  function footerOf(root: HTMLElement): HTMLElement {
    const footer = root.querySelector<HTMLElement>('.koi-home-colophon');
    expect(footer).not.toBeNull();
    return footer!;
  }

  function linkLabels(footer: HTMLElement): (string | undefined)[] {
    return Array.from(footer.querySelectorAll<HTMLElement>('.koi-home-colophon-link')).map((a) => a.textContent?.trim());
  }

  test('the routed Home (mountHome) carries the three text links, byline and a hidden version chip', () => {
    const el = document.createElement('div');
    mountHome(el, makeCallbacks(), SAMPLE);
    const footer = footerOf(el.querySelector<HTMLElement>('.koi-welcome')!);
    // Home shows a text-only Docs · GitHub · Blog trio (no icons, no Home link) per the mock.
    expect(linkLabels(footer)).toEqual(['Docs', 'GitHub', 'Blog']);
    expect(footer.querySelector('.koi-home-colophon-credit')?.textContent).toContain('Philippe Matray');
    // The chip stays hidden until the async version fetch resolves (mirrors the About chip).
    expect(footer.querySelector<HTMLElement>('.koi-home-colophon-chip')!.hidden).toBe(true);
  });

  test('each colophon link is a real, text-only external anchor (href + target + rel, no icon)', () => {
    const el = document.createElement('div');
    mountHome(el, makeCallbacks(), SAMPLE);
    const footer = footerOf(el.querySelector<HTMLElement>('.koi-welcome')!);
    const links = Array.from(footer.querySelectorAll<HTMLAnchorElement>('a.koi-home-colophon-link'));
    expect(links.length).toBe(3);
    for (const a of links) {
      expect(a.getAttribute('href')).toMatch(/^https:\/\//);
      expect(a.target).toBe('_blank');
      expect(a.rel).toBe('noopener noreferrer');
      // Text-only per the mock — the icon span is gone.
      expect(a.querySelector('.koi-home-colophon-link-icon')).toBeNull();
    }
  });
});

// The rich resume-session card (#1005) replaces the old "Resume editing" button. It self-gates on the
// persisted last-session snapshot (getLastSession) — present in BOTH the warm case (editor live this
// session) and the cold case (a prior visit left a snapshot) — so these tests seed that snapshot in
// localStorage under its key to drive the card. `warm` only decides the live ping dot.
const LAST_SESSION_KEY = 'koine.studio.lastSession';

/** Seed the persisted last-session snapshot that getLastSession() (and thus the resume card) reads. */
function seedLastSession(s: Record<string, unknown>): void {
  localStorage.setItem(LAST_SESSION_KEY, JSON.stringify(s));
}

describe('mountHome — resume session card', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });
  afterEach(() => {
    localStorage.clear();
  });

  test('warm + a session record renders a [data-action="resume"] card, with a live ping dot, that fires onResume', () => {
    seedLastSession({ project: 'billing', file: 'billing.koi', editedAt: Date.now() - 8 * 60_000, unsavedCount: 3 });
    const el = document.createElement('div');
    const cb: WelcomeCallbacks = { ...makeCallbacks(), onResume: vi.fn() };
    mountHome(el, cb, SAMPLE, true, { warm: true });

    const card = el.querySelector<HTMLButtonElement>('[data-action="resume"]');
    expect(card).not.toBeNull();
    expect(card!.tagName).toBe('BUTTON');
    // The warm ping dot is present and animating.
    const ping = card!.querySelector('.koi-home-resume-ping');
    expect(ping).not.toBeNull();
    expect(ping!.classList.contains('is-live')).toBe(true);
    // Project · file, relative time and the unsaved count all render.
    expect(card!.querySelector('.koi-home-resume-project')?.textContent).toBe('billing');
    expect(card!.querySelector('.koi-home-resume-file')?.textContent).toBe('billing.koi');
    expect(card!.querySelector('.koi-home-resume-time')?.textContent).toMatch(/min ago/);
    expect(card!.querySelector('.koi-home-resume-unsaved')?.textContent).toBe('3 unsaved');

    card!.click();
    expect(cb.onResume).toHaveBeenCalledTimes(1);
  });

  test('the card sits at the top of the launch rail, not on the "Start" rail-title row', () => {
    seedLastSession({ project: 'billing', editedAt: Date.now() });
    const el = document.createElement('div');
    mountHome(el, { ...makeCallbacks(), onResume: vi.fn() }, SAMPLE, true, { warm: true });

    const card = el.querySelector<HTMLButtonElement>('[data-action="resume"]')!;
    // It lives inside the launch rail as its first child — above the "Start" actions.
    const launch = card.closest('.koi-welcome-launch');
    expect(launch).not.toBeNull();
    expect(launch!.firstElementChild).toBe(card);
    // It no longer shares the "Start" rail-title row.
    expect(card.closest('.koi-welcome-rail-head')).toBeNull();
  });

  test('cold (no warm) + a session record renders the card WITHOUT a ping dot', () => {
    seedLastSession({ project: 'ordering', file: 'ordering.koi', editedAt: Date.now() - 2 * 3600_000 });
    const el = document.createElement('div');
    mountHome(el, makeCallbacks(), SAMPLE, true, {});

    const card = el.querySelector<HTMLButtonElement>('[data-action="resume"]');
    expect(card).not.toBeNull();
    expect(card!.querySelector('.koi-home-resume-ping')).toBeNull();
  });

  test('unknown fields (no file / no unsavedCount) are omitted without crashing', () => {
    seedLastSession({ project: 'library', editedAt: Date.now() - 26 * 3600_000 });
    const el = document.createElement('div');
    mountHome(el, makeCallbacks(), SAMPLE, true, { warm: true });

    const card = el.querySelector<HTMLButtonElement>('[data-action="resume"]')!;
    expect(card.querySelector('.koi-home-resume-project')?.textContent).toBe('library');
    expect(card.querySelector('.koi-home-resume-file')).toBeNull();
    expect(card.querySelector('.koi-home-resume-unsaved')).toBeNull();
    // The relative time still renders (26h → "1d ago").
    expect(card.querySelector('.koi-home-resume-time')?.textContent).toMatch(/\d+d ago/);
  });

  test('no session and not resumable renders no card', () => {
    const el = document.createElement('div');
    mountHome(el, makeCallbacks(), SAMPLE, true, { warm: true });
    expect(el.querySelector('[data-action="resume"]')).toBeNull();
  });

  test('canResume without a snapshot renders a minimal "Resume editing" card (#766 fallback)', () => {
    // A returning user whose one-click Resume is owed (workspace-opened / editor booted) but whose
    // Task-4 snapshot is not present: the card still shows, degraded to a bare "Resume editing" label
    // with no file / time / unsaved detail, and still fires onResume.
    const el = document.createElement('div');
    const cb: WelcomeCallbacks = { ...makeCallbacks(), onResume: vi.fn() };
    mountHome(el, cb, SAMPLE, true, { canResume: true });
    const card = el.querySelector<HTMLButtonElement>('[data-action="resume"]');
    expect(card).not.toBeNull();
    expect(card!.querySelector('.koi-home-resume-project')?.textContent).toBe('Resume editing');
    expect(card!.querySelector('.koi-home-resume-file')).toBeNull();
    expect(card!.querySelector('.koi-home-resume-detail')).toBeNull();
    card!.click();
    expect(cb.onResume).toHaveBeenCalledTimes(1);
  });

  test('prefers-reduced-motion suppresses the ping animation (no is-live class)', () => {
    seedLastSession({ project: 'billing', editedAt: Date.now() });
    const el = document.createElement('div');
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    try {
      mountHome(el, { ...makeCallbacks(), onResume: vi.fn() }, SAMPLE, true, { warm: true });
      const ping = el.querySelector('.koi-home-resume-ping');
      // Warm, so the dot itself still renders — but it is NOT animating.
      expect(ping).not.toBeNull();
      expect(ping!.classList.contains('is-live')).toBe(false);
    } finally {
      window.matchMedia = original;
    }
  });
});

describe('mountHome — embedded chrome suppression', () => {
  test('embedded Home renders neither the duplicate brand nor the stray ✕', () => {
    const el = document.createElement('div');
    mountHome(el, makeCallbacks(), SAMPLE);
    // The top-bar brand is the single logo on Home; the card must not duplicate it.
    expect(el.querySelector('.koi-welcome-brand')).toBeNull();
    // No overlay to dismiss on the routed Home — the close ✕ (console and gallery) is gone entirely.
    expect(el.querySelector('.koi-welcome-close')).toBeNull();
  });
});

describe('Home full-bleed shell', () => {
  let container: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  test('renders a top-bar region above the card (empty, no brand)', () => {
    mountHome(container, makeCallbacks(), SAMPLE);
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;

    const topbar = root.querySelector<HTMLElement>('.koi-home-topbar');
    expect(topbar).not.toBeNull();
    // The top bar sits outside the card so it spans both views.
    expect(topbar!.closest('.koi-welcome-card')).toBeNull();
    // Task 2 fills the brand slot; for now the brand class stays absent everywhere on Home.
    expect(root.querySelector('.koi-welcome-brand')).toBeNull();
    expect(topbar!.querySelector('.koi-welcome-brand')).toBeNull();
  });

  test('lays the console body out as a two-column grid (hero left, launch right)', () => {
    mountHome(container, makeCallbacks(), SAMPLE);
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;

    const body = root.querySelector<HTMLElement>('.koi-home-body');
    expect(body).not.toBeNull();
    // The old hero wrapper is gone — the body grid replaces it.
    expect(root.querySelector('.koi-welcome-hero')).toBeNull();

    // Left column: the hero lede lives inside the body grid.
    const lede = root.querySelector<HTMLElement>('.koi-welcome-lede');
    expect(lede).not.toBeNull();
    expect(lede!.closest('.koi-home-body')).toBe(body);

    // Right column: the launch rail lives inside the body grid.
    const launch = root.querySelector<HTMLElement>('.koi-welcome-launch');
    expect(launch).not.toBeNull();
    expect(launch!.closest('.koi-home-body')).toBe(body);
  });

  test('keeps the existing actions and recents inside the launch rail', () => {
    localStorage.setItem(KEY, JSON.stringify(['/a/one', '/b/two']));
    mountHome(container, makeCallbacks(), SAMPLE);
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;

    // The three start actions still render (New model / Start from an example / Open folder).
    expect(root.querySelectorAll('.koi-welcome-action').length).toBeGreaterThanOrEqual(3);
    // Recents container is still present and populated.
    expect(root.querySelector('.koi-welcome-recent')).not.toBeNull();
    expect(root.querySelectorAll('.koi-welcome-recent-item').length).toBe(2);
  });

  test('keeps the single card holding both views, now full-bleed', () => {
    mountHome(container, makeCallbacks(), SAMPLE);
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;
    // Exactly one card, still holding the console + gallery views.
    expect(root.querySelectorAll('.koi-welcome-card').length).toBe(1);
    // The colophon stays inside the console view (Task 3 moves it into the hero).
    const consoleView = root.querySelector<HTMLElement>('.koi-welcome-view:not(.koi-gallery-view)')!;
    expect(consoleView.querySelector('.koi-home-colophon')).not.toBeNull();
  });
});

describe('Home top bar (brand + theme + settings)', () => {
  let container: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  // The theme toggle mutates document.documentElement's data-theme; wipe it around each case so a
  // flip here can't leak into (or be seeded by) another suite sharing the global document.
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
  });

  test('renders the brand lockup in the top bar with an accessible name (and no .koi-welcome-brand)', () => {
    mountHome(container, makeCallbacks(), SAMPLE);
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;
    const topbar = root.querySelector<HTMLElement>('.koi-home-topbar')!;

    const brand = topbar.querySelector<HTMLElement>('.koi-home-brand');
    expect(brand).not.toBeNull();
    // Accessible name is exposed on the lockup; the decorative monogram SVG renders inside it.
    expect(brand!.getAttribute('aria-label')).toBe('Koine Studio');
    expect(brand!.querySelector('svg')).not.toBeNull();
    // The single Home logo is the top-bar brand — the legacy card brand class stays absent everywhere.
    expect(root.querySelector('.koi-welcome-brand')).toBeNull();
  });

  test('the theme button flips document.documentElement data-theme on click', () => {
    mountHome(container, makeCallbacks(), SAMPLE);
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;
    const themeBtn = root.querySelector<HTMLButtonElement>('.koi-home-topbar-end button[aria-label="Toggle theme"]');
    expect(themeBtn).not.toBeNull();
    expect(themeBtn!.type).toBe('button');

    const before = document.documentElement.getAttribute('data-theme');
    themeBtn!.click();
    const after = document.documentElement.getAttribute('data-theme');
    expect(after).not.toBe(before); // the flip changed the applied theme
    expect(after === 'dark' || after === 'light').toBe(true);
  });

  test('the settings gear fires onOpenSettings on click', () => {
    const onOpenSettings = vi.fn();
    const cb: WelcomeCallbacks = { ...makeCallbacks(), onOpenSettings };
    mountHome(container, cb, SAMPLE);
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;
    const gear = root.querySelector<HTMLButtonElement>('.koi-home-topbar-end button[aria-label="Settings"]');
    expect(gear).not.toBeNull();
    expect(gear!.type).toBe('button');

    gear!.click();
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});

describe('Home hero snippet', () => {
  test('the invariant line ends at the 0 literal, with no trailing message string', () => {
    const el = document.createElement('div');
    mountHome(el, makeCallbacks(), SAMPLE);
    const code = el.querySelector('.koi-welcome-snippet-code')!.textContent ?? '';
    // The invariant now reads `amount >= 0` and stops there — the old message string is gone entirely.
    expect(code).toContain('invariant amount >= 0');
    expect(code).not.toContain('a monetary amount cannot be negative');
  });
});

describe('Home hero — multi-target caption + colophon', () => {
  let container: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  test('the emit caption names all four target languages, with one tinted dot per language', () => {
    mountHome(container, makeCallbacks(), SAMPLE);
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;

    const emit = root.querySelector<HTMLElement>('.koi-welcome-snippet-emit');
    expect(emit).not.toBeNull();
    // The caption reads Koine's multi-target reach, not the old C#-only line.
    const text = emit!.textContent ?? '';
    for (const lang of ['C#', 'TypeScript', 'Python', 'PHP']) {
      expect(text).toContain(lang);
    }
    // Four language dots — one per emit target — grouped under .koi-welcome-emit-dots.
    const dots = emit!.querySelectorAll('.koi-welcome-emit-dots .koi-welcome-emit-dot');
    expect(dots.length).toBe(4);
  });

  test('the colophon now sits inside the hero lede, still carrying its three links + credit', () => {
    mountHome(container, makeCallbacks(), SAMPLE);
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;

    // Relocated into the hero's left column (still inside the console view, inside the body grid).
    const colophon = root.querySelector<HTMLElement>('.koi-welcome-lede .koi-home-colophon');
    expect(colophon).not.toBeNull();
    // The Home colophon is the text-only Docs · GitHub · Blog trio + the byline.
    expect(colophon!.querySelectorAll('.koi-home-colophon-link').length).toBe(3);
    expect(colophon!.querySelector('.koi-home-colophon-credit')?.textContent).toContain('Philippe Matray');
  });
});

// The search input is debounced; tests enable fake timers and flush the debounce window. Target the
// gallery's own search box by class — the always-available recent filter (#1005) is also a
// type=search input and sits earlier in the DOM, so a bare input[type=search] would now match it.
function setSearch(root: HTMLElement, value: string): void {
  vi.useFakeTimers();
  const input = root.querySelector<HTMLInputElement>('.koi-welcome-search-input')!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  vi.advanceTimersByTime(200);
  vi.useRealTimers();
}

// Characterization tests for the baseName helper used in recent-item labels (issue #793).
// baseName is a private function; these tests pin its behaviour via the rendered DOM so the
// migration to shared basename can be verified as zero-change.
describe('welcome baseName characterization (issue #793)', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  function itemNames(el: HTMLElement): string[] {
    return [...el.querySelectorAll<HTMLElement>('.koi-welcome-recent-item-name')].map(
      (n) => n.textContent ?? '',
    );
  }

  test('unix path: shows last segment as item name', () => {
    localStorage.setItem(KEY, JSON.stringify(['a/b/billing.koi']));
    const el = document.createElement('div');
    document.body.appendChild(el);
    mountHome(el, makeCallbacks());
    expect(itemNames(el)).toEqual(['billing.koi']);
  });

  test('windows-style path: backslash separator splits correctly', () => {
    localStorage.setItem(KEY, JSON.stringify(['C:\\Users\\me\\project']));
    const el = document.createElement('div');
    document.body.appendChild(el);
    mountHome(el, makeCallbacks());
    expect(itemNames(el)).toEqual(['project']);
  });

  test('trailing slash is stripped — last non-empty segment is returned', () => {
    localStorage.setItem(KEY, JSON.stringify(['a/b/project/']));
    const el = document.createElement('div');
    document.body.appendChild(el);
    mountHome(el, makeCallbacks());
    expect(itemNames(el)).toEqual(['project']);
  });
});
