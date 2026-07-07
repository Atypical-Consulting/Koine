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
