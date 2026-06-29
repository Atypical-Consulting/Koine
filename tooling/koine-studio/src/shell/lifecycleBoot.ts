// The boot + lifecycle owner, extracted from ide.tsx's init() (#757). Runs the language-server start
// ladder (seed emit targets → open the shared / single / restored / default workspace), performs a Home
// start-intent, subscribes to consume an intent on every later route into the editor, and owns the
// aggregate teardown that disposes every controller in order. Pure structural lift: the boot sequence
// keeps its exact branches; it just moves out of init() and reaches the workspace / host / controllers
// through the injected `deps`. Constructing it IS booting — init() news it up last and returns its
// teardown, so init() is now a thin composition root.
import { appStore } from '@/store/index';
import { setEmitTargets } from '@/shared/emitTargets';
import { takeStartIntent, type StartIntent } from '@/shell/bootIntent';
import { clearModelHash, readModelFromHash } from '@/export/share';
import { getLastWorkspace, setLastWorkspace, clearLegacyScratch } from '@/settings/persistence';
import { type Template } from '@/welcome/templates';

// The host's reserved default-workspace token (mirrors host/browser/fs.ts DEFAULT_WS_TOKEN). Parentheses
// can't appear in a real picked-folder name, so it never collides. Used as the lastWorkspace pointer
// after "New" / a default-workspace open (#535).
const DEFAULT_WS_TOKEN = '(default)';

// Which workspace tokens the cold-boot ladder is allowed to silently re-open (#535). OPFS-backed dirs —
// the default workspace and every materialized `example-*` dir — re-acquire from IndexedDB with NO
// permission prompt, so boot can restore them. A *picked* folder handle needs a `requestPermission`
// re-grant that requires a user gesture boot can't supply, so it must stay a manual Recents click.
function isOpfsInternalToken(token: string): boolean {
  return token === DEFAULT_WS_TOKEN || token.startsWith('example-');
}

export interface LifecycleBootDeps {
  lsp: {
    onServerRestart(cb: () => void): void;
    start(): Promise<void>;
    emitTargets(): Promise<Parameters<typeof setEmitTargets>[0]>;
  };
  /** The model carried in the URL hash (a shared playground link), or null. */
  shared: ReturnType<typeof readModelFromHash>;
  /** The peeked legacy single-file scratch buffer (pre-workspace Studio), or null. */
  legacyScratch: string | null;
  /** The Billing SEED — the default-workspace seed when there's no legacy scratch. */
  seed: string;
  importSharedWorkspace(files: { relPath: string; text: string }[], active?: string): Promise<void>;
  openWorkspaceWith1File(text: string): Promise<void>;
  openFolderPath(folder: string, opts?: { recent?: boolean }): Promise<{ ok: boolean }>;
  /** Open the host's persistent default workspace (workspace.openDefaultWorkspaceFlow). */
  openHostDefaultWorkspaceFlow(seed: string): Promise<{ opened: boolean }>;
  setStatus(text: string, kind: 'green' | 'error'): void;
  /** Write a plain message into the emitted-code viewer (output.setContent). */
  setOutput(content: string, lang: 'plain'): void;
  invalidateDocViews(): void;
  refreshActiveSurfaces(): void;
  persistsWorkspace: boolean;
  showMemoryOnlyBanner(): void;
  // Start-intent actions — reused from the in-editor start console so Home and the editor share one path.
  newModel(): Promise<void>;
  openFolder(): Promise<void>;
  openRecentFolder(path: string): Promise<void>;
  openExample(template: Template): Promise<void>;
  // Teardown fan-out, called in order; lifecycleBoot adds its own route-intent unsubscribe.
  disposers: {
    controller(): void;
    editorSession(): void;
    commandWiring(): void;
    layout(): void;
    overlays(): void;
    canvasWrite(): void;
    panels(): void;
    reviewStoreSub(): void;
    autoSave(): void;
    exportMenuDismiss(): void;
  };
}

export interface LifecycleBoot {
  /** Release the IDE's deferred work — disposes every controller in order (the test suite calls it between boots). */
  teardown(): void;
}

export function createLifecycleBoot(deps: LifecycleBootDeps): LifecycleBoot {
  const { shared, legacyScratch, seed } = deps;

  // Boot/empty-state: open the host's persistent default workspace. The clearLegacyScratch + the
  // OPFS-error output line are ide-specific, so they wrap workspace.openDefaultWorkspaceFlow here.
  async function openDefaultWorkspaceFlow(seedDoc: string): Promise<void> {
    const { opened } = await deps.openHostDefaultWorkspaceFlow(seedDoc);
    if (!opened) {
      // The browser now falls back to an in-memory workspace, so this only fires if even that failed.
      deps.setOutput('// Koine Studio could not open a workspace in this browser.', 'plain');
      return;
    }
    // The default workspace is now the open one, so point lastWorkspace at it (#535).
    setLastWorkspace(DEFAULT_WS_TOKEN);
    // Token confirmed — clear the legacy scratch key now so the migration is non-destructive.
    clearLegacyScratch();
    // No-OPFS browsers run on the in-memory fallback: warn once so the user exports rather than loses work.
    if (!deps.persistsWorkspace) deps.showMemoryOnlyBanner();
  }

  // Perform the action the user chose on the Home route (#368), handed across via the start-intent. No
  // unsaved work can exist at a fresh boot, so these skip the confirm-and-replace guard (newModel directly).
  async function runStartIntent(intent: StartIntent): Promise<void> {
    switch (intent.kind) {
      case 'new':
        await deps.newModel();
        break;
      case 'open-folder':
        await deps.openFolder();
        break;
      case 'open-recent':
        await deps.openRecentFolder(intent.path);
        break;
      case 'open-example':
        await deps.openExample(intent.template);
        break;
    }
  }

  // Boot: attach listeners (inside start) before messages flow, then open the doc.
  deps.lsp.onServerRestart(() => {
    // Fresh sidecar is back in sync; refresh whatever doc view is showing.
    deps.invalidateDocViews();
    deps.refreshActiveSurfaces();
  });
  deps.lsp
    .start()
    .then(async () => {
      // Seed the emit-target list from the backend capability query once the server is up (#282).
      // Fire-and-forget: a slow query must NOT block boot. A failed query falls back to the built-ins.
      void deps.lsp.emitTargets().then(setEmitTargets, (e) => {
        console.error('fetching emit targets failed; using the built-in list:', e);
        setEmitTargets(null);
      });

      // The workspace opens once the server is up so each file's didOpen resolves cross-file refs.
      // Isolated try/finally per branch: an open failure must not masquerade as a connection failure.
      if (shared?.kind === 'workspace') {
        try {
          await deps.importSharedWorkspace(shared.files, shared.active);
        } catch (e) {
          console.error('importing shared workspace failed:', e);
          deps.setStatus('could not open shared workspace', 'error');
        } finally {
          clearModelHash();
        }
      } else if (shared?.kind === 'single') {
        try {
          await deps.openWorkspaceWith1File(shared.text);
        } catch (e) {
          console.error('opening shared model failed:', e);
          deps.setStatus('could not open shared model', 'error');
        } finally {
          clearModelHash();
        }
      } else {
        // A start action chosen on the Home route (#368) is queued as a one-shot intent and performed
        // here, once. A plain editor boot has no intent: restore the workspace it was last on (#535).
        // Only an `example-*` dir is re-opened through openFolderPath here (re-acquires with NO prompt);
        // a *picked* folder is never auto-restored, by design. The default workspace flows through
        // openDefaultWorkspaceFlow below. On any restore failure we also fall through to the default.
        const intent = takeStartIntent();
        if (intent) {
          await runStartIntent(intent);
        } else {
          const last = getLastWorkspace();
          const restoredExample =
            !!last && last !== DEFAULT_WS_TOKEN && isOpfsInternalToken(last)
              ? (await deps.openFolderPath(last, { recent: false })).ok
              : false;
          // Legacy-scratch migration is deliberately NOT done on the example-restore path: the scratch
          // content is only ever preserved by being seeded into the default workspace.
          if (!restoredExample) await openDefaultWorkspaceFlow(legacyScratch ?? seed);
        }
      }
    })
    .catch((e) => {
      deps.setStatus('connection failed', 'error');
      deps.setOutput('// failed to start language server\n' + String(e), 'plain');
    });

  // The IDE shell boots once and stays alive across Home↔Editor route swaps (main.ts toggles visibility,
  // it doesn't re-init). The boot ladder above consumes a start-intent only on that first boot — so a
  // start action taken on a *return* visit to Home would otherwise be dropped. Consume any queued intent
  // on every later transition INTO the editor route. The first transition already happened before this
  // listener exists, so it never double-fires with the ladder.
  const unsubRouteIntent = appStore.subscribe((s, prev) => {
    if (s.route === 'editor' && prev.route !== 'editor') {
      const intent = takeStartIntent();
      if (intent) void runStartIntent(intent);
    }
  });

  return {
    // A teardown the host can call to release the IDE's deferred work. Production runs for the page
    // lifetime and ignores it; the test suite calls it between boots so pending debounce timers can't
    // fire into a torn-down happy-dom. Order is preserved from the original aggregate teardown.
    teardown() {
      deps.disposers.controller();
      deps.disposers.editorSession();
      deps.disposers.commandWiring();
      deps.disposers.layout();
      deps.disposers.overlays();
      deps.disposers.canvasWrite();
      deps.disposers.panels();
      deps.disposers.reviewStoreSub();
      deps.disposers.autoSave();
      unsubRouteIntent();
      deps.disposers.exportMenuDismiss();
    },
  };
}
