import { afterEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { render } from '@testing-library/preact';
import { ResultRow } from '@/launcher/ResultRow';
import type { CatalogEntry } from '@/launcher/catalog';
import type { RankedResult } from '@/launcher/fuzzy';

afterEach(() => {
  document.body.innerHTML = '';
});

const symbolEntry: CatalogEntry = {
  id: 'sym:Ordering.Order',
  cat: 'symbol',
  kind: 'aggregate',
  title: 'Order',
  sub: 'aggregate',
  ctx: 'Ordering',
};

const result: RankedResult = { entry: symbolEntry, score: 1, ranges: [] };

// #1673: the selected row's tail `.lx-actbtn` quick-action trigger used to render as a DOM
// descendant of the row's own `role="option"` node — axe's `nested-interactive` rule flags any
// focusable descendant of an `option`-role element, since `option` is a leaf role that must not
// contain one.
// `ResultRow` always renders as a child of `LauncherPanel.tsx`'s `role="listbox"` results list — wrap
// it the same way here so the isolated unit render doesn't also trip `aria-required-parent` (a
// harness artifact, not part of this bug) alongside the `nested-interactive` violation under test.
function renderInListbox(selected: boolean) {
  return render(
    <div role="listbox">
      <ResultRow result={result} selected={selected} onOpenMenu={() => {}} />
    </div>,
  );
}

describe('ResultRow a11y — nested-interactive (#1673)', () => {
  it('the selected row with a quick-action button is axe-clean', async () => {
    const { container } = renderInListbox(true);

    expect(container.querySelector('.lx-actbtn')).toBeTruthy();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('the quick-action button is not a descendant of the role="option" element', () => {
    const { container } = renderInListbox(true);

    const option = container.querySelector('[role="option"]') as HTMLElement;
    expect(option).toBeTruthy();
    expect(option.querySelector('.lx-actbtn')).toBeNull();
  });
});
