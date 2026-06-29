// The lazy-panel host, extracted from ide.tsx's init() (#757). Owns the on-demand construction of the
// Settings center page, the AI assistant, the scenario runner, the integrated terminal, and the Review
// panel — each built the first time its surface is shown and reused thereafter. The laziness is the
// point: nothing here is constructed until first use (the Anthropic SDK, the PTY broker, etc. stay
// unloaded until the user opens the panel). Pure structural lift: each ensure* keeps its exact config;
// it just moves out of init() and reaches the editor / workspace / host through the injected `deps`.
import { createSettingsPage, type SettingsPageHandle } from '@/settings/settingsPage';
import { createAssistantPanel, type AssistantPanel, type AssistantContext } from '@/ai/aiPanel';
import { createScenarioPanel, type ScenarioPanel } from '@/scenarios/scenarioPanel';
import { createTerminalPanel, type TerminalPanel } from '@/shell/terminal/terminalPanel';
import { createReviewPanel, type ReviewPanel } from '@/review/ReviewPanel';
import { loadSettings } from '@/settings/persistence';
import { severityErrorOrWarning } from '@/lsp/severity';
import { domById } from '@/shared/domById';
import type { PrefsCallbacks } from '@/settings/prefs';
import type { Platform } from '@/host';
import type { KoineLsp, SourceSpan } from '@/lsp/lsp';

export interface PanelHostDeps {
  prefsCallbacks: PrefsCallbacks;
  /** The store's pending landing category (appStore.settingsCategory) for the Settings page. */
  settingsCategory(): string | undefined;
  /** Record the Settings-open intent in the store (controller.showSettings) before building the page. */
  showSettings(category?: string): void;
  /** The active document's text (editor.getDoc) — the assistant's source context. */
  getSource(): string;
  /** The editor's current selection (or the cursor line; null → whole file) — the assistant's selection. */
  getSelection(): { text: string } | null;
  /** Apply an assistant-produced model to the active editor (replaceActiveDoc). */
  applyModel(source: string): void;
  /** The active file's diagnostics (editorSession.diagnosticsFor) for the assistant context. */
  diagnosticsFor(uri: string): Array<{ range: { start: { line: number; character: number } }; severity?: number; message: string }>;
  workspace: {
    activeUri(): string;
    buffers: ReadonlyMap<string, { name?: string; relPath: string; text: string }>;
    folderRootToken(): string;
    applyFileEdit(relPath: string, body: string): Promise<unknown>;
  };
  /** The controller's cached domain index (two LSP recompiles), reused until the next edit clears it. */
  getCachedDomainIndex(): Promise<AssistantContext['domainIndex'] | null>;
  lsp: KoineLsp;
  platform: Platform;
  setStatus(message: string, kind: 'green' | 'error'): void;
  reviewStore: NonNullable<Parameters<typeof createReviewPanel>[0]>['store'];
  gotoSourceSpan(span: Pick<SourceSpan, 'file' | 'line' | 'column' | 'endLine' | 'endColumn'>): void;
  reviewAuthorName(): string;
}

export interface PanelHost {
  /** The ONE entry every Settings affordance routes through: record intent in the store, build/refresh the page. */
  openSettings(category?: string): void;
  /** The AI assistant panel (built lazily; the SDK loads only on send). */
  ensureAssistant(): AssistantPanel;
  /** The scenario-runner panel (built lazily). */
  ensureScenarios(): ScenarioPanel;
  /** The integrated terminal panel (built lazily; brokers a real PTY on desktop). */
  ensureTerminal(): TerminalPanel;
  /** The Review panel (built lazily). */
  ensureReview(): void;
  /** Re-resolve the terminal's xterm theme on a theme flip (no-op until the terminal is built). */
  applyTerminalTheme(): void;
  /** Stop the brokered terminal when the page goes away (pagehide) — no-op until built. */
  disposeTerminal(): void;
  /** Full teardown: dispose the terminal + Review panel + Settings page if they were built. */
  dispose(): void;
}

export function createPanelHost(deps: PanelHostDeps): PanelHost {
  // ide.ts owns the assistant's lifecycle; the #view-assistant / #view-scenarios hosts are looked up at
  // construction (cheap DOM lookups), but the panels themselves stay unbuilt until first ensure*.
  const assistantView = domById('view-assistant');
  const scenariosView = domById('view-scenarios');

  // The gear-launched Settings center page (#center-panel-settings) is the SINGLE Settings surface (#731).
  // Built LAZILY on the first route into Settings: createSettingsPage runs its first "show", which fires
  // the on-show MCP sidecar (re)start when enabled (issue #735) — so constructing it IS showing it, and an
  // eager build would spawn that background process before the user ever opens Settings.
  let settingsPage: SettingsPageHandle | null = null;
  function ensureSettingsPage(): void {
    // The landing category is the store's `settingsCategory` (set by controller.showSettings) — the single
    // source of truth, so this host reads it back rather than threading a parallel argument. Null ⇒ keep
    // the pane's last-used tab.
    const category = deps.settingsCategory() ?? undefined;
    if (settingsPage) {
      // Already built — re-sync from the live settings on re-open, so a theme/setting changed from the
      // toolbar or palette while Settings sat hidden shows correctly when it's brought back; land on
      // `category` when one was requested.
      settingsPage.refresh(category);
      return;
    }
    settingsPage = createSettingsPage(
      { header: domById('settings-page-header'), body: domById('settings-page-body') },
      deps.prefsCallbacks,
    );
    // A first build already paints from the live settings; only a deep-link needs the extra repaint to
    // land on its tab (a plain open keeps the pane's last-used category).
    if (category) settingsPage.refresh(category);
  }

  // The ONE entry every Settings affordance routes through (#731): the toolbar gear, the command palette's
  // "Settings…" / "About", the mod+, chord, and the Assistant's "Open Settings". Record the intent in the
  // store FIRST, then build/refresh the center page from that store state.
  function openSettings(category?: string): void {
    deps.showSettings(category);
    ensureSettingsPage();
  }

  // The AI assistant panel is created lazily the first time its center pane is shown (the Anthropic SDK
  // is dynamically imported inside ai.ts, so creating the panel does not load it — only sending).
  let assistant: AssistantPanel | null = null;
  function ensureAssistant(): AssistantPanel {
    if (assistant) return assistant;
    assistant = createAssistantPanel({
      container: assistantView,
      getProvider: () => loadSettings().aiProvider,
      getBaseUrl: () => loadSettings().aiBaseUrl,
      getApiKey: () => loadSettings().aiApiKey,
      getModel: () => {
        const s = loadSettings();
        return s.aiProvider === 'openai' ? s.aiModelOpenai : s.aiModel;
      },
      getTemperature: () => loadSettings().aiTemperature,
      getContext: async () => {
        const diagnostics = deps.diagnosticsFor(deps.workspace.activeUri()).map((d) => ({
          line: d.range.start.line + 1,
          col: d.range.start.character + 1,
          severity: severityErrorOrWarning(d.severity),
          message: d.message,
        }));
        const base: AssistantContext = {
          fileName: deps.workspace.buffers.get(deps.workspace.activeUri())?.name ?? 'model.koi',
          source: deps.getSource(),
          diagnostics,
        };
        // The file/diagnostics snapshot above is cheap and per-call; the domain index is the expensive
        // part (two LSP recompiles), so the controller builds it once and reuses it until the next edit
        // clears the cache (invalidateDocViews) rather than rebuilding it on every send.
        const domainIndex = await deps.getCachedDomainIndex();
        return domainIndex ? { ...base, domainIndex } : base;
      },
      getSelection: () => deps.getSelection(),
      onApplyModel: (source) => deps.applyModel(source),
      onOpenPrefs: () => openSettings(),
      // Per-workspace conversation key: each opened folder keeps its own transcript; scratch mode
      // (no host folder behind it) uses the literal 'scratch'.
      getWorkspaceKey: () => deps.workspace.folderRootToken() ?? 'scratch',
      // Let the assistant call koine tools (validate/compile/format), executed by the host: in-WASM in
      // the browser, via the `koine mcp --http` sidecar on the desktop.
      runCompilerTool: deps.platform.runCompilerTool
        ? (name, argsJson) => deps.platform.runCompilerTool!(name, argsJson)
        : undefined,
      // Opt-in: advertising tools makes local servers (LM Studio) buffer instead of stream, so the
      // tools are only offered when the user enables them in Settings → Assistant.
      getUseTools: () => loadSettings().aiAgenticTools,
      // On by default (#257): constrain a grammar-capable local model to the Koine GBNF, and
      // validate-and-repair every other provider's output before "Apply to editor" is enabled.
      getConstrainGrammar: () => loadSettings().aiConstrainGrammar,
      // The GBNF comes from the host's resident compiler. Browser-host only — the desktop host omits
      // gbnfGrammar(), so the panel falls back to parse-and-repair there.
      getGrammar: deps.platform.gbnfGrammar ? () => deps.platform.gbnfGrammar!() : undefined,
      // Workspace snapshot for multi-file agentic editing: relPath→current text of every open buffer.
      getWorkspaceFiles: () => Object.fromEntries([...deps.workspace.buffers.values()].map((b) => [b.relPath, b.text])),
      // Host executor for the staged list/read/write edit tools (browser WASM / desktop MCP).
      runEditTool: deps.platform.runEditTool ? (name, argsJson, session) => deps.platform.runEditTool!(name, argsJson, session) : undefined,
      // Once-per-turn whole-staged-workspace validation (issue #474): the loop calls this a single time
      // at end of turn (browser WASM DiagnoseWorkspace / desktop MCP koine_validate) instead of after
      // each write, and the panel surfaces the diagnostics for pre-apply review.
      validateStaged: deps.platform.validateStagedWorkspace ? (session) => deps.platform.validateStagedWorkspace!(session) : undefined,
      // Commit an accepted multi-file change set through the controller (new files under the folder root).
      // applyFileEdit returns null (not throw) on a failed write/create — collect those relPaths so the
      // panel reports a partial apply instead of a false "Applied ✓".
      onApplyChangeSet: async (files) => {
        const failed: string[] = [];
        for (const f of files) {
          if ((await deps.workspace.applyFileEdit(f.relPath, f.body)) === null) failed.push(f.relPath);
        }
        return { failed };
      },
    });
    return assistant;
  }

  // The scenario-runner panel (#149) is created lazily the first time its tab is shown; the controller
  // calls refresh() on every open so the catalog tracks the latest model.
  let scenarios: ScenarioPanel | null = null;
  function ensureScenarios(): ScenarioPanel {
    if (scenarios) return scenarios;
    scenarios = createScenarioPanel({
      container: scenariosView,
      lsp: deps.lsp,
      setStatus: (message) => deps.setStatus(message, 'green'),
    });
    return scenarios;
  }

  // The integrated terminal panel (#256), created lazily the first time its bottom-panel tab is shown
  // (the scenarios/assistant pattern). It is rooted at the opened workspace folder (or no cwd in
  // no-folder mode); the desktop host brokers a real PTY, the browser host renders a placeholder.
  let terminal: TerminalPanel | null = null;
  function ensureTerminal(): TerminalPanel {
    if (terminal) return terminal;
    terminal = createTerminalPanel({
      parent: domById('panel-terminal'),
      platform: deps.platform,
      cwd: () => deps.workspace.folderRootToken() || null,
      // Read the override fresh at each (re)start (#467), so changing the setting takes effect on the
      // next shell spawn; empty ⇒ the host's default `-l` login shell. It's a global, not workspace-scoped.
      shellArgs: () => loadSettings().terminalShellArgs,
    });
    return terminal;
  }

  // The Review panel (#259), created lazily the first time its bottom-panel tab is shown (the
  // terminal/scenarios pattern). It renders the review store grouped by file; clicking a thread jumps the
  // editor to its span via the shared gotoSourceSpan.
  let review: ReviewPanel | null = null;
  function ensureReview(): void {
    if (review) return;
    review = createReviewPanel({
      parent: domById('panel-review'),
      store: deps.reviewStore,
      onNavigate: (file, span) =>
        void deps.gotoSourceSpan({ file, line: span.line, column: span.column, endLine: span.endLine, endColumn: span.endColumn }),
      author: () => deps.reviewAuthorName(),
    });
  }

  return {
    openSettings,
    ensureAssistant,
    ensureScenarios,
    ensureTerminal,
    ensureReview,
    applyTerminalTheme() {
      terminal?.applyTheme();
    },
    disposeTerminal() {
      terminal?.dispose();
    },
    dispose() {
      terminal?.dispose(); // stop the brokered shell + dispose xterm (#256)
      settingsPage?.destroy(); // tear down the Settings center page (pane/editor + header toggle) if it was opened
      review?.dispose(); // unmount the Review panel + release its store subscription (#259)
    },
  };
}
