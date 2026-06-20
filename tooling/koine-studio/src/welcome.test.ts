import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createWelcome, filterTemplates, DIFFICULTY_ORDER, type WelcomeCallbacks } from './welcome';
import type { Template } from './templates';

// Each test mounts a fresh welcome overlay on document.body; clear it between tests so stale
// roots/handlers don't leak across cases.
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
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  test("renders the active level's cards and opens a template on click", () => {
    const cb = makeCallbacks();
    const handle = createWelcome(cb, SAMPLE);
    handle.show();
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;

    // The first present level (Starter) is active by default; only its cards are in the panel.
    expect(cardNames(root).sort()).toEqual(['Billing', 'Ordering']);

    const billing = Array.from(root.querySelectorAll<HTMLElement>('.koi-welcome-example')).find(
      (b) => b.querySelector('.koi-welcome-example-name')?.textContent === 'Billing',
    )!;
    billing.click();
    expect((cb.onOpenExample as ReturnType<typeof vi.fn>).mock.calls[0][0].id).toBe('billing');
    expect(handle.visible).toBe(false);
  });

  test('the title sits beside the icon, with a tagline and an open chevron — no badges', () => {
    const cb = makeCallbacks();
    const handle = createWelcome(cb, SAMPLE);
    handle.show();
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
    createWelcome(cb, SAMPLE).show();
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
    createWelcome(cb, SAMPLE).show();
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
    createWelcome(cb, SAMPLE).show();
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;
    expect(root.querySelector('.koi-welcome-chip')).toBeNull();
    expect(root.querySelector('.koi-welcome-filters')).toBeNull();
    expect(root.querySelector('input[type="search"]')).not.toBeNull();
  });

  test('search narrows the active level and updates the tab counts (matching tags too)', () => {
    const cb = makeCallbacks();
    createWelcome(cb, SAMPLE).show();
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;

    setSearch(root, 'state-machine'); // a tag: ordering (starter) + library (intermediate)
    expect(cardNames(root)).toEqual(['Ordering']); // active level stays Starter
    expect(tabCount(root, 'starter')).toBe('1');
    expect(tabCount(root, 'intermediate')).toBe('1');
    expect(tabCount(root, 'advanced')).toBe('0');
  });

  test('when a search empties the active level, the panel jumps to the first level with matches', () => {
    const cb = makeCallbacks();
    createWelcome(cb, SAMPLE).show();
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;

    setSearch(root, 'ddd'); // a tag on library (intermediate) + saas (advanced); no starter match
    expect(tabCount(root, 'starter')).toBe('0');
    expect(tabFor(root, 'starter').classList.contains('is-empty')).toBe(true);
    expect(tabFor(root, 'intermediate').getAttribute('aria-selected')).toBe('true');
    expect(cardNames(root)).toEqual(['Library']);
  });

  test('shows an empty-state message when nothing matches', () => {
    const cb = makeCallbacks();
    const handle = createWelcome(cb, SAMPLE);
    handle.show();
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
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  /** The start action whose label matches `label`, e.g. "Start from an example". */
  function action(root: HTMLElement, label: string): HTMLButtonElement {
    return Array.from(root.querySelectorAll<HTMLButtonElement>('button.koi-welcome-action')).find(
      (b) => b.querySelector('.koi-welcome-action-label')?.textContent === label,
    )!;
  }

  const consoleCard = (root: HTMLElement) => root.querySelector<HTMLElement>('.koi-welcome-card:not(.koi-gallery-card)')!;
  const galleryCard = (root: HTMLElement) => root.querySelector<HTMLElement>('.koi-gallery-card')!;

  test('opens on the console with the gallery hidden behind a "Start from an example" action', () => {
    const cb = makeCallbacks();
    createWelcome(cb, SAMPLE).show();
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;

    expect(consoleCard(root).hidden).toBe(false);
    expect(galleryCard(root).hidden).toBe(true);
    expect(action(root, 'Start from an example')).toBeTruthy();
  });

  test('the action swaps in the gallery; "Back to start" swaps back', () => {
    const cb = makeCallbacks();
    createWelcome(cb, SAMPLE).show();
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;

    action(root, 'Start from an example').click();
    expect(consoleCard(root).hidden).toBe(true);
    expect(galleryCard(root).hidden).toBe(false);

    root.querySelector<HTMLButtonElement>('.koi-welcome-back')!.click();
    expect(consoleCard(root).hidden).toBe(false);
    expect(galleryCard(root).hidden).toBe(true);
  });

  test('opening the gallery does not leave the welcome screen (no callback, still visible)', () => {
    const cb = makeCallbacks();
    const handle = createWelcome(cb, SAMPLE);
    handle.show();
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;

    action(root, 'Start from an example').click();
    expect(handle.visible).toBe(true);
    expect(cb.onNewModel).not.toHaveBeenCalled();
    expect(cb.onOpenFolder).not.toHaveBeenCalled();
  });

  test('re-showing after the gallery was open returns to the console', () => {
    const cb = makeCallbacks();
    const handle = createWelcome(cb, SAMPLE);
    handle.show();
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;

    action(root, 'Start from an example').click();
    handle.hide();
    handle.show();

    expect(consoleCard(root).hidden).toBe(false);
    expect(galleryCard(root).hidden).toBe(true);
  });
});

const KEY = 'koine.studio.recentFolders';

describe('welcome recent rows', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  test('renders one row per recent with open/remove/pin controls', () => {
    localStorage.setItem(KEY, JSON.stringify(['/a/one', '/b/two']));
    createWelcome(makeCallbacks()).show();
    expect(document.querySelectorAll('.koi-welcome-recent-item').length).toBe(2);
    expect(document.querySelector('.koi-welcome-recent-remove')).not.toBeNull();
    expect(document.querySelector('.koi-welcome-recent-pin')).not.toBeNull();
  });

  test('open control invokes onOpenRecent with the path', () => {
    localStorage.setItem(KEY, JSON.stringify(['/a/one']));
    const cb = makeCallbacks();
    createWelcome(cb).show();
    (document.querySelector('.koi-welcome-recent-open') as HTMLElement).click();
    expect(cb.onOpenRecent).toHaveBeenCalledWith('/a/one');
  });

  test('remove deletes the row and updates storage', () => {
    localStorage.setItem(KEY, JSON.stringify(['/a/one', '/b/two']));
    createWelcome(makeCallbacks()).show();
    (document.querySelector('.koi-welcome-recent-remove') as HTMLElement).click();
    expect(document.querySelectorAll('.koi-welcome-recent-item').length).toBe(1);
    expect(JSON.parse(localStorage.getItem(KEY)!).length).toBe(1);
  });

  test('keeps recent rows inside the scroll list wrapper', () => {
    localStorage.setItem(KEY, JSON.stringify(['/a', '/b']));
    createWelcome(makeCallbacks()).show();
    const list = document.querySelector('.koi-welcome-recent-list');
    expect(list).not.toBeNull();
    expect(list!.querySelectorAll('.koi-welcome-recent-item').length).toBe(2);
  });
});

describe('welcome recent management', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    vi.stubGlobal('confirm', () => true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('shows a filter only when the list is long, and filters by text', () => {
    const many = Array.from({ length: 10 }, (_, i) => `/proj/folder-${i}`);
    localStorage.setItem(KEY, JSON.stringify(many));
    createWelcome(makeCallbacks()).show();
    const filter = document.querySelector('.koi-welcome-recent-filter') as HTMLInputElement;
    expect(filter).not.toBeNull();
    filter.value = 'folder-3';
    filter.dispatchEvent(new Event('input'));
    expect(document.querySelectorAll('.koi-welcome-recent-item').length).toBe(1);
  });

  test('clear-all empties the list', () => {
    localStorage.setItem(KEY, JSON.stringify(['/a', '/b']));
    createWelcome(makeCallbacks()).show();
    (document.querySelector('.koi-welcome-recent-clear') as HTMLElement).click();
    expect(document.querySelector('.koi-welcome-empty')).not.toBeNull();
  });
});

// The search input is debounced; tests enable fake timers and flush the debounce window.
function setSearch(root: HTMLElement, value: string): void {
  vi.useFakeTimers();
  const input = root.querySelector<HTMLInputElement>('input[type="search"]')!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  vi.advanceTimersByTime(200);
  vi.useRealTimers();
}
