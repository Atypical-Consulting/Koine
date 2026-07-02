// Tests for domIds — the single-source-of-truth DOM contract shared by @atypical/koine-ui's create
// side (LeftRail.tsx / RightStrip.tsx JSX) and koine-studio's query side (ide.tsx /
// inspectorController.tsx / layout.ts). Suite (a) pins every constant to today's exact literal so a
// rename can't drift the two sides apart silently; suite (b) renders the components (reusing the mount
// idiom from LeftRail.test.tsx / RightStrip.test.tsx) and proves every contract point resolves against
// the real DOM the create side emits.
import { afterEach, describe, it, expect } from 'vitest';
import { render } from 'preact';
import {
  LEFT_RAIL_IDS,
  DATA_AXIS,
  DATA_LAXIS,
  DATA_LEXPAND,
  DATA_RVIEW,
  RSTRIP_BTN_CLASS,
  RIGHT_STRIP_VIEWS,
  byId,
  axisButtonsSelector,
  lstripAxisButtonsSelector,
} from './domIds';
import { LeftRail } from './components/LeftRail';
import { RightStrip } from './components/RightStrip';

afterEach(() => {
  document.body.innerHTML = '';
});

/** Render LeftRail into its real #leftrail host (mirrors LeftRail.test.tsx's mountRail). */
function mountRail(): void {
  document.body.innerHTML = `<aside id="leftrail" class="pane" aria-label="Workspace"></aside>`;
  render(<LeftRail />, document.getElementById('leftrail')!);
}

/** Render RightStrip into its real #right-strip toolbar shell (mirrors RightStrip.test.tsx's mountStrip). */
function mountStrip(): void {
  document.body.innerHTML =
    `<aside id="right" aria-label="Properties"></aside>` +
    `<div id="right-strip" role="toolbar" aria-label="Tool windows" aria-orientation="vertical"></div>`;
  render(<RightStrip />, document.getElementById('right-strip')!);
}

describe('domIds — literal pins', () => {
  it('LEFT_RAIL_IDS equal today exact rendered strings', () => {
    expect(LEFT_RAIL_IDS.axisSwitch).toBe('rail-axis-switch');
    expect(LEFT_RAIL_IDS.collapse).toBe('rail-collapse');
    expect(LEFT_RAIL_IDS.domainPane).toBe('rail-domain-pane');
    expect(LEFT_RAIL_IDS.filesPane).toBe('rail-files');
    expect(LEFT_RAIL_IDS.filetreeTitle).toBe('filetree-title');
    expect(LEFT_RAIL_IDS.filetreeBody).toBe('filetree-body');
    expect(LEFT_RAIL_IDS.leftStrip).toBe('left-strip');
  });

  it('data-attribute + class constants equal today exact rendered strings', () => {
    expect(DATA_AXIS).toBe('data-axis');
    expect(DATA_LAXIS).toBe('data-laxis');
    expect(DATA_LEXPAND).toBe('data-lexpand');
    expect(DATA_RVIEW).toBe('data-rview');
    expect(RSTRIP_BTN_CLASS).toBe('rstrip-btn');
  });

  it('RIGHT_STRIP_VIEWS deep-equals the right-rail view order', () => {
    expect(RIGHT_STRIP_VIEWS).toEqual(['props', 'assistant', 'source-control']);
  });

  it('the selector builders compose the pinned ids/attrs', () => {
    expect(byId('x')).toBe('#x');
    expect(axisButtonsSelector).toBe('#rail-axis-switch [data-axis]');
    expect(lstripAxisButtonsSelector).toBe('#left-strip [data-laxis]');
  });
});

describe('domIds — create-side tie', () => {
  it('every LEFT_RAIL_IDS id resolves in the LeftRail DOM', () => {
    mountRail();
    for (const id of Object.values(LEFT_RAIL_IDS)) {
      expect(document.getElementById(id), id).not.toBeNull();
    }
  });

  it('the axis selectors resolve the two Domain/Files buttons on both the switch and the spine', () => {
    mountRail();
    expect(document.querySelectorAll(axisButtonsSelector)).toHaveLength(2);
    expect(document.querySelectorAll(lstripAxisButtonsSelector)).toHaveLength(2);
  });

  it('the right strip emits one rstrip-btn per RIGHT_STRIP_VIEWS', () => {
    mountStrip();
    const buttons = [...document.querySelectorAll<HTMLElement>('.' + RSTRIP_BTN_CLASS + '[' + DATA_RVIEW + ']')];
    expect(buttons).toHaveLength(3);
    const views = new Set(buttons.map((b) => b.getAttribute(DATA_RVIEW)));
    expect(views).toEqual(new Set(RIGHT_STRIP_VIEWS));
  });
});
