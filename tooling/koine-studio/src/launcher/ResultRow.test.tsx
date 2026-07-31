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
// contain one. No `listbox`-owned role (including `role="group"`, wrapping the pair) dodges this:
// axe's `aria-required-children` walks straight through `group`, so the button still surfaces as a
// disallowed listbox-owned element. `role="gridcell"` (`ResultRow.tsx`'s `.lx-opt`) has neither
// restriction, so `LauncherPanel.tsx`'s results list is a `role="grid"` of `role="row"`s instead —
// wrap it the same way here so the isolated unit render matches production and doesn't also trip
// `aria-required-parent` (a harness artifact, not part of this bug).
function renderInGrid(selected: boolean) {
  return render(
    <div role="grid">
      <ResultRow result={result} selected={selected} onOpenMenu={() => {}} />
    </div>,
  );
}

describe('ResultRow a11y — nested-interactive (#1673)', () => {
  it('the selected row with a quick-action button is axe-clean', async () => {
    const { container } = renderInGrid(true);

    expect(container.querySelector('.lx-actbtn')).toBeTruthy();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('the row is role="row" owning a role="gridcell" — never role="option" (regression guard)', () => {
    const { container } = renderInGrid(true);

    expect(container.querySelector('[role="option"]')).toBeNull();
    const row = container.querySelector('[role="row"]') as HTMLElement;
    expect(row).toBeTruthy();
    const cell = row.querySelector('[role="gridcell"]') as HTMLElement;
    expect(cell).toBeTruthy();
    expect(cell.querySelector('.lx-actbtn')).toBeTruthy();
  });
});
