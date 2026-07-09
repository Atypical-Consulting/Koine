// Tests for the center/deck + chrome orchestration — extracted from inspectorController (Task 4 of
// #985's decomposition). Behavior is pinned two ways: HERE (the module's own contract, in isolation) and
// in inspectorController.test.ts's pre-existing describe blocks (the facade's delegation to this module,
// unmodified assertions — see that file's "center switching", "deck center layout", "right-edge
// tool-window stripe (#500)", "left navigator morph-collapse (#730)", "rail axis switch (#453)",
// "narrow-viewport bottom-strip default (#475)", and "collapsed Properties panel + selection feedback
// (#648)" blocks).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createElement, render } from 'preact';
import { LeftRail, RightStrip } from '@atypical/koine-ui';
import {
  centerDeckInitialChrome,
  createCenterDeckController,
  type CenterDeckControllerDeps,
  type CenterDeckControllerHooks,
} from '@/shell/inspector/centerDeckController';
import { createAppStore } from '@/store/index';
import { domById } from '@/shared/domById';
import type { KoineEditor } from '@/editor/editor';
import { DEFAULT_DECK_STATE, type DeckState } from '@/store/slices/uiChrome';

// The same DOM id surface inspectorController.test.ts seeds (APP_HTML) — this module looks up every one
// of these itself (no injected `hosts`), so a drift throws via domById() exactly like the facade does.
const APP_HTML = `
  <div id="app">
    <main id="split">
      <aside id="leftrail" class="pane"></aside>
      <section id="center" class="pane">
        <div id="deck-bar"></div>
        <div id="center-body">
          <section id="center-visual" class="center-host">
            <div id="canvas-palette-host"></div>
            <div id="diagram-host"></div>
          </section>
          <section id="center-technical" class="center-host" hidden>
            <div id="tech-body">
              <section id="editor-pane" class="tech-view"></section>
              <div id="view-scenarios" class="tech-view" hidden></div>
            </div>
          </section>
          <section id="center-output" class="center-host" hidden>
            <div id="output-body">
              <div id="view-preview" class="tech-view"></div>
              <div id="view-check" class="tech-view doc-view" hidden></div>
              <div id="panel-contextmap" class="tech-view doc-view" hidden></div>
            </div>
          </section>
          <section id="center-docs" class="center-host" hidden>
            <div id="docs-body">
              <div id="view-glossary" class="tech-view doc-view"></div>
              <div id="view-docs" class="tech-view doc-view" hidden></div>
              <div id="view-notes" class="tech-view doc-view" hidden></div>
            </div>
          </section>
        </div>
        <section id="center-panel-settings" class="settings-page" role="dialog" aria-modal="true" aria-label="Settings" hidden>
          <div id="settings-page-body"></div>
        </section>
        <footer id="diagnostics">
          <div class="koi-resizer koi-resizer-y" id="diag-resizer"></div>
          <div id="diag-header">
            <button type="button" id="diag-collapse" class="diag-collapse" aria-expanded="true">collapse</button>
            <div class="diag-tabs" role="tablist">
              <button type="button" class="diag-tab" id="tab-problems" role="tab" data-panel="problems" aria-selected="true">Problems</button>
              <button type="button" class="diag-tab" id="tab-events" role="tab" data-panel="events" aria-selected="false">Events</button>
              <button type="button" class="diag-tab" id="tab-relationships" role="tab" data-panel="relationships" aria-selected="false">Relationships</button>
              <button type="button" class="diag-tab" id="tab-terminal" role="tab" data-panel="terminal" aria-selected="false">Terminal</button>
            </div>
            <span id="diag-count" class="diag-count"></span>
          </div>
          <div id="diag-body" class="diag-panel" role="tabpanel"></div>
          <div id="panel-events" class="diag-panel" role="tabpanel" hidden></div>
          <div id="panel-relationships" class="diag-panel" role="tabpanel" hidden></div>
          <div id="panel-terminal" class="diag-panel diag-panel-terminal" role="tabpanel" hidden></div>
          <div id="panel-review" class="diag-panel" role="tabpanel" hidden></div>
        </footer>
      </section>
      <aside id="right" class="pane">
        <header id="right-header"><h2 id="right-title">Properties</h2></header>
        <div id="right-body">
          <div id="inspector-host" class="rview" role="tabpanel"></div>
          <section id="view-assistant" class="rview" role="tabpanel" hidden></section>
          <div id="rview-source-control" class="rview doc-view" role="tabpanel" hidden></div>
          <div id="rview-syntax-tree" class="rview doc-view" role="tabpanel" hidden></div>
        </div>
      </aside>
      <div id="right-strip" class="pane" role="toolbar" aria-label="Tool windows" aria-orientation="vertical"></div>
    </main>
    <footer id="statusbar"><button type="button" class="sb-seg sb-ctx" id="sb-context" aria-haspopup="menu" aria-expanded="false">Context: —</button></footer>
  </div>`;

function seedDom(): void {
  document.body.innerHTML = APP_HTML;
  render(createElement(LeftRail, null), document.getElementById('leftrail')!);
  render(createElement(RightStrip, null), document.getElementById('right-strip')!);
}

const stripBtn = (view: string) =>
  document.querySelector<HTMLButtonElement>(`#right-strip [data-rview="${view}"]`)!;

function fakeEditor(): Pick<KoineEditor, 'view'> {
  return { view: { requestMeasure: vi.fn() } as unknown as KoineEditor['view'] };
}

// Named vi.fn() locals (not read back off the narrow `CenterDeckControllerDeps`/`Hooks` interface types)
// so assertions can call `.mockClear()`/`.mock.calls` directly — mirrors inspectorController.test.ts's own
// `const saveWorkspaceCenter = vi.fn(); createInspectorController(makeDeps(lsp, { saveWorkspaceCenter }))`
// pattern.
function makeDeps(over: Partial<CenterDeckControllerDeps> = {}) {
  const saveWorkspaceCenter = vi.fn();
  const saveWorkspaceDeck = vi.fn();
  const initEdgeResizer = vi.fn();
  const deps: CenterDeckControllerDeps = {
    saveWorkspaceCenter,
    saveWorkspaceDeck,
    initEdgeResizer,
    ...over,
  };
  return { deps, saveWorkspaceCenter, saveWorkspaceDeck, initEdgeResizer };
}

function makeHooks(over: Partial<CenterDeckControllerHooks> = {}) {
  const ensureVisibleLoaded = vi.fn();
  const loadSourceControl = vi.fn();
  const focusSourceControl = vi.fn();
  const loadSyntaxTree = vi.fn();
  const ensureAssistantShown = vi.fn();
  const ensureBottomLoaded = vi.fn();
  const hooks: CenterDeckControllerHooks = {
    ensureVisibleLoaded,
    loadSourceControl,
    focusSourceControl,
    loadSyntaxTree,
    ensureAssistantShown,
    ensureBottomLoaded,
    ...over,
  };
  return { hooks, ensureVisibleLoaded, loadSourceControl, focusSourceControl, loadSyntaxTree, ensureAssistantShown, ensureBottomLoaded };
}

// This controller no longer restores/resets its own deck (#1260): the OWNER seeds the store via
// `centerDeckInitialChrome(deck)` before construction — here, this test harness plays that role, mirroring
// what the facade does in production.
function makeController(
  opts: { deck?: DeckState; deps?: Partial<CenterDeckControllerDeps>; hooks?: Partial<CenterDeckControllerHooks> } = {},
) {
  const { deck = DEFAULT_DECK_STATE, deps: depsOver = {}, hooks: hooksOver = {} } = opts;
  const store = createAppStore();
  store.setState(centerDeckInitialChrome(deck));
  const editor = fakeEditor();
  const d = makeDeps(depsOver);
  const h = makeHooks(hooksOver);
  const ctl = createCenterDeckController({ store, editor, deps: d.deps, hooks: h.hooks });
  return { store, editor, ctl, ...d, ...h };
}

beforeEach(() => {
  seedDom();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('centerDeckInitialChrome — the pure construction-reset factory (#1260)', () => {
  test('returns the 7-field reset for a restored 2-up deck, primary as the center', () => {
    const deck: DeckState = { mode: 'focus', primary: 'technical', secondary: 'visual', ratio: 0.5, flipped: false };

    expect(centerDeckInitialChrome(deck)).toEqual({
      deck,
      center: 'technical',
      tech: 'editor',
      output: 'generated',
      docs: 'glossary',
      bottom: 'problems',
      right: 'props',
    });
  });

  test('returns the 7-field reset for DEFAULT_DECK_STATE', () => {
    expect(centerDeckInitialChrome(DEFAULT_DECK_STATE)).toEqual({
      deck: DEFAULT_DECK_STATE,
      center: DEFAULT_DECK_STATE.primary,
      tech: 'editor',
      output: 'generated',
      docs: 'glossary',
      bottom: 'problems',
      right: 'props',
    });
  });
});

describe('createCenterDeckController — (a) center-persist guard (mirror-free, #980/#985 Task 4)', () => {
  test('a real center change persists via saveWorkspaceCenter exactly once', () => {
    const { store, saveWorkspaceCenter, ctl } = makeController();
    ctl.init();
    saveWorkspaceCenter.mockClear(); // drop the boot-time seed noise, if any

    store.getState().focusPrimary('technical');

    expect(saveWorkspaceCenter).toHaveBeenCalledTimes(1);
    expect(saveWorkspaceCenter).toHaveBeenCalledWith('technical');
    ctl.dispose();
  });

  test('re-selecting the same center writes nothing (no churn)', () => {
    const { store, saveWorkspaceCenter, ctl } = makeController();
    ctl.init();
    store.getState().focusPrimary('technical');
    saveWorkspaceCenter.mockClear();

    store.getState().focusPrimary('technical'); // same value — the store no-ops, so no subscription fire

    expect(saveWorkspaceCenter).not.toHaveBeenCalled();
    ctl.dispose();
  });

  test('a transient/invalid center value is never persisted, and the guard reads `prev` directly (not a mirror)', () => {
    const { store, saveWorkspaceCenter, ctl } = makeController();
    ctl.init();
    store.getState().focusPrimary('technical');
    saveWorkspaceCenter.mockClear();

    // Force an invalid value in directly (bypassing the CenterView union, like a legacy caller would) —
    // isValidCenter rejects it, so it must never be persisted.
    store.setState({ center: 'bogus' as unknown as never });
    expect(saveWorkspaceCenter).not.toHaveBeenCalled();

    // Reverting to the SAME valid value the mirror-based guard used to treat as a no-op change: the
    // mirror-free guard compares against the subscription's OWN `prev` snapshot ('bogus'), sees a genuine
    // transition on this hop, and re-persists — the one documented observable delta versus the old
    // `persistedCenter` mirror (idempotent, harmless).
    store.setState({ center: 'technical' });
    expect(saveWorkspaceCenter).toHaveBeenCalledTimes(1);
    expect(saveWorkspaceCenter).toHaveBeenCalledWith('technical');
    ctl.dispose();
  });
});

describe('createCenterDeckController — (b) deck changes re-apply chrome and persist', () => {
  test('a deck change re-applies the center chrome (technical becomes visible, hidden toggles flip)', () => {
    const { store, ctl } = makeController();
    ctl.init();

    expect(domById('editor-pane').hidden).toBe(true); // Visual is the boot default

    store.getState().focusPrimary('technical');

    expect(domById('editor-pane').hidden).toBe(false); // chrome re-applied: Code's editor facet now shows
    ctl.dispose();
  });

  test('a deck change persists the deck via saveWorkspaceDeck, carrying the new primary', () => {
    const { store, saveWorkspaceDeck, ctl } = makeController();
    ctl.init();
    saveWorkspaceDeck.mockClear();

    store.getState().focusPrimary('docs');

    expect(saveWorkspaceDeck).toHaveBeenCalled();
    const calls = saveWorkspaceDeck.mock.calls;
    const lastDeck = calls[calls.length - 1][0] as DeckState;
    expect(lastDeck.primary).toBe('docs');
    ctl.dispose();
  });

  test('a deck change calls the injected ensureVisibleLoaded hook (the lazy-load half of syncCenterChrome)', () => {
    const { store, ensureVisibleLoaded, ctl } = makeController();
    ctl.init();
    ensureVisibleLoaded.mockClear();

    store.getState().focusPrimary('output');

    expect(ensureVisibleLoaded).toHaveBeenCalled();
    ctl.dispose();
  });

  test('a persisted deck restores the 2-up on construction', () => {
    const deck: DeckState = { mode: 'focus', primary: 'technical', secondary: 'visual', ratio: 0.5, flipped: false };
    const { store, ctl } = makeController({ deck });
    ctl.init();

    expect(store.getState().deck).toEqual(deck);
    expect(store.getState().center).toBe('technical');
    ctl.dispose();
  });
});

describe('createCenterDeckController — (c) right-edge tool-window stripe click matrix (#500)', () => {
  test('collapsed → clicking a stripe icon expands straight to that view', () => {
    const { store, ctl } = makeController();
    ctl.init();
    store.getState().setRightCollapsed(true);

    stripBtn('source-control').click();

    expect(store.getState().rightCollapsed).toBe(false);
    expect(store.getState().right).toBe('source-control');
    expect(stripBtn('source-control').getAttribute('aria-pressed')).toBe('true');
    ctl.dispose();
  });

  test("open on a view → clicking that SAME view's icon collapses the rail", () => {
    const { store, ctl } = makeController();
    ctl.init();
    store.getState().setRightCollapsed(false);
    store.getState().setRight('props');

    stripBtn('props').click();

    expect(store.getState().rightCollapsed).toBe(true);
    ctl.dispose();
  });

  test('open on a view → clicking a DIFFERENT view switches without collapsing', () => {
    const { store, ctl } = makeController();
    ctl.init();
    store.getState().setRightCollapsed(false);
    store.getState().setRight('props');

    stripBtn('source-control').click();

    expect(store.getState().rightCollapsed).toBe(false);
    expect(store.getState().right).toBe('source-control');
    expect(stripBtn('source-control').getAttribute('aria-pressed')).toBe('true');
    expect(stripBtn('props').getAttribute('aria-pressed')).toBe('false');
    ctl.dispose();
  });

  test('clicking source-control loads it via the injected hook exactly once per open', () => {
    const { loadSourceControl, ctl } = makeController();
    ctl.init();
    loadSourceControl.mockClear();

    stripBtn('source-control').click();

    expect(loadSourceControl).toHaveBeenCalledTimes(1);
    ctl.dispose();
  });
});

describe('createCenterDeckController — (d) dispose() detaches every subscription', () => {
  test('no more chrome writes / persistence after dispose()', () => {
    const { store, saveWorkspaceCenter, saveWorkspaceDeck, ensureVisibleLoaded, ctl } = makeController();
    ctl.init();
    ctl.dispose();

    saveWorkspaceCenter.mockClear();
    saveWorkspaceDeck.mockClear();
    ensureVisibleLoaded.mockClear();

    expect(() => store.getState().focusPrimary('technical')).not.toThrow();
    expect(saveWorkspaceCenter).not.toHaveBeenCalled();
    expect(saveWorkspaceDeck).not.toHaveBeenCalled();
    expect(ensureVisibleLoaded).not.toHaveBeenCalled();
  });

  test('no right-strip / rail-axis / left-collapse repaint after dispose()', () => {
    const { store, ctl } = makeController();
    ctl.init();
    const collapsedBefore = domById('split').classList.contains('right-collapsed');
    ctl.dispose();

    expect(() => store.getState().setRightCollapsed(!collapsedBefore)).not.toThrow();
    expect(domById('split').classList.contains('right-collapsed')).toBe(collapsedBefore);

    expect(() => store.getState().setRailAxis('files')).not.toThrow();
    expect(domById('rail-files').hidden).toBe(true); // still hidden — the axis subscription is gone

    expect(() => store.getState().setLeftCollapsed(true)).not.toThrow();
    expect(domById('split').classList.contains('left-collapsed')).toBe(false); // unchanged — no repaint
  });

  test('dispose() unmounts the deck Preact trees (no leftover deck cards in #center-body)', async () => {
    const { ctl } = makeController();
    ctl.init();
    ctl.dispose();
    expect(document.querySelectorAll('#center-body .deck-card').length).toBe(0);
  });
});
