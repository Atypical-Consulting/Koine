import { describe, expect, test } from 'vitest';
import { ensureOutputScaffold, renderOutputCrumb, renderOutputRailHead } from '@/shell/outputRail';

function host(): HTMLElement {
  const el = document.createElement('div');
  el.id = 'view-preview';
  document.body.appendChild(el);
  return el;
}

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

  test('builds a railHead ("N files" count header) above the tree inside .out-rail', () => {
    const previewEl = host();
    const s = ensureOutputScaffold(previewEl);
    expect(s.railHead.classList.contains('out-railhead')).toBe(true);
    expect(s.rail.contains(s.railHead)).toBe(true);
  });

  test('.out-rail carries a static role="region" + aria-label (never bare of an accessible role/name, even before the tree has any of its own — fixes the tablist-containing-a-tree nesting without reintroducing the original "no role at all" gap)', () => {
    const previewEl = host();
    const s = ensureOutputScaffold(previewEl);
    expect(s.rail.getAttribute('role')).toBe('region');
    expect(s.rail.getAttribute('aria-label')).toBe('Generated files');
  });
});

describe('renderOutputRailHead', () => {
  test('shows the file count', () => {
    const s = ensureOutputScaffold(host());
    renderOutputRailHead(s, 12);
    expect(s.railHead.textContent).toBe('12 files');
  });

  test('singular file count has no trailing "s"', () => {
    const s = ensureOutputScaffold(host());
    renderOutputRailHead(s, 1);
    expect(s.railHead.textContent).toBe('1 file');
  });

  test('a zero count clears the header (the empty/error output states)', () => {
    const s = ensureOutputScaffold(host());
    renderOutputRailHead(s, 4);
    renderOutputRailHead(s, 0);
    expect(s.railHead.textContent).toBe('');
  });
});

// ADR-0009 scope emphasis over the tree's top-level rows moved INTO the tree widget itself (#1363):
// see `emphasizeTopLevel` in shell/output/generatedFileTree.ts and its tests in generatedFileTree.test.ts.

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
