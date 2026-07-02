import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mountHome, filterTemplates, DIFFICULTY_ORDER, type WelcomeCallbacks } from '@/welcome/welcome';
import type { Template } from '@/welcome/templates';

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

  test('shows a filter only when the list is long, and filters by text', () => {
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

  test('the filter is not perceivable while the list is short', () => {
    localStorage.setItem(KEY, JSON.stringify(['/a', '/b']));
    mountHome(container, makeCallbacks());
    const filter = document.querySelector('.koi-welcome-recent-filter') as HTMLInputElement | null;
    // Absent or present-but-hidden — either way it must not show below the threshold.
    expect(filter?.hidden ?? true).toBe(true);
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

  test('the routed Home (mountHome) carries the four links, byline and a hidden version chip', () => {
    const el = document.createElement('div');
    mountHome(el, makeCallbacks(), SAMPLE);
    const footer = footerOf(el.querySelector<HTMLElement>('.koi-welcome')!);
    expect(linkLabels(footer)).toEqual(['GitHub', 'Home', 'Docs', 'Blog']);
    expect(footer.querySelector('.koi-home-colophon-credit')?.textContent).toContain('Philippe Matray');
    // The chip stays hidden until the async version fetch resolves (mirrors the About chip).
    expect(footer.querySelector<HTMLElement>('.koi-home-colophon-chip')!.hidden).toBe(true);
  });

  test('each colophon link is a real external anchor (href + target + rel)', () => {
    const el = document.createElement('div');
    mountHome(el, makeCallbacks(), SAMPLE);
    const footer = footerOf(el.querySelector<HTMLElement>('.koi-welcome')!);
    const links = Array.from(footer.querySelectorAll<HTMLAnchorElement>('a.koi-home-colophon-link'));
    expect(links.length).toBe(4);
    for (const a of links) {
      expect(a.getAttribute('href')).toMatch(/^https:\/\//);
      expect(a.target).toBe('_blank');
      expect(a.rel).toBe('noopener noreferrer');
    }
  });
});

describe('mountHome — Resume editing control', () => {
  test('with { canResume: true } renders a [data-action="resume"] control that fires onResume', () => {
    const el = document.createElement('div');
    const cb: WelcomeCallbacks = { ...makeCallbacks(), onResume: vi.fn() };
    mountHome(el, cb, SAMPLE, true, { canResume: true });

    const resume = el.querySelector<HTMLButtonElement>('[data-action="resume"]');
    expect(resume).not.toBeNull();
    expect(resume!.tagName).toBe('BUTTON');

    resume!.click();
    expect(cb.onResume).toHaveBeenCalledTimes(1);
  });

  test('the resume control sits on the "Start" rail-title row, not in the (absent) top bar', () => {
    const el = document.createElement('div');
    const cb: WelcomeCallbacks = { ...makeCallbacks(), onResume: vi.fn() };
    mountHome(el, cb, SAMPLE, true, { canResume: true });

    const resume = el.querySelector<HTMLButtonElement>('[data-action="resume"]')!;
    const head = resume.closest('.koi-welcome-rail-head');
    expect(head).not.toBeNull();
    // It shares its row with the "Start" rail title.
    expect(head!.querySelector('.koi-welcome-rail-title')?.textContent).toBe('Start');
    // It is no longer parked in the welcome card's own top bar.
    expect(resume.closest('.koi-welcome-bar')).toBeNull();
  });

  test('without canResume (pristine Home) there is no resume control', () => {
    const el = document.createElement('div');
    mountHome(el, makeCallbacks(), SAMPLE);
    expect(el.querySelector('[data-action="resume"]')).toBeNull();
  });

  test('with { canResume: false } there is no resume control', () => {
    const el = document.createElement('div');
    mountHome(el, makeCallbacks(), SAMPLE, true, { canResume: false });
    expect(el.querySelector('[data-action="resume"]')).toBeNull();
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
  test('collapses the spacing before the invariant message to a single space', () => {
    const el = document.createElement('div');
    mountHome(el, makeCallbacks(), SAMPLE);
    const code = el.querySelector('.koi-welcome-snippet-code')!.textContent ?? '';
    // Exactly one space between the `0` literal and the invariant message string.
    expect(code).toContain('0 "a monetary amount cannot be negative"');
    // The old three-space gap is gone.
    expect(code).not.toContain('0   "a monetary');
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
