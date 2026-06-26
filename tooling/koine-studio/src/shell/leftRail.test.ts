// Tests for leftRailMarkup() — the single source of truth for the left rail's inner markup (#453).
// The rail is a Domain·Files axis switch over one navigator host plus a slim docs footer; the former
// Files/Explorer/Overview/Documentation section stack (and the Overview surface) is gone. This pins the
// shape the controller and ide.tsx boot inject + query, so a drift here fails fast.
import { describe, it, expect } from 'vitest';
import { leftRailMarkup } from '@/shell/leftRail';

describe('leftRailMarkup', () => {
  it('rail has a Domain·Files switch, no Explorer/Overview, ADR·Notes footer', () => {
    document.body.innerHTML = leftRailMarkup();
    const axes = [...document.querySelectorAll('#rail-axis-switch [data-axis]')].map((b) => b.textContent);
    expect(axes).toEqual(['Domain', 'Files']);
    expect(document.body.textContent).not.toMatch(/Explorer|Overview/);
    expect([...document.querySelectorAll('#rail-docs-body .koi-doclink-label')].map((n) => n.textContent)).toEqual([
      'ADR',
      'Notes',
    ]);
  });
});
