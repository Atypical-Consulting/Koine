import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCommandWiring, PALETTE_COMMAND_ID, type CommandWiringDeps } from '@/shell/commandWiring';
import { canStopCompile, stopRunawayCompile } from '@/host/browser/stopCompile';
import { createLauncher, type LauncherHandle } from '@/launcher/createLauncher';
import type { LauncherSources } from '@/launcher/buildCatalog';
import type { LauncherActionDeps } from '@/launcher/actions';
import type { CatalogEntry } from '@/launcher/catalog';

// Mock the runaway-compile gate so tests can flip stop-compile's when() predicate. Defaults to false
// (Stop hidden), matching an idle editor; individual tests opt into true.
vi.mock('@/host/browser/stopCompile', () => ({
  canStopCompile: vi.fn(() => false),
  stopRunawayCompile: vi.fn(),
}));

// The Spotlight launcher (#1143) is mounted for real by createLauncher; mock it so these tests observe
// the WIRING — which LauncherSources / LauncherActionDeps commandWiring builds, and that ⌘K toggles the
// handle — without rendering the Preact overlay into happy-dom. beforeEach captures the args + handle.
vi.mock('@/launcher/createLauncher', () => ({ createLauncher: vi.fn() }));

let launcherToggle: ReturnType<typeof vi.fn>;
let launcherToast: ReturnType<typeof vi.fn>;
let launcherPeek: ReturnType<typeof vi.fn>;
let launcherOpen = false;
let capturedSources: LauncherSources;
let capturedActionDeps: LauncherActionDeps;

// happy-dom doesn't implement scrollIntoView; the palette calls it on open (the Cmd-K tests open it).
if (typeof (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView !== 'function') {
  (HTMLElement.prototype as { scrollIntoView: () => void }).scrollIntoView = () => {};
}

// The toolbar button ids commandWiring wires at construction (index.html owns these in the real shell).
const TOOLBAR_IDS = [
  'btn-home',
  'btn-new',
  'btn-generate-project',
  'btn-prefs',
  'btn-toolbar-overflow',
];

function mountToolbar(): void {
  const bar = document.createElement('div');
  const hint = document.createElement('button');
  hint.className = 'palette-hint';
  bar.appendChild(hint);
  for (const id of TOOLBAR_IDS) {
    const btn = document.createElement('button');
    btn.id = id;
    bar.appendChild(btn);
  }
  document.body.appendChild(bar);
}

function makeDeps(over: Partial<CommandWiringDeps> = {}): CommandWiringDeps {
  return {
    history: { undo: vi.fn(), redo: vi.fn() },
    format: vi.fn(),
    goHome: vi.fn(),
    openFolder: vi.fn(),
    search: { focus: vi.fn(), toggle: vi.fn() },
    requestNewModel: vi.fn(),
    workspace: { saveAllDirty: vi.fn(), buffers: () => new Map() },
    copyShareLink: vi.fn(),
    controller: {
      runCheck: vi.fn(),
      selectOutput: vi.fn(),
      selectDocsTab: vi.fn(),
      selectCenter: vi.fn(),
      splitCodeCanvas: vi.fn(),
      selectTech: vi.fn(),
      selectRight: vi.fn(),
      selectBottomTab: vi.fn(),
    },
    generateProject: { open: vi.fn() },
    exportSourceZip: vi.fn(),
    exportActiveDiagram: vi.fn(),
    copyActiveDiagramMermaid: vi.fn(),
    saveProjectToDisk: vi.fn(),
    canSaveProjects: false,
    layoutActions: {
      togglePanelSide: vi.fn(),
      toggleSideRail: vi.fn(),
      toggleProperties: vi.fn(),
      toggleNavigator: vi.fn(),
    },
    openSettings: vi.fn(),
    openHelp: vi.fn(),
    toggleHelp: vi.fn(),
    toggleStoreInspector: vi.fn(),
    ensureAssistant: vi.fn(() => ({ explainSelection: vi.fn() })),
    editor: { addCommentAtSelection: vi.fn() },
    openUri: vi.fn(),
    overlayOpen: vi.fn(() => false),
    toggleFileTree: vi.fn(),
    // Spotlight launcher seams (#1143): an empty model index, no git, a no-op reveal.
    modelIndex: vi.fn(async () => ({ glossary: { entries: [] }, byQn: new Map(), qnByCtxName: new Map() })),
    canUseGit: false,
    gitLog: vi.fn(() => null),
    revealLocation: vi.fn(),
    ...over,
  };
}

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
}

describe('commandWiring', () => {
  let dispose: (() => void) | null = null;

  beforeEach(() => {
    document.body.innerHTML = '';
    mountToolbar();
    vi.mocked(canStopCompile).mockReturnValue(false);
    // Fresh launcher handle + captured wiring per test. `launcherOpen` backs the handle's isOpen getter,
    // so a test can flip it to exercise the launcher-open overlay suppression.
    launcherOpen = false;
    launcherToggle = vi.fn();
    launcherToast = vi.fn();
    launcherPeek = vi.fn();
    const open = vi.fn();
    const close = vi.fn();
    vi.mocked(createLauncher).mockReset();
    vi.mocked(createLauncher).mockImplementation((sources, actionDeps) => {
      capturedSources = sources;
      capturedActionDeps = actionDeps;
      return {
        open,
        close,
        toggle: launcherToggle,
        toast: launcherToast,
        peek: launcherPeek,
        get isOpen() {
          return launcherOpen;
        },
      } as unknown as LauncherHandle;
    });
  });

  afterEach(() => {
    dispose?.();
    dispose = null;
    document.body.innerHTML = '';
  });

  describe('getCommands() assembly', () => {
    it('builds the core command set the palette reads', () => {
      const wiring = createCommandWiring(makeDeps());
      dispose = wiring.dispose;
      const ids = wiring.getCommands().map((c) => c.id);
      // A representative slice across the groups — proves the inline Command[] moved intact.
      expect(ids).toEqual(expect.arrayContaining([
        'undo', 'redo', 'format', 'home', 'open-folder', 'search', 'new-model', 'save-all',
        'share', 'check', 'generate-project', 'export-source-zip', 'toggle-theme', 'prefs',
        'help', 'about', 'view-assistant', 'add-comment', 'view-review',
      ]));
    });

    it('omits Save-to-disk when the host cannot save projects, includes it when it can', () => {
      const off = createCommandWiring(makeDeps({ canSaveProjects: false }));
      expect(off.getCommands().map((c) => c.id)).not.toContain('save-project-to-disk');
      off.dispose();

      const on = createCommandWiring(makeDeps({ canSaveProjects: true }));
      dispose = on.dispose;
      expect(on.getCommands().map((c) => c.id)).toContain('save-project-to-disk');
    });

    it('surfaces each open buffer as a Go-to-File command that opens its uri', () => {
      const buffers = new Map([
        ['file:///b.koi', { uri: 'file:///b.koi', relPath: 'b.koi' }],
        ['file:///a.koi', { uri: 'file:///a.koi', relPath: 'a.koi' }],
      ]);
      const deps = makeDeps({ workspace: { saveAllDirty: vi.fn(), buffers: () => buffers } });
      const wiring = createCommandWiring(deps);
      dispose = wiring.dispose;
      const gotos = wiring.getCommands().filter((c) => c.group === 'Go to File');
      // Sorted by relPath, and each runs openUri(buf.uri).
      expect(gotos.map((c) => c.title)).toEqual(['a.koi', 'b.koi']);
      gotos[0].run();
      expect(deps.openUri).toHaveBeenCalledWith('file:///a.koi');
    });

    it('re-reads the buffers thunk on each getCommands() so quick-open reflects files opened AFTER construction (#982 regression)', () => {
      // The workspace slice REPLACES its buffer Map on every mutation, and commandWiring is constructed at
      // boot BEFORE the workspace opens — capturing buffers by value would freeze the palette at the
      // initial empty set (dead "Go to File"). The thunk must re-read the live Map each time.
      let buffers = new Map<string, { uri: string; relPath: string }>();
      const deps = makeDeps({ workspace: { saveAllDirty: vi.fn(), buffers: () => buffers } });
      const wiring = createCommandWiring(deps);
      dispose = wiring.dispose;
      // At construction the workspace is empty: no Go-to-File rows.
      expect(wiring.getCommands().filter((c) => c.group === 'Go to File')).toHaveLength(0);
      // A folder opens after construction, REPLACING the store's Map with a new reference.
      buffers = new Map([['file:///a.koi', { uri: 'file:///a.koi', relPath: 'a.koi' }]]);
      // getCommands() re-reads the thunk, so the newly opened file now surfaces.
      expect(
        wiring
          .getCommands()
          .filter((c) => c.group === 'Go to File')
          .map((c) => c.title),
      ).toEqual(['a.koi']);
    });

    it('runs the format command through the injected format() thunk', () => {
      const deps = makeDeps();
      const wiring = createCommandWiring(deps);
      dispose = wiring.dispose;
      wiring.getCommands().find((c) => c.id === 'format')!.run();
      expect(deps.format).toHaveBeenCalledOnce();
    });

    it('includes the dev store-inspector command only in dev builds (when: () => isDevMode())', () => {
      // The dev command is registered always but gated by its when() predicate, so getCommands()
      // (which filters by isEnabled) surfaces it under vite serve and hides it in shipped builds.
      vi.stubEnv('DEV', false);
      const off = createCommandWiring(makeDeps());
      expect(off.getCommands().map((c) => c.id)).not.toContain('toggle-store-inspector');
      off.dispose();

      vi.stubEnv('DEV', true);
      const on = createCommandWiring(makeDeps());
      dispose = on.dispose;
      expect(on.getCommands().map((c) => c.id)).toContain('toggle-store-inspector');

      vi.unstubAllEnvs();
    });

    it('registers the full static catalog in palette order (every command id, after boot)', () => {
      // canSaveProjects + DEV + canStopCompile all on, no open buffers ⇒ getCommands() is exactly the
      // static catalog. Locks the entry set AND order against drift through the registry migration (#758).
      vi.stubEnv('DEV', true);
      vi.mocked(canStopCompile).mockReturnValue(true);
      const wiring = createCommandWiring(makeDeps({ canSaveProjects: true }));
      dispose = wiring.dispose;

      expect(wiring.getCommands().map((c) => c.id)).toEqual([
        'undo', 'redo', 'format', 'home', 'open-folder', 'search', 'new-model', 'save-all', 'share',
        'check', 'generate-project', 'export-source-zip', 'export-diagram-svg', 'export-diagram-png',
        'export-diagram-plantuml', 'copy-diagram-mermaid', 'save-project-to-disk', 'toggle-theme',
        'layout.panelSide', 'layout.sideRail', 'layout.toggleProperties', 'layout.toggleNavigator',
        'prefs', 'help', 'about', 'toggle-store-inspector', 'view-preview', 'view-glossary',
        'view-decisions', 'view-notes', 'view-diagrams', 'split-code-canvas', 'view-contextmap',
        'view-check', 'view-scenarios', 'view-assistant', 'assistant-explain', 'add-comment',
        'view-review', 'stop-compile',
      ]);

      vi.unstubAllEnvs();
    });

    it('gates stop-compile through when: () => canStopCompile() (absent when idle, present in flight)', () => {
      vi.mocked(canStopCompile).mockReturnValue(false);
      const idle = createCommandWiring(makeDeps());
      expect(idle.getCommands().map((c) => c.id)).not.toContain('stop-compile');
      idle.dispose();

      vi.mocked(canStopCompile).mockReturnValue(true);
      const inFlight = createCommandWiring(makeDeps());
      dispose = inFlight.dispose;
      expect(inFlight.getCommands().map((c) => c.id)).toContain('stop-compile');
    });
  });

  describe('global keyboard shortcuts', () => {
    it('mod+K toggles the Spotlight launcher through the registered palette command (#1143)', () => {
      const wiring = createCommandWiring(makeDeps());
      dispose = wiring.dispose;

      window.dispatchEvent(key({ key: 'k', ctrlKey: true }));
      expect(launcherToggle).toHaveBeenCalledTimes(1); // opened via registry.run(PALETTE_COMMAND_ID)

      window.dispatchEvent(key({ key: 'k', ctrlKey: true }));
      expect(launcherToggle).toHaveBeenCalledTimes(2); // toggled again
    });

    it('dispatches mod+N → requestNewModel, mod+Shift+F → search.toggle, F1 → toggleHelp', () => {
      const deps = makeDeps();
      const wiring = createCommandWiring(deps);
      dispose = wiring.dispose;

      window.dispatchEvent(key({ key: 'n', ctrlKey: true }));
      expect(deps.requestNewModel).toHaveBeenCalledOnce();

      window.dispatchEvent(key({ key: 'f', ctrlKey: true, shiftKey: true }));
      expect(deps.search.toggle).toHaveBeenCalledOnce();

      window.dispatchEvent(key({ key: 'F1' }));
      expect(deps.toggleHelp).toHaveBeenCalledOnce();
    });

    it('mod+B toggles the file tree; mod+Alt+B toggles Properties (matched on e.code)', () => {
      const deps = makeDeps();
      const wiring = createCommandWiring(deps);
      dispose = wiring.dispose;

      window.dispatchEvent(key({ key: 'b', code: 'KeyB', ctrlKey: true }));
      expect(deps.toggleFileTree).toHaveBeenCalledOnce();
      expect(deps.layoutActions.toggleProperties).not.toHaveBeenCalled();

      window.dispatchEvent(key({ key: 'b', code: 'KeyB', ctrlKey: true, altKey: true }));
      expect(deps.layoutActions.toggleProperties).toHaveBeenCalledOnce();
    });

    it('suppresses chords (except mod+K) while an overlay is open', () => {
      const deps = makeDeps({ overlayOpen: vi.fn(() => true) });
      const wiring = createCommandWiring(deps);
      dispose = wiring.dispose;

      window.dispatchEvent(key({ key: 'n', ctrlKey: true }));
      expect(deps.requestNewModel).not.toHaveBeenCalled();
    });

    it('suppresses chords (except mod+K) while the Spotlight launcher is open (#1143)', () => {
      // The launcher renders its own overlay (`.lx-scrim`), which the shell's overlayOpen() does NOT see;
      // commandWiring ORs launcher.isOpen into the guard so global chords don't reach the editor beneath.
      const deps = makeDeps({ overlayOpen: vi.fn(() => false) });
      const wiring = createCommandWiring(deps);
      dispose = wiring.dispose;

      launcherOpen = true;
      window.dispatchEvent(key({ key: 'n', ctrlKey: true }));
      expect(deps.requestNewModel).not.toHaveBeenCalled();
      // mod+K still toggles it — it runs BEFORE the guard.
      window.dispatchEvent(key({ key: 'k', ctrlKey: true }));
      expect(launcherToggle).toHaveBeenCalledTimes(1);
    });

    it('stops listening after dispose()', () => {
      const deps = makeDeps();
      const wiring = createCommandWiring(deps);
      wiring.dispose();
      window.dispatchEvent(key({ key: 'n', ctrlKey: true }));
      expect(deps.requestNewModel).not.toHaveBeenCalled();
    });
  });

  describe('toolbar buttons', () => {
    it('wires Home and New to their commands', () => {
      const deps = makeDeps();
      const wiring = createCommandWiring(deps);
      dispose = wiring.dispose;

      document.getElementById('btn-home')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(deps.goHome).toHaveBeenCalledOnce();

      document.getElementById('btn-new')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(deps.requestNewModel).toHaveBeenCalledOnce();
    });

    it('gates the Save-to-disk command out of the palette when the host cannot save projects', () => {
      // Chrome v2 (#923) dropped the Save-to-disk toolbar button; the command's when() gate now solely
      // decides visibility. A host that can't save projects filters it out of the palette entirely.
      const wiring = createCommandWiring(makeDeps({ canSaveProjects: false }));
      dispose = wiring.dispose;
      expect(wiring.getCommands().some((c) => c.id === 'save-project-to-disk')).toBe(false);
    });

    it('dispatches Generate and Settings through their command ids', () => {
      const deps = makeDeps();
      const wiring = createCommandWiring(deps);
      dispose = wiring.dispose;

      document.getElementById('btn-generate-project')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(deps.generateProject.open).toHaveBeenCalledOnce();

      document.getElementById('btn-prefs')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(deps.openSettings).toHaveBeenCalledOnce();
    });

    it('dispatches Save-to-disk through its command id when the host can save projects', () => {
      const deps = makeDeps({ canSaveProjects: true });
      const wiring = createCommandWiring(deps);
      dispose = wiring.dispose;

      // The button is gone (chrome v2, #923); the command is reached via the palette / mobile overflow.
      wiring.run('save-project-to-disk');
      expect(deps.saveProjectToDisk).toHaveBeenCalledOnce();
    });
  });

  describe('run(id) — by-id dispatch for chrome buttons & global chords (#758)', () => {
    it('dispatches save-all / undo / redo to their actions (the ids ide.tsx wires)', () => {
      const deps = makeDeps();
      const wiring = createCommandWiring(deps);
      dispose = wiring.dispose;

      wiring.run('save-all');
      expect(deps.workspace.saveAllDirty).toHaveBeenCalledOnce();
      wiring.run('undo');
      expect(deps.history.undo).toHaveBeenCalledOnce();
      wiring.run('redo');
      expect(deps.history.redo).toHaveBeenCalledOnce();
    });

    it('is a guarded no-op for an unknown id (never throws)', () => {
      const wiring = createCommandWiring(makeDeps());
      dispose = wiring.dispose;
      expect(() => wiring.run('does-not-exist')).not.toThrow();
    });

    it('registers the palette-toggle command but keeps it out of the palette list', () => {
      const wiring = createCommandWiring(makeDeps());
      dispose = wiring.dispose;
      // Not a row (the launcher never lists the command that opens itself)...
      expect(wiring.getCommands().map((c) => c.id)).not.toContain(PALETTE_COMMAND_ID);
      // ...but registered & enabled, so run() toggles the launcher.
      wiring.run(PALETTE_COMMAND_ID);
      expect(launcherToggle).toHaveBeenCalledTimes(1);
    });

    it('no-ops Save-to-disk dispatch when the host cannot save projects (when-gated, not unknown)', () => {
      const deps = makeDeps({ canSaveProjects: false });
      const wiring = createCommandWiring(deps);
      dispose = wiring.dispose;
      // Registered-but-disabled ⇒ run() is a guarded no-op, and it never reaches the palette list.
      wiring.run('save-project-to-disk');
      expect(deps.saveProjectToDisk).not.toHaveBeenCalled();
      expect(wiring.getCommands().map((c) => c.id)).not.toContain('save-project-to-disk');
    });

    it('no-ops a disabled command — stop-compile stays inert while idle, fires in flight', () => {
      vi.mocked(stopRunawayCompile).mockClear();
      const wiring = createCommandWiring(makeDeps());
      dispose = wiring.dispose;

      vi.mocked(canStopCompile).mockReturnValue(false);
      wiring.run('stop-compile'); // when() === false ⇒ guarded no-op
      expect(stopRunawayCompile).not.toHaveBeenCalled();

      vi.mocked(canStopCompile).mockReturnValue(true);
      wiring.run('stop-compile'); // enabled ⇒ fires
      expect(stopRunawayCompile).toHaveBeenCalledOnce();
    });
  });

  describe('Spotlight launcher wiring (#1143)', () => {
    it('builds LauncherSources.commands() from the studio catalog, without the palette-toggle or goto rows', () => {
      const buffers = new Map([['file:///a.koi', { uri: 'file:///a.koi', relPath: 'a.koi' }]]);
      const deps = makeDeps({ workspace: { saveAllDirty: vi.fn(), buffers: () => buffers } });
      const wiring = createCommandWiring(deps);
      dispose = wiring.dispose;

      const ids = capturedSources.commands().map((c) => c.id);
      expect(ids).toEqual(expect.arrayContaining(['undo', 'format', 'search', 'view-assistant']));
      // The command that opens the launcher is never a launcher row...
      expect(ids).not.toContain(PALETTE_COMMAND_ID);
      // ...and the open-file quick-open rows are NOT commands — they become the launcher's Files mode.
      expect(ids.some((id) => id.startsWith('goto:'))).toBe(false);
    });

    it('exposes the open buffers to LauncherSources.files() (the `/` Files quick-open source)', () => {
      const buffers = new Map([
        ['file:///a.koi', { uri: 'file:///a.koi', relPath: 'a.koi' }],
        ['file:///b.koi', { uri: 'file:///b.koi', relPath: 'b.koi' }],
      ]);
      const deps = makeDeps({ workspace: { saveAllDirty: vi.fn(), buffers: () => buffers } });
      const wiring = createCommandWiring(deps);
      dispose = wiring.dispose;

      expect(capturedSources.files().map((f) => f.uri)).toEqual(['file:///a.koi', 'file:///b.koi']);
    });

    it('re-reads the buffers thunk so LauncherSources.files() reflects files opened after construction', () => {
      let buffers = new Map<string, { uri: string; relPath: string }>();
      const deps = makeDeps({ workspace: { saveAllDirty: vi.fn(), buffers: () => buffers } });
      const wiring = createCommandWiring(deps);
      dispose = wiring.dispose;
      expect(capturedSources.files()).toHaveLength(0);
      buffers = new Map([['file:///a.koi', { uri: 'file:///a.koi', relPath: 'a.koi' }]]);
      expect(capturedSources.files().map((f) => f.uri)).toEqual(['file:///a.koi']);
    });

    it('gates the "Recent commits" group behind canUseGit (browser host = no commits)', () => {
      const off = createCommandWiring(makeDeps({ canUseGit: false, gitLog: vi.fn(() => null) }));
      dispose = off.dispose;
      expect(capturedSources.canUseGit).toBe(false);
      expect(capturedSources.gitLog()).toBeNull();
    });

    it('routes the "Search across files…" command to search.focus() (the text-search panel stays)', () => {
      const deps = makeDeps();
      const wiring = createCommandWiring(deps);
      dispose = wiring.dispose;
      capturedSources.commands().find((c) => c.id === 'search')!.run();
      expect(deps.search.focus).toHaveBeenCalledOnce();
    });

    it('binds the action seam: runCommand → registry.run(cmdId), openFile → openUri, copy → clipboard', async () => {
      const deps = makeDeps();
      const wiring = createCommandWiring(deps);
      dispose = wiring.dispose;

      const cmd: CatalogEntry = { id: 'cmd:new-model', cat: 'action', title: 'New model', cmdId: 'new-model' };
      capturedActionDeps.runCommand(cmd);
      expect(deps.requestNewModel).toHaveBeenCalledOnce();

      const file: CatalogEntry = { id: 'file:x', cat: 'file', title: 'x.koi', file: 'file:///x.koi' };
      capturedActionDeps.openFile(file);
      expect(deps.openUri).toHaveBeenCalledWith('file:///x.koi');

      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', { clipboard: { writeText } });
      await capturedActionDeps.copy('OrderId');
      expect(writeText).toHaveBeenCalledWith('OrderId');
      vi.unstubAllGlobals();
    });

    it('rename / revert honestly toast "not available" instead of a misleading jump / panel swap (#1145)', () => {
      const deps = makeDeps();
      const wiring = createCommandWiring(deps);
      dispose = wiring.dispose;

      const symbol = { id: 'sym:Ordering.Order', cat: 'symbol', title: 'Order' } as unknown as CatalogEntry;
      capturedActionDeps.rename(symbol);
      expect(launcherToast).toHaveBeenLastCalledWith(expect.stringContaining('isn’t available'));
      // ...and it does NOT do the old misleading thing (jump to the definition).
      expect(deps.revealLocation).not.toHaveBeenCalled();

      const commit = { id: 'commit:abc', cat: 'commit', title: 'fix: bug', hash: 'abc1234' } as unknown as CatalogEntry;
      capturedActionDeps.revertCommit(commit);
      expect(launcherToast).toHaveBeenCalledTimes(2);
      // ...and it does NOT silently open the Source Control panel as if a revert happened.
      expect(deps.controller.selectRight).not.toHaveBeenCalled();
    });

    it('peek surfaces a non-navigating quick-look — the launcher preview, never revealLocation/openUri (#1165)', () => {
      const deps = makeDeps();
      const wiring = createCommandWiring(deps);
      dispose = wiring.dispose;

      const range = { start: { line: 3, character: 2 }, end: { line: 3, character: 7 } };
      const entry = {
        id: 'sym:Ordering.Order',
        cat: 'symbol',
        title: 'Order',
        file: 'file:///order.koi',
        nameRange: range,
      } as unknown as CatalogEntry;
      capturedActionDeps.peek(entry);
      // Surfaces the read-only preview through the launcher's own preview surface...
      expect(launcherPeek).toHaveBeenCalledWith(entry);
      // ...and does NOT navigate: no editor jump (revealLocation) and no file open (openUri).
      expect(deps.revealLocation).not.toHaveBeenCalled();
      expect(deps.openUri).not.toHaveBeenCalled();
    });

    it('binds gotoDefinition to revealLocation using the entry\'s declaring file + nameRange', () => {
      const deps = makeDeps();
      const wiring = createCommandWiring(deps);
      dispose = wiring.dispose;

      const range = { start: { line: 3, character: 2 }, end: { line: 3, character: 7 } };
      const entry = {
        id: 'sym:Ordering.Order',
        cat: 'symbol',
        title: 'Order',
        nameRange: range,
        element: { node: { sourceSpan: { file: 'file:///order.koi' } } },
      } as unknown as CatalogEntry;
      capturedActionDeps.gotoDefinition(entry);
      expect(deps.revealLocation).toHaveBeenCalledWith('file:///order.koi', range);
    });
  });
});
