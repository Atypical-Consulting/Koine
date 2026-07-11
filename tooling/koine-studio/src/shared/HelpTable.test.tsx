import { describe, expect, test } from 'vitest';
import { render } from '@testing-library/preact';
import { axe } from 'vitest-axe';
import { ShortcutsTable } from '@/shared/HelpTable';
import { modKey } from '@/shared/platform';
import type { ShortcutRow } from '@/shared/help';

// Pins the table body previously built by help.ts's buildTable()/appendKeycaps() (imperative
// createElement) — now real JSX. The behavior to preserve: one .koi-help-table row per ShortcutRow,
// each chord split on '+' into one .koi-kbd keycap per segment, with a literal 'mod' segment rendered
// via the shared modKey() so it reads ⌘ on macOS / Ctrl elsewhere — exactly like the toolbar hint and
// command palette (`platform.ts`).
describe('ShortcutsTable', () => {
  const rows: ShortcutRow[] = [
    { keys: 'mod+Shift+O', description: 'Open a folder of models' },
    { keys: 'F1', description: 'Keyboard shortcuts' },
  ];

  test('renders a .koi-help-table with one row per shortcut', () => {
    const { container } = render(<ShortcutsTable rows={rows} />);
    expect(container.querySelector('table')?.className).toBe('koi-help-table');
    expect(container.querySelectorAll('tbody > tr')).toHaveLength(2);
  });

  test('a mod+Shift+O row renders three .koi-kbd keycaps, with mod platform-mapped', () => {
    const { container } = render(<ShortcutsTable rows={rows} />);
    const firstRow = container.querySelectorAll('tbody > tr')[0];
    const keycaps = firstRow.querySelectorAll('.koi-kbd');
    expect(keycaps).toHaveLength(3);
    expect(Array.from(keycaps).map((k) => k.textContent)).toEqual([modKey('mod'), 'Shift', 'O']);
    expect(firstRow.querySelector('td')?.textContent).not.toBe('');
    expect(firstRow.textContent).toContain('Open a folder of models');
  });

  test('a single-key row (no "+") renders exactly one keycap', () => {
    const { container } = render(<ShortcutsTable rows={rows} />);
    const secondRow = container.querySelectorAll('tbody > tr')[1];
    const keycaps = secondRow.querySelectorAll('.koi-kbd');
    expect(keycaps).toHaveLength(1);
    expect(keycaps[0].textContent).toBe('F1');
  });

  test('renders an empty tbody (no rows) without throwing', () => {
    const { container } = render(<ShortcutsTable rows={[]} />);
    expect(container.querySelectorAll('tbody > tr')).toHaveLength(0);
  });

  test('has no accessibility violations', async () => {
    const { container } = render(<ShortcutsTable rows={rows} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
