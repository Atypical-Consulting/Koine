import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { EmitFile } from '@/lsp/protocol';
import { createGeneratedFileTree } from '@/shell/output/generatedFileTree';

afterEach(() => {
  document.body.innerHTML = '';
});

function emitFile(path: string, contents = `// ${path}`): EmitFile {
  return { path, contents };
}

// Billing/ (folder) > ValueObjects/ (folder) > Money.cs (file); Billing/ > Order.cs (file);
// Program.cs (file) at the root — 5 nodes total (2 folders + 3 files), matching fileTree.test.ts's
// own fixture shape (task 1) so both tests describe the same tree.
function sampleFiles(): EmitFile[] {
  return [emitFile('Billing/ValueObjects/Money.cs'), emitFile('Billing/Order.cs'), emitFile('Program.cs')];
}

function treeitems(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>('[role="treeitem"]'));
}

/** Whether a row is collapsed away per the CSS-driven contract (#1366): some ANCESTOR folder row carries
 *  `aria-expanded="false"` — the exact DOM state the stylesheet's
 *  `[role="treeitem"][aria-expanded="false"] > [role="group"] { display: none; }` rule keys off.
 *  (vitest/happy-dom doesn't apply real CSS cascade, so tests assert the attribute state the rule reads.)
 *  Ancestor-only on purpose: a collapsed folder's OWN row stays visible — only its descendants hide. */
function collapsedAway(el: HTMLElement): boolean {
  return Boolean(el.parentElement?.closest('[role="treeitem"][aria-expanded="false"]'));
}

describe('createGeneratedFileTree', () => {
  it('renders a [role="tree"] with one [role="treeitem"] per tree node', () => {
    const { element, setFiles } = createGeneratedFileTree({ onSelect: () => {} });
    setFiles(sampleFiles());

    expect(element.querySelector('[role="tree"]')).toBeTruthy();
    expect(treeitems(element)).toHaveLength(5); // Billing, ValueObjects, Money.cs, Order.cs, Program.cs
  });

  it('clicking a file treeitem calls onSelect with its path and marks it aria-selected', () => {
    const onSelect = vi.fn();
    const { element, setFiles } = createGeneratedFileTree({ onSelect });
    setFiles(sampleFiles());

    const file = element.querySelector<HTMLElement>('[data-path="Billing/Order.cs"]')!;
    expect(file.getAttribute('aria-selected')).toBe('false');

    file.click();

    expect(onSelect).toHaveBeenCalledExactlyOnceWith('Billing/Order.cs');
    expect(file.getAttribute('aria-selected')).toBe('true');
  });

  // Code-review fix: `buildRow` sets `li.textContent` directly (no wrapping element), so a row's label is
  // a bare Text node. In Firefox a real mouse click landing on rendered text sets `event.target` to that
  // Text node, which has no `.closest` — `currentTreeItem` used to call `.closest` on it unconditionally,
  // throwing a TypeError. Dispatching the click ON the text node itself (not the row) reproduces that
  // exact target shape.
  it('a click whose target is a row\'s bare text node (Firefox quirk) does not throw and still selects it', () => {
    const onSelect = vi.fn();
    const { element, setFiles } = createGeneratedFileTree({ onSelect });
    setFiles(sampleFiles());

    const file = element.querySelector<HTMLElement>('[data-path="Billing/Order.cs"]')!;
    const textNode = file.firstChild!;
    expect(textNode.nodeType).toBe(Node.TEXT_NODE);

    expect(() => {
      textNode.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }).not.toThrow();

    expect(onSelect).toHaveBeenCalledExactlyOnceWith('Billing/Order.cs');
    expect(file.getAttribute('aria-selected')).toBe('true');
  });

  it('clicking a file treeitem clears any previously selected file (single selection)', () => {
    const onSelect = vi.fn();
    const { element, setFiles } = createGeneratedFileTree({ onSelect });
    setFiles(sampleFiles());

    const order = element.querySelector<HTMLElement>('[data-path="Billing/Order.cs"]')!;
    const program = element.querySelector<HTMLElement>('[data-path="Program.cs"]')!;

    order.click();
    program.click();

    expect(order.getAttribute('aria-selected')).toBe('false');
    expect(program.getAttribute('aria-selected')).toBe('true');
  });

  it('clicking a folder toggles aria-expanded and hides/reveals its children', () => {
    const { element, setFiles } = createGeneratedFileTree({ onSelect: () => {} });
    setFiles(sampleFiles());

    const folder = element.querySelector<HTMLElement>('[data-path="Billing"]')!;
    const child = element.querySelector<HTMLElement>('[data-path="Billing/Order.cs"]')!;
    expect(folder.getAttribute('aria-expanded')).toBe('true');
    expect(collapsedAway(child)).toBe(false);

    folder.click();
    expect(folder.getAttribute('aria-expanded')).toBe('false');
    expect(collapsedAway(child)).toBe(true);

    folder.click();
    expect(folder.getAttribute('aria-expanded')).toBe('true');
    expect(collapsedAway(child)).toBe(false);
  });

  // #1366: child visibility is CSS-driven from `aria-expanded` alone — collapsing must NOT write the old
  // `.hidden` dual-write onto the child `<ul role="group">`; the stylesheet's
  // `.generated-file-tree [role="treeitem"][aria-expanded="false"] > [role="group"]` rule owns hiding.
  it('collapsing a folder writes aria-expanded only — never [hidden] on its child group', () => {
    const { element, setFiles } = createGeneratedFileTree({ onSelect: () => {} });
    setFiles(sampleFiles());

    element.querySelector<HTMLElement>('[data-path="Billing"]')!.click(); // collapse Billing/

    expect(element.querySelector('[role="group"][hidden]')).toBeNull();
  });

  it('setFiles rebuilds the tree from scratch, dropping any prior selection', () => {
    const { element, setFiles } = createGeneratedFileTree({ onSelect: () => {} });
    setFiles(sampleFiles());
    element.querySelector<HTMLElement>('[data-path="Program.cs"]')!.click();

    setFiles([emitFile('Only.cs')]);

    expect(element.querySelector('[data-path="Program.cs"]')).toBeNull();
    const only = element.querySelector<HTMLElement>('[data-path="Only.cs"]')!;
    expect(only.getAttribute('aria-selected')).toBe('false');
  });

  // Code-review fix: setFiles is called on EVERY successful emit, including a live-edit re-emit
  // (surfaceLoaders.tsx's loadPreview, ~350ms after any keystroke while this panel is visible) — a
  // manually collapsed folder must not snap back open on essentially every edit.
  it('setFiles preserves a still-existing folder\'s collapsed state across a rebuild', () => {
    const { element, setFiles } = createGeneratedFileTree({ onSelect: () => {} });
    setFiles(sampleFiles());

    const folder = element.querySelector<HTMLElement>('[data-path="Billing"]')!;
    folder.click(); // collapse Billing/
    expect(folder.getAttribute('aria-expanded')).toBe('false');

    // A live re-emit: the same files, plus an unrelated new one.
    setFiles([...sampleFiles(), emitFile('New.cs')]);

    const rebuiltFolder = element.querySelector<HTMLElement>('[data-path="Billing"]')!;
    expect(rebuiltFolder.getAttribute('aria-expanded')).toBe('false');
    const child = element.querySelector<HTMLElement>('[data-path="Billing/Order.cs"]')!;
    expect(collapsedAway(child)).toBe(true);
    // The unrelated new node is unaffected — still visible.
    expect(collapsedAway(element.querySelector<HTMLElement>('[data-path="New.cs"]')!)).toBe(false);
  });

  it('a folder path that no longer exists after setFiles simply loses its (moot) collapsed state', () => {
    const { element, setFiles } = createGeneratedFileTree({ onSelect: () => {} });
    setFiles(sampleFiles());
    element.querySelector<HTMLElement>('[data-path="Billing"]')!.click(); // collapse Billing/

    setFiles([emitFile('Only.cs')]); // Billing/ (and everything under it) no longer exists

    expect(element.querySelector('[data-path="Billing"]')).toBeNull();
    expect(element.querySelector<HTMLElement>('[data-path="Only.cs"]')).toBeTruthy();
  });

  describe('selectPath', () => {
    it('marks the file at path selected WITHOUT firing onSelect, and returns true', () => {
      const onSelect = vi.fn();
      const { element, setFiles, selectPath } = createGeneratedFileTree({ onSelect });
      setFiles(sampleFiles());
      // Collapse Billing/ first so selectPath's ancestor re-expansion is actually exercised.
      element.querySelector<HTMLElement>('[data-path="Billing"]')!.click();

      const result = selectPath('Billing/ValueObjects/Money.cs');

      expect(result).toBe(true);
      expect(onSelect).not.toHaveBeenCalled();
      const money = element.querySelector<HTMLElement>('[data-path="Billing/ValueObjects/Money.cs"]')!;
      expect(money.getAttribute('aria-selected')).toBe('true');
      // its ancestor folders must be (re-)expanded so the newly-selected file stays visible
      expect(collapsedAway(money)).toBe(false);
    });

    it('returns false for a path absent from the current tree', () => {
      const { setFiles, selectPath } = createGeneratedFileTree({ onSelect: () => {} });
      setFiles(sampleFiles());

      expect(selectPath('Nope.cs')).toBe(false);
    });
  });

  describe('keyboard navigation', () => {
    it('ArrowDown/ArrowUp move the roving tab stop across visible treeitems', () => {
      const { element, setFiles } = createGeneratedFileTree({ onSelect: () => {} });
      setFiles(sampleFiles());
      document.body.appendChild(element);

      const items = treeitems(element);
      expect(items.filter((it) => it.tabIndex === 0)).toEqual([items[0]]);

      items[0].focus();
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      expect(document.activeElement).toBe(items[1]);

      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      expect(document.activeElement).toBe(items[0]);
    });

    it('Enter toggles a focused folder treeitem', () => {
      const { element, setFiles } = createGeneratedFileTree({ onSelect: () => {} });
      setFiles(sampleFiles());
      document.body.appendChild(element);

      const folder = element.querySelector<HTMLElement>('[data-path="Billing"]')!;
      folder.focus();
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

      expect(folder.getAttribute('aria-expanded')).toBe('false');
    });

    // Code-review fix: ArrowRight/ArrowLeft previously no-op'd entirely (navFor's RovingTreeNav omitted
    // expand/collapse) even though folders here ARE collapsible via click/Enter/Space — mirrors
    // ExplorerPanel.tsx's expand()/collapse() convention (this codebase's OTHER tree with real collapsible
    // folders) exactly: ArrowRight on a closed folder expands it in place; on an already-open one it steps
    // into its first child instead. ArrowLeft is the symmetric collapse-or-ascend.
    it('ArrowRight expands a collapsed folder in place, leaving focus on it', () => {
      const { element, setFiles } = createGeneratedFileTree({ onSelect: () => {} });
      setFiles(sampleFiles());
      document.body.appendChild(element);

      const folder = element.querySelector<HTMLElement>('[data-path="Billing"]')!;
      folder.click(); // collapse it first
      expect(folder.getAttribute('aria-expanded')).toBe('false');

      folder.focus();
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

      expect(folder.getAttribute('aria-expanded')).toBe('true');
      expect(document.activeElement).toBe(folder);
    });

    it('ArrowRight on an already-expanded folder moves focus to its first child', () => {
      const { element, setFiles } = createGeneratedFileTree({ onSelect: () => {} });
      setFiles(sampleFiles());
      document.body.appendChild(element);

      const folder = element.querySelector<HTMLElement>('[data-path="Billing"]')!;
      const firstChild = element.querySelector<HTMLElement>('[data-path="Billing/ValueObjects"]')!;
      folder.focus();
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

      expect(document.activeElement).toBe(firstChild);
    });

    it('ArrowLeft collapses an open folder in place, leaving focus on it', () => {
      const { element, setFiles } = createGeneratedFileTree({ onSelect: () => {} });
      setFiles(sampleFiles());
      document.body.appendChild(element);

      const folder = element.querySelector<HTMLElement>('[data-path="Billing"]')!;
      folder.focus();
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));

      expect(folder.getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(folder);
    });

    // #1366 regression lock: a collapsed folder's OWN row must stay keyboard-reachable — only its
    // DESCENDANTS leave the visible set. The reachability predicate must therefore test ANCESTORS only:
    // the naive `el.closest('[aria-expanded="false"]')` would match the collapsed folder's own row
    // (`closest` tests the element itself before its ancestors) and wrongly drop it from the
    // roving-tabindex/arrow-nav set.
    it("a collapsed folder's own row stays keyboard-reachable while its children are skipped", () => {
      const { element, setFiles } = createGeneratedFileTree({ onSelect: () => {} });
      setFiles(sampleFiles());
      document.body.appendChild(element);

      const folder = element.querySelector<HTMLElement>('[data-path="Billing"]')!;
      folder.click(); // collapse Billing/
      expect(folder.getAttribute('aria-expanded')).toBe('false');

      // The collapsed folder itself keeps the roving tab stop — its own row is still visible/reachable.
      expect(folder.tabIndex).toBe(0);

      // ArrowDown from it skips its collapsed-away children, landing on the next VISIBLE row …
      folder.focus();
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      const program = element.querySelector<HTMLElement>('[data-path="Program.cs"]')!;
      expect(document.activeElement).toBe(program);

      // … and ArrowUp from that row comes straight back to the collapsed folder's own row.
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      expect(document.activeElement).toBe(folder);
    });

    it('ArrowLeft on a file row ascends focus to its parent folder', () => {
      const { element, setFiles } = createGeneratedFileTree({ onSelect: () => {} });
      setFiles(sampleFiles());
      document.body.appendChild(element);

      const file = element.querySelector<HTMLElement>('[data-path="Billing/Order.cs"]')!;
      file.focus();
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));

      const folder = element.querySelector<HTMLElement>('[data-path="Billing"]')!;
      expect(document.activeElement).toBe(folder);
    });

    it('Space selects a focused file treeitem', () => {
      const onSelect = vi.fn();
      const { element, setFiles } = createGeneratedFileTree({ onSelect });
      setFiles(sampleFiles());
      document.body.appendChild(element);

      const file = element.querySelector<HTMLElement>('[data-path="Program.cs"]')!;
      file.focus();
      element.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));

      expect(onSelect).toHaveBeenCalledExactlyOnceWith('Program.cs');
      expect(file.getAttribute('aria-selected')).toBe('true');
    });
  });

  // ADR-0009 scope emphasis over the tree's TOP-LEVEL (bounded-context) rows — owned by the tree itself
  // (#1363; the logic previously lived in outputRail.ts's applyOutputTreeEmphasis, reaching into this
  // widget's DOM from outside). Scenarios ported verbatim from outputRail.test.ts's emphasis block.
  describe('emphasizeTopLevel (ADR 0009)', () => {
    // Three top-level entries (two bounded-context folders + the shared runtime folder) — the shape the
    // scope emphasis operates over.
    function scopedFiles(): EmitFile[] {
      return [
        emitFile('Ordering/Order.cs'),
        emitFile('Ordering/Money.cs'),
        emitFile('Kitchen/Ticket.cs'),
        emitFile('runtime/KoineRuntime.cs'),
      ];
    }
    const topLevel = (el: HTMLElement): HTMLElement[] =>
      Array.from(el.querySelectorAll<HTMLElement>('[role="treeitem"][aria-level="1"]'));
    const byPath = (el: HTMLElement, path: string): HTMLElement =>
      topLevel(el).find((e) => e.dataset.path === path) as HTMLElement;

    it('emphasises the matching top-level node and de-emphasises the rest — never hiding any', () => {
      const { element, setFiles, emphasizeTopLevel } = createGeneratedFileTree({ onSelect: () => {} });
      setFiles(scopedFiles());

      emphasizeTopLevel('Ordering');
      // Every top-level row is still rendered — emphasis, not hiding (the whole-model overview survives).
      expect(topLevel(element)).toHaveLength(3); // Ordering, Kitchen, runtime (folders, one per top-level path)

      expect(byPath(element, 'Ordering').classList.contains('on')).toBe(true);
      expect(byPath(element, 'Ordering').classList.contains('dim')).toBe(false);
      expect(byPath(element, 'Kitchen').classList.contains('dim')).toBe(true);
      expect(byPath(element, 'Kitchen').classList.contains('on')).toBe(false);
      expect(byPath(element, 'runtime').classList.contains('dim')).toBe(true);
      expect(byPath(element, 'runtime').classList.contains('on')).toBe(false);

      // WCAG AA non-color signal (ADR 0009): the active scope must not rely on color/hue alone.
      expect(byPath(element, 'Ordering').getAttribute('aria-current')).toBe('true');
      expect(byPath(element, 'Kitchen').getAttribute('aria-current')).toBeNull();
      expect(byPath(element, 'runtime').getAttribute('aria-current')).toBeNull();
    });

    it('All contexts (activeContext null) leaves every top-level node plain', () => {
      const { element, setFiles, emphasizeTopLevel } = createGeneratedFileTree({ onSelect: () => {} });
      setFiles(scopedFiles());

      emphasizeTopLevel(null);
      for (const el of topLevel(element)) {
        expect(el.classList.contains('on')).toBe(false);
        expect(el.classList.contains('dim')).toBe(false);
        expect(el.getAttribute('aria-current')).toBeNull();
      }
    });

    it('a scope matching no top-level node emphasises nothing — a graceful no-op', () => {
      const { element, setFiles, emphasizeTopLevel } = createGeneratedFileTree({ onSelect: () => {} });
      setFiles(scopedFiles());

      emphasizeTopLevel('Shipping'); // no Shipping/ output
      for (const el of topLevel(element)) {
        expect(el.classList.contains('on')).toBe(false);
        expect(el.classList.contains('dim')).toBe(false); // NOT the whole tree dimmed
        expect(el.getAttribute('aria-current')).toBeNull();
      }
    });

    it('re-applying with a different context clears the previous emphasis first', () => {
      const { element, setFiles, emphasizeTopLevel } = createGeneratedFileTree({ onSelect: () => {} });
      setFiles(scopedFiles());

      emphasizeTopLevel('Ordering');
      emphasizeTopLevel('Kitchen');
      expect(byPath(element, 'Ordering').classList.contains('on')).toBe(false);
      expect(byPath(element, 'Ordering').classList.contains('dim')).toBe(true);
      expect(byPath(element, 'Kitchen').classList.contains('on')).toBe(true);
      expect(byPath(element, 'Kitchen').classList.contains('dim')).toBe(false);
      expect(byPath(element, 'Ordering').getAttribute('aria-current')).toBeNull();
      expect(byPath(element, 'Kitchen').getAttribute('aria-current')).toBe('true');
    });
  });

  it('has no accessibility violations', async () => {
    const { element, setFiles } = createGeneratedFileTree({ onSelect: () => {} });
    setFiles(sampleFiles());
    document.body.appendChild(element);

    expect(await axe(element)).toHaveNoViolations();
  });
});
