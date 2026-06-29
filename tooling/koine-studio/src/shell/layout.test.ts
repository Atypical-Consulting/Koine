import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { createLayoutController, type LayoutControllerDeps } from '@/shell/layout';

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

  it('mirrors the persisted layout onto #split and wires both edge resizers at construction', () => {
    const deps = makeDeps();
    createLayoutController(deps);

    const split = deps.splitEl;
    expect(split.dataset.panelSide).toBeTruthy();
    expect(split.dataset.siderailSide).toBeTruthy();

    expect(initEdgeResizerMock).toHaveBeenCalledTimes(2);
    const cssVars = initEdgeResizerMock.mock.calls.map((c) => c[0].cssVar);
    expect(cssVars).toEqual(['--koi-inspector-w', '--koi-leftrail-w']);
  });

  it('togglePanelSide flips #split[data-panel-side] (persisted via layoutStore)', () => {
    const ctrl = createLayoutController(makeDeps());
    const split = document.getElementById('split') as HTMLElement;
    const before = split.dataset.panelSide;
    ctrl.actions.togglePanelSide();
    expect(split.dataset.panelSide).not.toBe(before);
    expect(['bottom', 'right']).toContain(split.dataset.panelSide);
  });

  it('toggleSideRail flips the side and re-wires the resizers with swapped anchors', () => {
    const ctrl = createLayoutController(makeDeps());
    const split = document.getElementById('split') as HTMLElement;
    const before = split.dataset.siderailSide;
    initEdgeResizerMock.mockClear();

    ctrl.actions.toggleSideRail();

    expect(split.dataset.siderailSide).not.toBe(before);
    expect(initEdgeResizerMock).toHaveBeenCalledTimes(2); // both handles re-wired live
  });

  it('toggleProperties / toggleNavigator flip the chrome-collapse store slices', () => {
    const deps = makeDeps();
    const ctrl = createLayoutController(deps);
    ctrl.actions.toggleProperties();
    ctrl.actions.toggleNavigator();
    expect(deps.toggleRightCollapsed).toHaveBeenCalledOnce();
    expect(deps.toggleLeftCollapsed).toHaveBeenCalledOnce();
  });

  it('a section header click toggles its data-open + aria-expanded', () => {
    createLayoutController(makeDeps());
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
    const ctrl = createLayoutController(deps);
    const files = document.getElementById('rail-files') as HTMLElement;

    files.hidden = true;
    ctrl.toggleFileTree();
    expect(deps.setAxis).toHaveBeenLastCalledWith('files');

    files.hidden = false;
    ctrl.toggleFileTree();
    expect(deps.setAxis).toHaveBeenLastCalledWith('domain');
  });

  it('dispose() releases the live resizers and stops the section-header listeners', () => {
    const ctrl = createLayoutController(makeDeps());
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
