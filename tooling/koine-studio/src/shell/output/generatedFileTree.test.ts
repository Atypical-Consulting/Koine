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
    expect(child.closest('[hidden]')).toBeNull();

    folder.click();
    expect(folder.getAttribute('aria-expanded')).toBe('false');
    expect(child.closest('[hidden]')).not.toBeNull();

    folder.click();
    expect(folder.getAttribute('aria-expanded')).toBe('true');
    expect(child.closest('[hidden]')).toBeNull();
  });

  it('setFiles rebuilds the tree from scratch, dropping any prior selection/collapse state', () => {
    const { element, setFiles } = createGeneratedFileTree({ onSelect: () => {} });
    setFiles(sampleFiles());
    element.querySelector<HTMLElement>('[data-path="Program.cs"]')!.click();

    setFiles([emitFile('Only.cs')]);

    expect(element.querySelector('[data-path="Program.cs"]')).toBeNull();
    const only = element.querySelector<HTMLElement>('[data-path="Only.cs"]')!;
    expect(only.getAttribute('aria-selected')).toBe('false');
  });

  describe('selectPath', () => {
    it('marks the file at path selected WITHOUT firing onSelect, and returns true', () => {
      const onSelect = vi.fn();
      const { element, setFiles, selectPath } = createGeneratedFileTree({ onSelect });
      setFiles(sampleFiles());

      const result = selectPath('Billing/ValueObjects/Money.cs');

      expect(result).toBe(true);
      expect(onSelect).not.toHaveBeenCalled();
      const money = element.querySelector<HTMLElement>('[data-path="Billing/ValueObjects/Money.cs"]')!;
      expect(money.getAttribute('aria-selected')).toBe('true');
      // its ancestor folders must be expanded so the newly-selected file stays visible
      expect(money.closest('[hidden]')).toBeNull();
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

  it('has no accessibility violations', async () => {
    const { element, setFiles } = createGeneratedFileTree({ onSelect: () => {} });
    setFiles(sampleFiles());
    document.body.appendChild(element);

    expect(await axe(element)).toHaveNoViolations();
  });
});
