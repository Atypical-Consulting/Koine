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
import { createCommandRegistry, type Command } from '@atypical/koine-ui';
import { domById } from '@/shared/domById';
import { layoutCommands, type LayoutActions } from '@/shell/layoutCommands';
import { devCommands } from '@/shell/devCommands';
import { canStopCompile, stopRunawayCompile } from '@/host/browser/stopCompile';
import { formatChord } from '@/shared/platform';
import { toggleTheme } from '@/settings/theme';
import { buildOverflowItems, toggleOverflowMenu } from '@/shell/toolbarOverflow';
import { createLauncher } from '@/launcher/createLauncher';
import type { LauncherSources } from '@/launcher/buildCatalog';
import type { LauncherActionDeps } from '@/launcher/actions';
import type { CatalogEntry } from '@/launcher/catalog';
import type { ModelIndex } from '@/model/modelIndex';
import type { GlossaryEntry, Range } from '@/lsp/lsp';
import type { GitLogEntry } from '@/host/types';

// The actions the command surface dispatches to. Each is a thunk into an init() closure or another
// controller, so commandWiring imports none of them directly and stays unit-testable with stubs.
export interface CommandWiringDeps {
  history: { undo(): void; redo(): void };
  /** Format the active document (ide.tsx's formatActive — lsp.format + editor.applyEdits). */
  format(): void;
  goHome(): void;
  openFolder(): void;
  search: { focus(): void; toggle(): void; seed(term: string): void };
  requestNewModel(): void;
  // `buffers` is a THUNK, not a value: the workspace slice REPLACES its buffer Map on every mutation
  // (#982), so a value captured once at construction would freeze at the initial empty Map. Read live.
  workspace: { saveAllDirty(): void; buffers(): ReadonlyMap<string, { uri: string; relPath: string }> };
  copyShareLink(): void;
  controller: {
    runCheck(): void;
    selectOutput(tab: 'generated' | 'contextmap' | 'compatibility'): void;
    selectDocsTab(tab: 'glossary' | 'adr' | 'notes'): void;
    selectCenter(view: 'visual'): void;
    splitCodeCanvas(): void;
    selectTech(view: 'scenarios'): void;
    selectRight(view: 'assistant' | 'source-control'): void;
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

  // --- Spotlight launcher seams (#1143) -------------------------------------
  // The launcher's live catalog + per-result effects reach the shell through these thunks (the same
  // injected-controller idiom as the rest of this bag), so commandWiring builds LauncherSources /
  // LauncherActionDeps without importing the LSP client or the host platform directly.
  /** The joined workspace model index (ide.tsx wires controller.ensureModelIndex). Awaited per open. */
  modelIndex(): Promise<ModelIndex>;
  /** True when the host exposes git (desktop). Gates the launcher's "Recent commits" group. */
  canUseGit: boolean;
  /** The host git log (newest first), or null when the host has no git / can't read it. */
  gitLog(): Promise<GitLogEntry[]> | null;
  /** Open a workspace file and reveal a 0-based range — the launcher's go-to-symbol/rule effect. */
  revealLocation(uri: string, range: Range): void;
  /** Activate a workspace file and surface the LSP references picker at a 0-based range — the launcher's
   * find-usages effect (reuses the editor's Shift-F12 surface at the entry's declaration). */
  findReferences(uri: string, range: Range): void;
  /** Activate a workspace file and open the inline rename field at a 0-based range — the launcher's
   * rename effect (reuses the editor's F2 rename surface → lsp.rename → applyWorkspaceEdit). */
  renameSymbol(uri: string, range: Range): void;
}

export interface CommandWiring {
  /** The live command set (re-read on every palette/overflow open). Exposed for tests + the registry sibling. */
  getCommands(): Command[];
  /**
   * Dispatch a command by id through the registry — a guarded no-op if the id is unknown or the command
   * is currently disabled. Toolbar / chrome buttons and global chords address commands this way (#758)
   * so they can never drift from the catalog entry.
   */
  run(id: string): void;
  /** Release the global keyboard-shortcut listener. */
  dispose(): void;
}

// The id of the palette-toggle command (#758). Registered so global chords — and, in #432, the editor
// keybindings registry — can address "open/close the command palette" by id through run(). Deliberately
// excluded from the palette's own list (the palette never lists the command that opens itself).
export const PALETTE_COMMAND_ID = 'command-palette';

export function createCommandWiring(deps: CommandWiringDeps): CommandWiring {
  // --- command palette command set ------------------------------------------
  // The declarative command registry (#758) is the single source of truth: the static catalog below is
  // registered once, and getCommands() reads it back (enablement-filtered) on every palette / overflow
  // open, composing the dynamic tail (stop-compile + goto rows) on top — behaviour-identical to before.
  // Hints are authored with a literal 'mod' and formatted to ⌘ / Ctrl per platform so the palette, help
  // overlay, and toolbar hint all show the same key.
  const registry = createCommandRegistry();
  function buildStaticCatalog(): Command[] {
    return [
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
      // Registered unconditionally but gated by when() on the host capability, so it is filtered out of
      // the palette when the host can't save (identical to the old conditional spread) AND the toolbar
      // button's run('save-project-to-disk') is a guarded no-op rather than an unknown-id warn if the
      // hidden button is ever force-shown.
      { id: 'save-project-to-disk', title: 'Save to disk…', group: 'File', run: () => void deps.saveProjectToDisk(), when: () => deps.canSaveProjects },
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
      // Stop a runaway compile (#353): terminate the WASM worker and boot a fresh one. Gated by when()
      // so it surfaces only while a compile is actually in flight (#469) — idle, it stays out of the
      // palette and is a no-op if dispatched; the main-thread fallback has no worker to terminate, so
      // canStopCompile() is false. getCommands() re-reads isEnabled on every open, so it appears and
      // disappears with the live in-flight state exactly as the old conditional push did.
      { id: 'stop-compile', title: 'Stop compilation (restart compiler)', group: 'Workspace', run: () => stopRunawayCompile(), when: () => canStopCompile() },
    ];
  }
  // Register the static catalog once at construction — registration order === palette order.
  for (const cmd of buildStaticCatalog()) registry.register(cmd);

  // The registered static catalog, hiding any command whose when() is currently false (the dev
  // store-inspector, stop-compile) and the palette-toggle meta-command, with each hint platform-formatted.
  // Both consumers compose from this: the palette (getCommands) appends the dynamic goto: rows; the
  // launcher's `>` mode (launcherSources.commands) uses it as-is (#1145 review — was duplicated).
  function enabledCommands(): Command[] {
    return registry
      .all()
      .filter((c) => c.id !== PALETTE_COMMAND_ID && registry.isEnabled(c.id))
      .map((c) => (c.hint ? { ...c, hint: formatChord(c.hint) } : c));
  }

  function getCommands(): Command[] {
    const cmds = enabledCommands();

    // Surface every open file as a "Go to File" entry so the palette doubles as a
    // fuzzy quick-open (type part of a path to jump). The palette re-reads this on each open. Goto rows
    // carry no hint, so appending them after enabledCommands()'s formatChord map is behaviour-identical.
    for (const buf of Array.from(deps.workspace.buffers().values()).sort((a, b) => a.relPath.localeCompare(b.relPath))) {
      cmds.push({ id: 'goto:' + buf.uri, title: buf.relPath, group: 'Go to File', run: () => deps.openUri(buf.uri) });
    }

    return cmds;
  }

  // --- Spotlight launcher (#1143) -------------------------------------------
  // The old ⌘K command palette is retired in favour of the Spotlight launcher: one overlay that folds the
  // command catalog (`>` mode), open-file quick-open (`/` mode), and the domain model (symbols / events /
  // rules / glossary / commits) into a single fuzzy surface. commandWiring builds its live LauncherSources
  // (the catalog join) and LauncherActionDeps (the per-result effects) from the same injected `deps` the
  // rest of this module uses, so it stays import-light and unit-testable with stubs.

  // The launcher's `>` mode ranks exactly `enabledCommands()` (above): the enablement-filtered static
  // catalog MINUS the launcher-toggle meta-command and WITHOUT the dynamic goto: rows (those become the
  // launcher's Files mode, sourced from LauncherSources.files()).

  // LauncherSources.glossary() is SYNC, but the glossary entries come from the async model index; cache
  // them off each modelIndex() resolve (buildCatalog always awaits modelIndex() before reading glossary())
  // and return the cache — an empty list until the first open.
  let cachedGlossary: GlossaryEntry[] = [];

  const launcherSources: LauncherSources = {
    modelIndex: async () => {
      const index = await deps.modelIndex();
      cachedGlossary = index.glossary.entries;
      return index;
    },
    commands: () => enabledCommands(),
    files: () => Array.from(deps.workspace.buffers().values()),
    gitLog: () => (deps.canUseGit ? deps.gitLog() : null),
    canUseGit: deps.canUseGit,
    glossary: () => cachedGlossary,
  };

  // Resolve a symbol / event / rule entry to its declaring file + 0-based range and reveal it. Prefers the
  // joined diagram node's sourceSpan (the file the declaration lives in) with the entry's nameRange; falls
  // back to a plain open when only a file uri is known, and is a safe no-op when neither is present (an
  // undrawn element carries no source location — see the task report's degrade list).
  function gotoEntry(entry: CatalogEntry): void {
    const file = entry.element?.node?.sourceSpan?.file ?? entry.file ?? null;
    const range = entry.nameRange ?? entry.element?.entry.nameRange ?? null;
    if (file && range) deps.revealLocation(file, range);
    else if (file) deps.openUri(file);
  }

  // Bind each high-level launcher action to the nearest real shell seam. Actions without a dedicated seam
  // yet (peek, reveal-in-explorer, open-changes, commit view) DEGRADE to the closest reasonable one
  // (reveal/open, or the Source Control panel) — every one is safe to invoke; the report lists the degrades
  // as follow-ups. `rename` and `revert` are the exception: silently jumping / opening the wrong panel is
  // MISLEADING (looks like it worked), so they honestly toast "not available yet" via the launcher's own
  // `.lx-toast` (#1145 review). `toast` here stays a no-op — LauncherPanel renders its own confirmation.
  const actionDeps: LauncherActionDeps = {
    gotoDefinition: (entry) => gotoEntry(entry),
    // Surface the references picker at the entry's declaration (#1165): open + activate its file and
    // show the editor's Shift-F12 references list at the name position. Falls back to focusing the
    // text-search box only when the entry carries no source location (an undrawn element).
    findUsages: (entry) => {
      const file = entry.element?.node?.sourceSpan?.file ?? entry.file ?? null;
      const range = entry.nameRange ?? entry.element?.entry.nameRange ?? null;
      if (file && range) deps.findReferences(file, range);
      else deps.search.focus();
    },
    // A non-navigating quick-look (#1165): pin the entry's read-only preview into the launcher's own
    // preview pane instead of jumping to it (gotoEntry navigates — that's what ↵ is for). Leaves the
    // editor selection / active document untouched.
    peek: (entry) => launcher.peek(entry),
    // Inline rename from the launcher (#1165): open the editor's F2 rename field at the entry's
    // declaration (which collects the new name and applies lsp.rename → applyWorkspaceEdit). Close the
    // launcher first so the inline field isn't trapped behind the `.lx-scrim`. An entry with no source
    // location (an undrawn element) can't be renamed — say so honestly instead of a silent no-op.
    rename: (entry) => {
      const file = entry.element?.node?.sourceSpan?.file ?? entry.file ?? null;
      const range = entry.nameRange ?? entry.element?.entry.nameRange ?? null;
      if (file && range) {
        launcher.close();
        deps.renameSymbol(file, range);
      } else {
        launcher.toast('This symbol has no source location to rename.');
      }
    },
    copy: (text) => void navigator.clipboard?.writeText?.(text),
    openFile: (entry) => {
      if (entry.file) deps.openUri(entry.file);
    },
    openFileChanges: () => deps.controller.selectRight('source-control'),
    revealFile: (entry) => {
      if (entry.file) deps.openUri(entry.file);
    },
    openGlossary: () => deps.controller.selectDocsTab('glossary'),
    // Seed the workspace search with the term's bare name (#1165) — the identifier that appears
    // throughout the model source, not the dotted qualified name — instead of the old empty focus().
    findInModel: (entry) => deps.search.seed(entry.title),
    gotoRule: (entry) => gotoEntry(entry),
    viewCommit: () => deps.controller.selectRight('source-control'),
    revertCommit: () => launcher.toast('Reverting a commit isn’t available from the launcher yet.'),
    runCommand: (entry) => {
      if (entry.cmdId) registry.run(entry.cmdId);
    },
    toast: () => {},
  };

  const launcher = createLauncher(launcherSources, actionDeps);

  // Register the launcher-toggle meta-command under the SAME id the old palette used (#758): global chords
  // (and #432's keybindings registry) address "open the launcher" by id through run(); getCommands()
  // filters PALETTE_COMMAND_ID out so it never appears as a row.
  registry.register({ id: PALETTE_COMMAND_ID, title: 'Command launcher', run: () => launcher.toggle() });

  // --- toolbar buttons unique to this phase ---------------------------------
  // The command bar (chrome v2, #923): a full command field (search glyph + placeholder + keycap) that
  // opens the palette. Its markup is static in index.html, so we DON'T wipe its children — we only fill
  // the keycap with the platform chord (⌘K / Ctrl+K) and wire the click. The button's accessible name
  // stays "Open command palette" (aria-label); the visible keycap is aria-hidden decorative chrome, so
  // this can't break WCAG 2.5.3 (Label in Name).
  const cmdBar = document.querySelector('.palette-hint');
  if (cmdBar) {
    const kbd = cmdBar.querySelector('[data-role="cmd-kbd"]');
    if (kbd) kbd.textContent = formatChord('mod+K');
    else {
      // Fallback for a bare hint (e.g. a minimal test fixture with no keycap span): render the chord.
      const chord = document.createElement('span');
      chord.setAttribute('aria-hidden', 'true');
      chord.textContent = formatChord('mod+K');
      cmdBar.appendChild(chord);
    }
    cmdBar.addEventListener('click', () => registry.run(PALETTE_COMMAND_ID));
  }
  // Each toolbar button dispatches its command by id (#758) so it can never drift from the palette entry
  // or re-derive the action — the registry's run() owns the effect (and its enablement guard). Save-to-disk,
  // Check and the theme toggle left the bar in chrome v2 (#923); they remain reachable via the palette /
  // mobile overflow through their catalog commands (save-project-to-disk / check / toggle-theme).
  domById<HTMLButtonElement>('btn-home').addEventListener('click', () => registry.run('home'));
  domById<HTMLButtonElement>('btn-new').addEventListener('click', () => registry.run('new-model'));
  domById<HTMLButtonElement>('btn-generate-project').addEventListener('click', () => registry.run('generate-project'));
  // The toolbar gear opens the transient Settings overlay over the deck (#center-panel-settings) — now the
  // single Settings surface every entry point shares (#731), via the prefs command.
  domById<HTMLButtonElement>('btn-prefs').addEventListener('click', () => registry.run('prefs'));

  // Mobile overflow "More" (⋮) menu (#528): at ≤ $bp-narrow the toolbar hides its secondary actions
  // (Save/Check/Install/⌘K/theme/Settings) and reveals this kebab, which collects them into a floating
  // menu. Items reuse the command-palette handlers (getCommands) so they never drift; Install is gated
  // on its affordance being revealed (#442) and reuses the #btn-install handler.
  const overflowBtn = domById<HTMLButtonElement>('btn-toolbar-overflow');
  overflowBtn.addEventListener('click', () =>
    toggleOverflowMenu(overflowBtn, () =>
      buildOverflowItems({
        commands: getCommands(),
        openPalette: () => launcher.open(),
        installAvailable: !domById<HTMLElement>('install-affordance').hidden,
        install: () => domById<HTMLButtonElement>('btn-install').click(),
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
      // Dispatch through the registry so the chord resolves to a command id (#758) — the seam #432 lifts
      // the rest of the global chords into.
      e.preventDefault();
      registry.run(PALETTE_COMMAND_ID);
      return;
    }
    // The launcher renders its own overlay (`.lx-scrim`), which the shell's overlayOpen() doesn't see, so
    // OR its open state into the guard: while it's open no other global chord acts on the editor beneath.
    if (deps.overlayOpen() || launcher.isOpen) return;

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
    run: (id) => registry.run(id),
    dispose() {
      window.removeEventListener('keydown', onKeydown);
    },
  };
}
