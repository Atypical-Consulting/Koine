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
    onNewScratch: vi.fn(),
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

  test('renders one card per template and opens the template on click', () => {
    const cb = makeCallbacks();
    const handle = createWelcome(cb, SAMPLE);
    handle.show();
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;

    expect(cardNames(root).sort()).toEqual(['Billing', 'Library', 'Ordering', 'SaaS Subscription']);

    // Card click still opens its template, then dismisses the screen (preserved behavior).
    const billing = Array.from(root.querySelectorAll<HTMLElement>('.koi-welcome-example')).find(
      (b) => b.querySelector('.koi-welcome-example-name')?.textContent === 'Billing',
    )!;
    billing.click();
    expect((cb.onOpenExample as ReturnType<typeof vi.fn>).mock.calls[0][0].id).toBe('billing');
    expect(handle.visible).toBe(false);
  });

  test('cards are <button>s with an aria-label of name + tagline and difficulty/tag badges', () => {
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
    const badges = Array.from(billing.querySelectorAll('.koi-welcome-badge')).map((b) => b.textContent);
    expect(badges).toContain('starter');
    expect(badges).toContain('money');
  });

  test('groups by difficulty with starters first', () => {
    const cb = makeCallbacks();
    const handle = createWelcome(cb, SAMPLE);
    handle.show();
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;

    const headings = Array.from(root.querySelectorAll<HTMLElement>('.koi-welcome-group-title')).map((h) =>
      (h.textContent ?? '').toLowerCase(),
    );
    // Only difficulties that have at least one matching template appear, in canonical order.
    expect(headings).toEqual(['starter', 'intermediate', 'advanced']);
  });

  test('the search input filters the rendered cards', () => {
    const cb = makeCallbacks();
    const handle = createWelcome(cb, SAMPLE);
    handle.show();
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;

    const search = root.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(search).not.toBeNull();
    // labelled search box
    const label = root.querySelector<HTMLLabelElement>('label[for="' + search.id + '"]');
    expect(label).not.toBeNull();

    setSearch(root, 'state-machine');
    expect(cardNames(root).sort()).toEqual(['Library', 'Ordering']);
  });

  test('a difficulty chip toggles the filter and reflects aria-pressed', () => {
    const cb = makeCallbacks();
    const handle = createWelcome(cb, SAMPLE);
    handle.show();
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;

    const chip = Array.from(root.querySelectorAll<HTMLButtonElement>('.koi-welcome-chip')).find(
      (b) => b.dataset.kind === 'difficulty' && b.dataset.value === 'advanced',
    )!;
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    chip.click();
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(cardNames(root)).toEqual(['SaaS Subscription']);

    chip.click(); // toggle off restores all
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    expect(cardNames(root).length).toBe(SAMPLE.length);
  });

  test('a tag chip exists for the union of tags and filters by it', () => {
    const cb = makeCallbacks();
    const handle = createWelcome(cb, SAMPLE);
    handle.show();
    const root = document.querySelector<HTMLElement>('.koi-welcome')!;

    const tagChips = Array.from(root.querySelectorAll<HTMLButtonElement>('.koi-welcome-chip[data-kind="tag"]')).map(
      (b) => b.dataset.value,
    );
    // union of all tags across SAMPLE
    expect(new Set(tagChips)).toEqual(new Set(['money', 'orders', 'state-machine', 'ddd', 'saas']));

    const dddChip = Array.from(root.querySelectorAll<HTMLButtonElement>('.koi-welcome-chip')).find(
      (b) => b.dataset.kind === 'tag' && b.dataset.value === 'ddd',
    )!;
    dddChip.click();
    expect(cardNames(root).sort()).toEqual(['Library', 'SaaS Subscription']);
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

// The search input is debounced; tests enable fake timers and flush the debounce window.
function setSearch(root: HTMLElement, value: string): void {
  vi.useFakeTimers();
  const input = root.querySelector<HTMLInputElement>('input[type="search"]')!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  vi.advanceTimersByTime(200);
  vi.useRealTimers();
}
