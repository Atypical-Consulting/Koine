import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the edge resizer so we can assert exactly how the layout controller wires (and re-wires) the
// inspector + left-rail handles, and that dispose() releases them — without driving real pointer drags.
const { resizerDisposers, initEdgeResizerMock } = vi.hoisted(() => {
  const resizerDisposers: Array<ReturnType<typeof vi.fn>> = [];
  const initEdgeResizerMock = vi.fn((_opts: { cssVar: string }) => {
    const dispose = vi.fn();
    resizerDisposers.push(dispose);
    return dispose;
  });
  return { resizerDisposers, initEdgeResizerMock };
});
vi.mock('@/shell/resize', () => ({ initEdgeResizer: initEdgeResizerMock }));

import { createLayoutController, type LayoutController, type LayoutControllerDeps } from '@/shell/layout';

// layout.ts subscribes to the appStore SINGLETON now (panelSide/sideRail live in the uiChrome slice),
// so an undisposed controller leaves a live subscription that a later test's toggle would re-fire —
// stacking extra wireRailResizers → initEdgeResizer calls and breaking the call-count assertions. Track
// every controller and dispose them after each test so the singleton subscription never leaks across `it`s.
const created: LayoutController[] = [];
function create(deps: LayoutControllerDeps): LayoutController {
  const ctrl = createLayoutController(deps);
  created.push(ctrl);
  return ctrl;
}

function mountLayoutDom(): void {
  document.body.innerHTML = `
    <div id="split">
      <div id="split-resizer"></div>
      <div id="leftrail-resizer"></div>
      <section id="rail-files" class="rail-sect" data-open="true">
        <button class="rail-sect-head" aria-expanded="true"></button>
      </section>
    </div>`;
}

function makeDeps(over: Partial<LayoutControllerDeps> = {}): LayoutControllerDeps {
  return {
    splitEl: document.getElementById('split') as HTMLElement,
    setAxis: vi.fn(),
    toggleRightCollapsed: vi.fn(),
    toggleLeftCollapsed: vi.fn(),
    ...over,
  };
}

describe('layout controller', () => {
  beforeEach(() => {
    localStorage.clear();
    initEdgeResizerMock.mockClear();
    resizerDisposers.length = 0;
    mountLayoutDom();
  });

  // Dispose every controller a test built so its captured appStore subscription is released — otherwise
  // subscriptions stack across `it`s and a later toggle re-fires them all (see `create` above).
  afterEach(() => {
    for (const c of created) c.dispose();
    created.length = 0;
  });

  it('mirrors the persisted layout onto #split and wires both edge resizers at construction', () => {
    const deps = makeDeps();
    create(deps);

    const split = deps.splitEl;
    expect(split.dataset.panelSide).toBeTruthy();
    expect(split.dataset.siderailSide).toBeTruthy();

    expect(initEdgeResizerMock).toHaveBeenCalledTimes(2);
    const cssVars = initEdgeResizerMock.mock.calls.map((c) => c[0].cssVar);
    expect(cssVars).toEqual(['--koi-inspector-w', '--koi-leftrail-w']);
  });

  it('togglePanelSide flips #split[data-panel-side] AND persists the merged blob', () => {
    const ctrl = create(makeDeps());
    const split = document.getElementById('split') as HTMLElement;
    expect(split.dataset.panelSide).toBe('bottom'); // default
    ctrl.actions.togglePanelSide();
    expect(split.dataset.panelSide).toBe('right'); // flipped
    // The transition merges into the koine.studio.layout blob, so the reload-source reflects it.
    const blob = JSON.parse(localStorage.getItem('koine.studio.layout') as string);
    expect(blob.panelSide).toBe('right');
  });

  it('toggleSideRail flips data-siderail-side, persists, and re-wires the resizers', () => {
    const ctrl = create(makeDeps());
    const split = document.getElementById('split') as HTMLElement;
    expect(split.dataset.siderailSide).toBe('right'); // default
    initEdgeResizerMock.mockClear();

    ctrl.actions.toggleSideRail();

    expect(split.dataset.siderailSide).toBe('left'); // flipped
    expect(initEdgeResizerMock).toHaveBeenCalledTimes(2); // both handles re-wired live
    const blob = JSON.parse(localStorage.getItem('koine.studio.layout') as string);
    expect(blob.sideRail).toBe('left');
  });

  it('restores BOTH panelSide and sideRail from a stored blob onto #split at construction', () => {
    localStorage.setItem(
      'koine.studio.layout',
      JSON.stringify({ panelSide: 'right', sideRail: 'left', rightCollapsed: true, leftCollapsed: false }),
    );
    const deps = makeDeps();
    create(deps);
    expect(deps.splitEl.dataset.panelSide).toBe('right');
    expect(deps.splitEl.dataset.siderailSide).toBe('left');
  });

  it('toggleProperties / toggleNavigator flip the chrome-collapse store slices', () => {
    const deps = makeDeps();
    const ctrl = create(deps);
    ctrl.actions.toggleProperties();
    ctrl.actions.toggleNavigator();
    expect(deps.toggleRightCollapsed).toHaveBeenCalledOnce();
    expect(deps.toggleLeftCollapsed).toHaveBeenCalledOnce();
  });

  it('a section header click toggles its data-open + aria-expanded', () => {
    create(makeDeps());
    const sect = document.getElementById('rail-files') as HTMLElement;
    const head = sect.querySelector('.rail-sect-head') as HTMLButtonElement;

    head.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(sect.dataset.open).toBe('false');
    expect(head.getAttribute('aria-expanded')).toBe('false');

    head.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(sect.dataset.open).toBe('true');
    expect(head.getAttribute('aria-expanded')).toBe('true');
  });

  it('toggleFileTree maps the Files pane visibility onto the rail axis', () => {
    const deps = makeDeps();
    const ctrl = create(deps);
    const files = document.getElementById('rail-files') as HTMLElement;

    files.hidden = true;
    ctrl.toggleFileTree();
    expect(deps.setAxis).toHaveBeenLastCalledWith('files');

    files.hidden = false;
    ctrl.toggleFileTree();
    expect(deps.setAxis).toHaveBeenLastCalledWith('domain');
  });

  it('dispose() releases the live resizers and stops the section-header listeners', () => {
    const ctrl = create(makeDeps());
    const head = document.querySelector('.rail-sect-head') as HTMLButtonElement;
    const sect = document.getElementById('rail-files') as HTMLElement;

    ctrl.dispose();

    // Both resizer disposers (the current pair) were called.
    expect(resizerDisposers.every((d) => d.mock.calls.length >= 1)).toBe(true);
    // The section-header click no longer toggles after dispose.
    sect.dataset.open = 'true';
    head.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(sect.dataset.open).toBe('true');
  });
});
