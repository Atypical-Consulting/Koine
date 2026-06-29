// The command surface of Koine Studio, extracted from ide.tsx's init() (#757). Owns the command
// palette, the command LIST (getCommands), the toolbar buttons that trigger commands (Home / New /
// Generate / Save-to-disk / Theme / Settings + the mobile overflow ⋮ menu), and the global keyboard
// shortcuts. init() constructs it last, handing it the actions it dispatches to as a typed `deps` of
// thunks — the same dependency-injected-controller idiom as workspaceController / historyController.
//
// This is a pure structural lift: every closure keeps its exact logic, it just moves out of init() and
// reaches the rest of the shell through `deps`. The command-registry sibling (#758) is not yet landed,
// so getCommands() is moved verbatim (the inline Command[] it already built); when #758 ships, this is
// where the declarative registry composes in, with no change to init().
import { createCommandPalette, type Command } from '@/shared/palette';
import { layoutCommands, type LayoutActions } from '@/shell/layoutCommands';
import { devCommands } from '@/shell/devCommands';
import { canStopCompile, stopRunawayCompile } from '@/host/browser/stopCompile';
import { formatChord } from '@/shared/platform';
import { toggleTheme } from '@/settings/theme';
import { buildOverflowItems, toggleOverflowMenu } from '@/shell/toolbarOverflow';

// The actions the command surface dispatches to. Each is a thunk into an init() closure or another
// controller, so commandWiring imports none of them directly and stays unit-testable with stubs.
export interface CommandWiringDeps {
  history: { undo(): void; redo(): void };
  /** Format the active document (ide.tsx's formatActive — lsp.format + editor.applyEdits). */
  format(): void;
  goHome(): void;
  openFolder(): void;
  search: { focus(): void; toggle(): void };
  requestNewModel(): void;
  workspace: { saveAllDirty(): void; buffers: ReadonlyMap<string, { uri: string; relPath: string }> };
  copyShareLink(): void;
  controller: {
    runCheck(): void;
    selectOutput(tab: 'generated' | 'contextmap' | 'compatibility'): void;
    selectDocsTab(tab: 'glossary' | 'adr' | 'notes'): void;
    selectCenter(view: 'visual'): void;
    splitCodeCanvas(): void;
    selectTech(view: 'scenarios'): void;
    selectRight(view: 'assistant'): void;
    selectBottomTab(tab: 'review'): void;
  };
  generateProject: { open(): void };
  exportSourceZip(): void;
  exportActiveDiagram(format: 'svg' | 'png' | 'plantuml'): void;
  copyActiveDiagramMermaid(): void;
  saveProjectToDisk(): void;
  /** platform.canSaveProjects — gates the Save-to-disk command + toolbar button. */
  canSaveProjects: boolean;
  layoutActions: LayoutActions;
  openSettings(category?: string): void;
  openHelp(): void;
  toggleHelp(): void;
  toggleStoreInspector(): void;
  ensureAssistant(): { explainSelection(): void };
  editor: { addCommentAtSelection(): void };
  openUri(uri: string): void;
  /** True while the palette or a modal dialog is open — global chords don't fire through an overlay. */
  overlayOpen(): boolean;
  toggleFileTree(): void;
}

export interface CommandWiring {
  /** The live command set (re-read on every palette/overflow open). Exposed for tests + the registry sibling. */
  getCommands(): Command[];
  /** Release the global keyboard-shortcut listener. */
  dispose(): void;
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

export function createCommandWiring(deps: CommandWiringDeps): CommandWiring {
  // --- command palette command set ------------------------------------------
  // Hints are authored with a literal 'mod' and formatted to ⌘ / Ctrl per platform so the
  // palette, help overlay, and toolbar hint all show the same key.
  function getCommands(): Command[] {
    const cmds: Command[] = [
      { id: 'undo', title: 'Undo', hint: 'mod+Z', group: 'Edit', run: () => deps.history.undo() },
      { id: 'redo', title: 'Redo', hint: 'mod+Shift+Z', group: 'Edit', run: () => deps.history.redo() },
      { id: 'format', title: 'Format document', hint: 'mod+S', group: 'Edit', run: () => void deps.format() },
      { id: 'home', title: 'Go to start screen', group: 'File', run: () => deps.goHome() },
      { id: 'open-folder', title: 'Open folder…', hint: 'mod+Shift+O', group: 'File', run: () => void deps.openFolder() },
      { id: 'search', title: 'Search across files…', hint: 'mod+Shift+F', group: 'Edit', run: () => deps.search.focus() },
      { id: 'new-model', title: 'New model', hint: 'mod+N', group: 'File', run: () => void deps.requestNewModel() },
      { id: 'save-all', title: 'Save all', hint: 'mod+Alt+S', group: 'File', run: () => void deps.workspace.saveAllDirty() },
      { id: 'share', title: 'Copy shareable link', group: 'File', run: () => void deps.copyShareLink() },
      { id: 'check', title: 'Check against baseline…', group: 'File', run: () => void deps.controller.runCheck() },
      { id: 'generate-project', title: 'Generate project…', group: 'File', run: () => deps.generateProject.open() },
      { id: 'export-source-zip', title: 'Export .koi source (.zip)', group: 'File', run: () => void deps.exportSourceZip() },
      { id: 'export-diagram-svg', title: 'Export diagram as SVG', group: 'File', run: () => void deps.exportActiveDiagram('svg') },
      { id: 'export-diagram-png', title: 'Export diagram as PNG', group: 'File', run: () => void deps.exportActiveDiagram('png') },
      { id: 'export-diagram-plantuml', title: 'Export diagram as PlantUML', group: 'File', run: () => void deps.exportActiveDiagram('plantuml') },
      { id: 'copy-diagram-mermaid', title: 'Copy diagram as Mermaid', group: 'File', run: () => void deps.copyActiveDiagramMermaid() },
      ...(deps.canSaveProjects
        ? [{ id: 'save-project-to-disk', title: 'Save to disk…', group: 'File', run: () => void deps.saveProjectToDisk() } as Command]
        : []),
      { id: 'toggle-theme', title: 'Toggle theme', group: 'View', run: () => toggleTheme() },
      // The editor-split + panel-reposition commands (issue #265). Built from the pure layoutCommands
      // module so the list is unit-tested; each run() drives the layoutActions wired at boot above.
      ...layoutCommands(deps.layoutActions),
      { id: 'prefs', title: 'Settings…', hint: 'mod+,', group: 'View', run: () => deps.openSettings() },
      { id: 'help', title: 'Keyboard shortcuts', hint: 'F1', group: 'Help', run: () => deps.openHelp() },
      { id: 'about', title: 'About Koine Studio', group: 'Help', run: () => deps.openSettings('about') },
      ...devCommands(() => void deps.toggleStoreInspector()),
      { id: 'view-preview', title: 'Show Emitted Preview', group: 'Workspace', run: () => deps.controller.selectOutput('generated') },
      { id: 'view-glossary', title: 'Show Glossary', group: 'Workspace', run: () => deps.controller.selectDocsTab('glossary') },
      { id: 'view-decisions', title: 'Show Decisions (ADRs)', group: 'Workspace', run: () => deps.controller.selectDocsTab('adr') },
      { id: 'view-notes', title: 'Show Notes', group: 'Workspace', run: () => deps.controller.selectDocsTab('notes') },
      { id: 'view-diagrams', title: 'Show Visual Editor', group: 'Workspace', run: () => deps.controller.selectCenter('visual') },
      { id: 'split-code-canvas', title: 'Split: Code ⟷ Canvas', group: 'Workspace', run: () => deps.controller.splitCodeCanvas() },
      { id: 'view-contextmap', title: 'Show Context Map', group: 'Workspace', run: () => deps.controller.selectOutput('contextmap') },
      { id: 'view-check', title: 'Show Compatibility Check', group: 'Workspace', run: () => deps.controller.selectOutput('compatibility') },
      { id: 'view-scenarios', title: 'Show Scenario Runner', group: 'Workspace', run: () => deps.controller.selectTech('scenarios') },
      { id: 'view-assistant', title: 'Show AI Chat', group: 'Workspace', run: () => deps.controller.selectRight('assistant') },
      { id: 'assistant-explain', title: 'Explain this construct', group: 'Workspace', run: () => { deps.controller.selectRight('assistant'); deps.ensureAssistant().explainSelection(); } },
      { id: 'add-comment', title: 'Add review comment', group: 'Review', run: () => deps.editor.addCommentAtSelection() },
      { id: 'view-review', title: 'Show Review', group: 'Workspace', run: () => deps.controller.selectBottomTab('review') },
    ];

    // Stop a runaway compile: terminate the WASM worker and boot a fresh one (#353). Offered only while a
    // compile is actually in flight on the worker boot path (#469) — in the main-thread fallback there is
    // nothing to terminate, and an idle Stop would pointlessly restart the worker. getCommands() re-runs
    // on every palette open, so the command appears and disappears with the live in-flight state.
    if (canStopCompile()) {
      cmds.push({
        id: 'stop-compile',
        title: 'Stop compilation (restart compiler)',
        group: 'Workspace',
        run: () => stopRunawayCompile(),
      });
    }

    // Surface every open file as a "Go to File" entry so the palette doubles as a
    // fuzzy quick-open (type part of a path to jump). The palette re-reads this on each open.
    for (const buf of Array.from(deps.workspace.buffers.values()).sort((a, b) => a.relPath.localeCompare(b.relPath))) {
      cmds.push({ id: 'goto:' + buf.uri, title: buf.relPath, group: 'Go to File', run: () => deps.openUri(buf.uri) });
    }

    return cmds.map((c) => (c.hint ? { ...c, hint: formatChord(c.hint) } : c));
  }

  const palette = createCommandPalette(() => getCommands());

  // --- toolbar buttons unique to this phase ---------------------------------
  const hintEl = document.querySelector('.palette-hint');
  if (hintEl) {
    // Render the chord into an aria-hidden span: the visible "⌘+K" is decorative chrome, while the
    // button's accessible name stays "Open command palette" (aria-label). Setting textContent directly
    // would make the chord the visible label and break WCAG 2.5.3 (Label in Name).
    hintEl.replaceChildren();
    const chord = document.createElement('span');
    chord.setAttribute('aria-hidden', 'true');
    chord.textContent = formatChord('mod+K'); // ⌘+K / Ctrl+K per platform
    hintEl.appendChild(chord);
    hintEl.addEventListener('click', () => palette.toggle());
  }
  el<HTMLButtonElement>('btn-home').addEventListener('click', () => deps.goHome());
  el<HTMLButtonElement>('btn-new').addEventListener('click', () => void deps.requestNewModel());
  el<HTMLButtonElement>('btn-generate-project').addEventListener('click', () => deps.generateProject.open());
  const saveProjectBtn = el<HTMLButtonElement>('btn-save-project');
  saveProjectBtn.addEventListener('click', () => void deps.saveProjectToDisk());
  if (!deps.canSaveProjects) saveProjectBtn.hidden = true;
  el<HTMLButtonElement>('btn-theme').addEventListener('click', () => toggleTheme());
  // The toolbar gear opens the transient Settings overlay over the deck (#center-panel-settings) — now the
  // single Settings surface every entry point shares (#731), via the openSettings helper.
  el<HTMLButtonElement>('btn-prefs').addEventListener('click', () => deps.openSettings());

  // Mobile overflow "More" (⋮) menu (#528): at ≤ $bp-narrow the toolbar hides its secondary actions
  // (Save/Check/Install/⌘K/theme/Settings) and reveals this kebab, which collects them into a floating
  // menu. Items reuse the command-palette handlers (getCommands) so they never drift; Install is gated
  // on its affordance being revealed (#442) and reuses the #btn-install handler.
  const overflowBtn = el<HTMLButtonElement>('btn-toolbar-overflow');
  overflowBtn.addEventListener('click', () =>
    toggleOverflowMenu(overflowBtn, () =>
      buildOverflowItems({
        commands: getCommands(),
        openPalette: () => palette.open(),
        installAvailable: !el<HTMLElement>('install-affordance').hidden,
        install: () => el<HTMLButtonElement>('btn-install').click(),
      }),
    ),
  );

  // --- global keyboard shortcuts --------------------------------------------
  // The Cmd/Ctrl-S save listener + the undo/redo listener stay in init(). This handler owns the rest of
  // the global chords; each overlay binds its own Esc, so Esc is intentionally not handled here.
  const onKeydown = (e: KeyboardEvent): void => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod && e.key !== 'F1') return;

    // mod+K always toggles the palette (so it can also dismiss itself); every other global
    // shortcut is suppressed while an overlay is open so it doesn't act on the editor beneath.
    if (mod && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      palette.toggle();
      return;
    }
    if (deps.overlayOpen()) return;

    if (mod && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
      // Mod+Shift+F → open/focus the workspace search panel (toggle closes it).
      e.preventDefault();
      deps.search.toggle();
    } else if (mod && e.shiftKey && (e.key === 'o' || e.key === 'O')) {
      e.preventDefault();
      void deps.openFolder();
    } else if (mod && !e.shiftKey && (e.key === 'n' || e.key === 'N')) {
      e.preventDefault();
      void deps.requestNewModel();
    } else if (mod && e.key === ',') {
      e.preventDefault();
      deps.openSettings();
    } else if (e.key === 'F1') {
      e.preventDefault();
      deps.toggleHelp();
    } else if (mod && e.altKey && e.code === 'KeyB') {
      // Mod+Alt+B → toggle the right Properties panel (the #500 tool-window stripe's collapse toggle,
      // mirroring VS Code's secondary-side-bar chord). Matched on e.code: on macOS, Option composes the
      // 'b' key into another glyph, so `e.key === 'b'` would miss this chord. Checked before the plain
      // Mod+B file-tree branch below so the Alt variant isn't swallowed by it.
      e.preventDefault();
      deps.layoutActions.toggleProperties();
    } else if (mod && !e.altKey && (e.key === 'b' || e.key === 'B')) {
      // Toggle the file tree.
      e.preventDefault();
      deps.toggleFileTree();
    }
  };
  window.addEventListener('keydown', onKeydown);

  return {
    getCommands,
    dispose() {
      window.removeEventListener('keydown', onKeydown);
    },
  };
}
