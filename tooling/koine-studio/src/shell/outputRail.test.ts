import { describe, expect, test, vi } from 'vitest';
import { ensureOutputScaffold, renderOutputCrumb, renderOutputRail, type OutputRailFile } from '@/shell/outputRail';

function host(): HTMLElement {
  const el = document.createElement('div');
  el.id = 'view-preview';
  document.body.appendChild(el);
  return el;
}

const FILES: OutputRailFile[] = [
  { path: 'Ordering/Order.cs', kind: 'aggregate', loc: 74 },
  { path: 'Ordering/Money.cs', kind: 'value', loc: 46 },
  { path: 'Kitchen/Ticket.cs', kind: 'aggregate', loc: 61 },
  { path: 'runtime/KoineRuntime.cs', kind: null, loc: 112 },
];

describe('ensureOutputScaffold', () => {
  test('builds the rail/crumb/code grid inside the host', () => {
    const previewEl = host();
    const s = ensureOutputScaffold(previewEl);
    expect(previewEl.querySelector('.out2')).not.toBeNull();
    expect(s.rail.classList.contains('out-rail')).toBe(true);
    expect(s.crumb.contains(s.crumbPath)).toBe(true);
    expect(s.crumb.contains(s.lang)).toBe(true);
    expect(s.code.classList.contains('out-code')).toBe(true);
  });

  test('is idempotent — a second call returns the same parts, not a duplicate grid', () => {
    const previewEl = host();
    const a = ensureOutputScaffold(previewEl);
    const b = ensureOutputScaffold(previewEl);
    expect(previewEl.querySelectorAll('.out2')).toHaveLength(1);
    expect(b.code).toBe(a.code);
  });
});

describe('renderOutputRail', () => {
  test('groups files by context (top-level folder) in first-seen order', () => {
    const s = ensureOutputScaffold(host());
    renderOutputRail(s, FILES, null, 'C#', () => {});
    const ctxs = Array.from(s.rail.querySelectorAll('.out-ctx')).map((e) => e.textContent);
    expect(ctxs).toEqual(['Ordering', 'Kitchen', 'runtime']);
    expect(s.rail.querySelectorAll('.out-file')).toHaveLength(4);
  });

  test('renders a head count, per-file line count, and tints the dot by DDD kind', () => {
    const s = ensureOutputScaffold(host());
    renderOutputRail(s, FILES, null, 'C#', () => {});
    expect(s.rail.querySelector('.out-railhead b')?.textContent).toBe('4 files');
    const first = s.rail.querySelector('.out-file') as HTMLElement;
    expect(first.querySelector('.fname')?.textContent).toBe('Order.cs'); // basename only
    expect(first.querySelector('.floc')?.textContent).toBe('74');
    expect(first.dataset.tip).toBe('Ordering/Order.cs'); // the tooltip carries the full path
    expect(first.dataset.key).toBe('74 lines');
    expect(first.style.getPropertyValue('--fc')).toContain('--koi-ddd-aggregate');
    // A file with no stereotype falls back to a neutral dot.
    const runtime = s.rail.querySelectorAll('.out-file')[3] as HTMLElement;
    expect(runtime.style.getPropertyValue('--fc')).toContain('--koi-muted');
  });

  test('marks the selected file and routes clicks', () => {
    const s = ensureOutputScaffold(host());
    const onSelect = vi.fn();
    renderOutputRail(s, FILES, 'Ordering/Money.cs', 'C#', onSelect);
    const on = s.rail.querySelectorAll('.out-file.on');
    expect(on).toHaveLength(1);
    expect((on[0] as HTMLElement).querySelector('.fname')?.textContent).toBe('Money.cs');
    (s.rail.querySelectorAll('.out-file')[2] as HTMLButtonElement).click();
    expect(onSelect).toHaveBeenCalledWith('Kitchen/Ticket.cs');
  });
});

describe('renderOutputRail — scope emphasis (ADR 0009)', () => {
  const ctxByName = (rail: HTMLElement, name: string): HTMLElement =>
    Array.from(rail.querySelectorAll('.out-ctx')).find(
      (e) => e.querySelector('.out-ctx-name')?.textContent === name,
    ) as HTMLElement;

  test('emphasises the active context group and de-emphasises the rest — never hiding any', () => {
    const s = ensureOutputScaffold(host());
    renderOutputRail(s, FILES, null, 'C#', () => {}, 'Ordering');
    // Every group + file is still rendered — emphasis, not hiding (the whole-model overview survives).
    expect(s.rail.querySelectorAll('.out-ctx')).toHaveLength(3);
    expect(s.rail.querySelectorAll('.out-file')).toHaveLength(4);

    const ordering = ctxByName(s.rail, 'Ordering');
    expect(ordering.classList.contains('on')).toBe(true);
    expect(ordering.classList.contains('dim')).toBe(false);
    // A non-colour active marker (its text) so the scope reads without relying on hue (WCAG AA).
    expect(ordering.querySelector('.out-ctx-active')?.textContent).toBe('active');
    expect(s.rail.querySelectorAll('.out-ctx-active')).toHaveLength(1); // only the active group

    expect(ctxByName(s.rail, 'Kitchen').classList.contains('dim')).toBe(true);
    expect(ctxByName(s.rail, 'runtime').classList.contains('dim')).toBe(true);

    // The active group's files stay plain; the other groups' files de-emphasise.
    const dimFiles = Array.from(s.rail.querySelectorAll('.out-file.dim')).map(
      (e) => (e as HTMLElement).querySelector('.fname')?.textContent,
    );
    expect(dimFiles).toEqual(['Ticket.cs', 'KoineRuntime.cs']);
  });

  test('All contexts (scope omitted) leaves every group plain', () => {
    const s = ensureOutputScaffold(host());
    renderOutputRail(s, FILES, null, 'C#', () => {}); // activeContext omitted → null
    expect(s.rail.querySelector('.out-ctx.on')).toBeNull();
    expect(s.rail.querySelector('.out-ctx.dim')).toBeNull();
    expect(s.rail.querySelector('.out-ctx-active')).toBeNull();
    expect(s.rail.querySelector('.out-file.dim')).toBeNull();
  });

  test('a scope matching no emitted group emphasises nothing — a graceful no-op', () => {
    const s = ensureOutputScaffold(host());
    renderOutputRail(s, FILES, null, 'C#', () => {}, 'Shipping'); // no Shipping/ output
    expect(s.rail.querySelector('.out-ctx.on')).toBeNull();
    expect(s.rail.querySelector('.out-ctx.dim')).toBeNull(); // NOT the whole rail dimmed
    expect(s.rail.querySelector('.out-ctx-active')).toBeNull();
    expect(s.rail.querySelector('.out-file.dim')).toBeNull();
  });
});

describe('renderOutputCrumb', () => {
  test('builds path segments (leaf marked) + a language chip', () => {
    const s = ensureOutputScaffold(host());
    renderOutputCrumb(s, 'Ordering/Money.cs', 'C#');
    const segs = Array.from(s.crumbPath.querySelectorAll('.seg')).map((e) => e.textContent);
    expect(segs).toEqual(['Ordering', 'Money.cs']);
    expect(s.crumbPath.querySelector('.seg.leaf')?.textContent).toBe('Money.cs');
    expect(s.lang.hidden).toBe(false);
    expect(s.lang.textContent).toBe('C#');
  });

  test('null path clears the crumb and hides the language chip', () => {
    const s = ensureOutputScaffold(host());
    renderOutputCrumb(s, 'Ordering/Money.cs', 'C#');
    renderOutputCrumb(s, null, '');
    expect(s.crumbPath.textContent).toBe('');
    expect(s.lang.hidden).toBe(true);
  });
});
