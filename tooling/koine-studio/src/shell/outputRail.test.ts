import { describe, expect, test } from 'vitest';
import { applyOutputTreeEmphasis, ensureOutputScaffold, renderOutputCrumb } from '@/shell/outputRail';
import { createGeneratedFileTree } from '@/shell/output/generatedFileTree';
import type { EmitFile } from '@/lsp/protocol';

function host(): HTMLElement {
  const el = document.createElement('div');
  el.id = 'view-preview';
  document.body.appendChild(el);
  return el;
}

const FILES: EmitFile[] = [
  { path: 'Ordering/Order.cs', contents: 'x'.repeat(74) },
  { path: 'Ordering/Money.cs', contents: 'x'.repeat(46) },
  { path: 'Kitchen/Ticket.cs', contents: 'x'.repeat(61) },
  { path: 'runtime/KoineRuntime.cs', contents: 'x'.repeat(112) },
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

describe('applyOutputTreeEmphasis (ADR 0009) — replaces renderOutputRail\'s scope emphasis over the tree', () => {
  // Builds a real generated-file tree (via the Task 2 widget) over FILES so these tests exercise the
  // actual top-level treeitem shape (`[role="treeitem"][aria-level="1"]`, keyed by `data-path`) rather
  // than a hand-rolled fixture.
  function tree(): HTMLElement {
    const t = createGeneratedFileTree({ onSelect: () => {} });
    t.setFiles(FILES);
    return t.element;
  }
  const topLevel = (root: HTMLElement): HTMLElement[] =>
    Array.from(root.querySelectorAll<HTMLElement>('[role="treeitem"][aria-level="1"]'));
  const byPath = (root: HTMLElement, path: string): HTMLElement =>
    topLevel(root).find((e) => e.dataset.path === path) as HTMLElement;

  test('emphasises the matching top-level node and de-emphasises the rest — never hiding any', () => {
    const root = tree();
    applyOutputTreeEmphasis(root, 'Ordering');
    // Every top-level row is still rendered — emphasis, not hiding (the whole-model overview survives).
    expect(topLevel(root)).toHaveLength(3); // Ordering, Kitchen, runtime (folders, one per top-level path)

    expect(byPath(root, 'Ordering').classList.contains('on')).toBe(true);
    expect(byPath(root, 'Ordering').classList.contains('dim')).toBe(false);
    expect(byPath(root, 'Kitchen').classList.contains('dim')).toBe(true);
    expect(byPath(root, 'Kitchen').classList.contains('on')).toBe(false);
    expect(byPath(root, 'runtime').classList.contains('dim')).toBe(true);
    expect(byPath(root, 'runtime').classList.contains('on')).toBe(false);
  });

  test('All contexts (activeContext null) leaves every top-level node plain', () => {
    const root = tree();
    applyOutputTreeEmphasis(root, null);
    for (const el of topLevel(root)) {
      expect(el.classList.contains('on')).toBe(false);
      expect(el.classList.contains('dim')).toBe(false);
    }
  });

  test('a scope matching no top-level node emphasises nothing — a graceful no-op', () => {
    const root = tree();
    applyOutputTreeEmphasis(root, 'Shipping'); // no Shipping/ output
    for (const el of topLevel(root)) {
      expect(el.classList.contains('on')).toBe(false);
      expect(el.classList.contains('dim')).toBe(false); // NOT the whole tree dimmed
    }
  });

  test('re-applying with a different context clears the previous emphasis first', () => {
    const root = tree();
    applyOutputTreeEmphasis(root, 'Ordering');
    applyOutputTreeEmphasis(root, 'Kitchen');
    expect(byPath(root, 'Ordering').classList.contains('on')).toBe(false);
    expect(byPath(root, 'Ordering').classList.contains('dim')).toBe(true);
    expect(byPath(root, 'Kitchen').classList.contains('on')).toBe(true);
    expect(byPath(root, 'Kitchen').classList.contains('dim')).toBe(false);
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
