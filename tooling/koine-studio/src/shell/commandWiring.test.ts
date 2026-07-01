import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCommandWiring, PALETTE_COMMAND_ID, type CommandWiringDeps } from '@/shell/commandWiring';
import { canStopCompile, stopRunawayCompile } from '@/host/browser/stopCompile';

// Mock the runaway-compile gate so tests can flip stop-compile's when() predicate. Defaults to false
// (Stop hidden), matching an idle editor; individual tests opt into true.
vi.mock('@/host/browser/stopCompile', () => ({
  canStopCompile: vi.fn(() => false),
  stopRunawayCompile: vi.fn(),
}));

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
    workspace: { saveAllDirty: vi.fn(), buffers: new Map() },
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
      const deps = makeDeps({ workspace: { saveAllDirty: vi.fn(), buffers } });
      const wiring = createCommandWiring(deps);
      dispose = wiring.dispose;
      const gotos = wiring.getCommands().filter((c) => c.group === 'Go to File');
      // Sorted by relPath, and each runs openUri(buf.uri).
      expect(gotos.map((c) => c.title)).toEqual(['a.koi', 'b.koi']);
      gotos[0].run();
      expect(deps.openUri).toHaveBeenCalledWith('file:///a.koi');
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
    it('mod+K toggles the command palette through the registered palette command (#758)', () => {
      const wiring = createCommandWiring(makeDeps());
      dispose = wiring.dispose;
      const backdrop = () => document.body.querySelector<HTMLElement>('.koi-palette-backdrop')!;
      expect(backdrop().hidden).toBe(true);

      window.dispatchEvent(key({ key: 'k', ctrlKey: true }));
      expect(backdrop().hidden).toBe(false); // opened via registry.run(PALETTE_COMMAND_ID)

      window.dispatchEvent(key({ key: 'k', ctrlKey: true }));
      expect(backdrop().hidden).toBe(true); // toggled closed
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
      // Not a row (the palette never lists the command that opens itself)...
      expect(wiring.getCommands().map((c) => c.id)).not.toContain(PALETTE_COMMAND_ID);
      // ...but registered & enabled, so run() toggles the palette open.
      const backdrop = () => document.body.querySelector<HTMLElement>('.koi-palette-backdrop')!;
      expect(backdrop().hidden).toBe(true);
      wiring.run(PALETTE_COMMAND_ID);
      expect(backdrop().hidden).toBe(false);
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
});
