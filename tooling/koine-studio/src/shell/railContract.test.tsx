// Consumer-side contract test for the @atypical/koine-ui ⇄ koine-studio DOM contract (#979).
//
// domIds.test.tsx (in @atypical/koine-ui) pins the contract on the CREATE side, against the package's
// own source. This is the QUERY side's net: it renders the REAL koine-ui components — resolved through
// Studio's node_modules → the package's built dist/ — into the two index.html-shaped hosts Studio owns
// (#leftrail / #right-strip), then walks the exported contract and asserts every point Studio's
// imperative lookups depend on actually resolves. So a stale / miswired package build, or a future
// drift between the two sides, fails HERE in Studio's own suite rather than at runtime in the browser.
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { render } from 'preact';
import {
  LEFT_RAIL_IDS,
  RSTRIP_BTN_CLASS,
  DATA_RVIEW,
  RIGHT_STRIP_VIEWS,
  axisButtonsSelector,
  lstripAxisButtonsSelector,
  LeftRail,
  RightStrip,
} from '@atypical/koine-ui';
import { domById } from '@/shared/domById';

// The two Studio-owned hosts koine-ui renders INTO — lifted from index.html (#leftrail is the rail
// shell, #right-strip the tool-window stripe). These ids stay Studio-side literals: they are the
// boundary Studio provides, not part of the imported contract the package emits.
function seedHosts(): void {
  document.body.innerHTML =
    `<aside id="leftrail" class="pane" aria-label="Workspace"></aside>` +
    `<div id="right-strip" class="pane" role="toolbar" aria-label="Tool windows" aria-orientation="vertical"></div>`;
  // Render the real koine-ui components exactly as ide.tsx's boot does — LeftRail into #leftrail,
  // RightStrip into #right-strip — so the contract points are queried against the DOM the package emits.
  render(<LeftRail />, document.getElementById('leftrail')!);
  render(<RightStrip />, document.getElementById('right-strip')!);
}

beforeEach(() => {
  seedHosts();
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('railContract — koine-ui components satisfy the DOM contract Studio queries (#979)', () => {
  it('every LEFT_RAIL_IDS id resolves via domById in the rendered LeftRail DOM', () => {
    // domById throws on a missing id, so a resolving call IS the assertion; .not.toThrow() names the
    // offending id in the failure message if the package ever stops rendering one.
    for (const id of Object.values(LEFT_RAIL_IDS)) {
      expect(() => domById(id), id).not.toThrow();
    }
  });

  it('both axis selectors resolve the two Domain/Files buttons (switch + spine)', () => {
    expect(document.querySelectorAll(axisButtonsSelector)).toHaveLength(2);
    expect(document.querySelectorAll(lstripAxisButtonsSelector)).toHaveLength(2);
  });

  it('the right strip emits exactly one rstrip-btn per RIGHT_STRIP_VIEWS, with matching data-rview values', () => {
    const buttons = document.querySelectorAll<HTMLElement>('#right-strip .' + RSTRIP_BTN_CLASS);
    expect(buttons).toHaveLength(3);
    const views = new Set([...buttons].map((b) => b.getAttribute(DATA_RVIEW)));
    expect(views).toEqual(new Set(RIGHT_STRIP_VIEWS));
  });
});
