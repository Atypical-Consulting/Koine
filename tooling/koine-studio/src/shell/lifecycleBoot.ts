// The boot + lifecycle owner, extracted from ide.tsx's init() (#757). Runs the language-server start
// ladder (seed emit targets → open the shared / single / restored / default workspace), performs a Home
// start-intent, subscribes to consume an intent on every later route into the editor, and owns the
// aggregate teardown that disposes every controller in order. Pure structural lift: the boot sequence
// keeps its exact branches; it just moves out of init() and reaches the workspace / host / controllers
// through the injected `deps`. Constructing it IS booting — init() news it up last and returns its
// teardown, so init() is now a thin composition root.
import { appStore } from '@/store/index';
import { setEmitTargets } from '@/shared/emitTargets';
import { peekStartIntent, takeStartIntent, type StartIntent } from '@/shell/bootIntent';
import { clearModelHash, readModelFromHash } from '@/export/share';
import { getLastWorkspace, setLastWorkspace, clearLegacyScratch } from '@/settings/persistence';
import { basename } from '@/shared/path';
import { type Template } from '@/welcome/templates';
import { type WorkspaceOpLock } from '@/shell/workspaceOpLock';

// The host's reserved default-workspace token (mirrors host/browser/fs.ts DEFAULT_WS_TOKEN). Parentheses
// can't appear in a real picked-folder name, so it never collides. Used as the lastWorkspace pointer
// after "New" / a default-workspace open (#535).
const DEFAULT_WS_TOKEN = '(default)';

// Which workspace tokens the cold-boot ladder may silently re-open (#535) is a HOST capability, not a
// token-shape guess made here: the browser mints `example-*` slugs, the desktop mints absolute
// `<appData>/workspaces/*` paths, and only the host knows which of its own tokens re-acquire without a
// permission gesture. The ladder asks `deps.isAutoRestorableToken`. (The desktop bug this fixes: its
// path tokens matched the old browser-only `example-*` test nowhere, so every reload reverted a
// just-opened template to the blank default.)

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
  /** Returns whether a workspace was actually opened, so the boot ladder can fall back to the default. */
  importSharedWorkspace(files: { relPath: string; text: string }[], active?: string): Promise<boolean>;
  openWorkspaceWith1File(text: string): Promise<void>;
  openFolderPath(folder: string, opts?: { recent?: boolean; userInitiated?: boolean }): Promise<{ ok: boolean }>;
  /** Host capability: may the cold-boot ladder silently re-open this persisted last-workspace token? */
  isAutoRestorableToken(token: string): Promise<boolean>;
  /** True when a workspace is already open (the user opened one while the server was still connecting),
   *  so the intent-less restore ladder must not tear it down. */
  hasOpenWorkspace(): boolean;
  /** Overlays.confirmReplaceWork — resolves true when nothing is dirty or the user confirmed the loss. */
  confirmReplaceWork(title: string, confirmLabel: string): Promise<boolean>;
  /** The boot-wide workspace-open mutex, owned by ide.tsx's composition root so the toolbar / keyboard /
   *  palette / onWorkspaceEmptied entry points serialize against this ladder's opens too (#1088). */
  workspaceOpLock: WorkspaceOpLock;
  /** Open the host's persistent default workspace (workspace.openDefaultWorkspaceFlow). */
  openHostDefaultWorkspaceFlow(seed: string): Promise<{ opened: boolean }>;
  setStatus(text: string, kind: 'error'): void;
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
    /** Release the workspace-slice seam subscription (activationSeq/workspaceEditSeq/entriesSeq/saveSeq
     *  watcher) so it can't fire into a torn-down IDE. Appended after reviewStoreSub. (#982) */
    workspaceSeams(): void;
    /** Release the theme store subscription (the diagram + terminal re-theme fan-out, #983) so it can't
     *  fire into a torn-down IDE. Order-independent of the others. */
    theme(): void;
    autoSave(): void;
    exportMenuDismiss(): void;
    /** Remove the global keydown listeners for Save (⌘S/Ctrl-S) and Undo/Redo registered
     *  directly in ide.tsx init(). Without this, repeated init()/teardown cycles in vitest
     *  accumulate stale window listeners. (#789) */
    editorKeys(): void;
    /** Release the status bar's folder-token subscription and unmount its two Preact panels so they
     *  don't survive a teardown. Appended after editorKeys — order-independent of the others. (#980) */
    statusBar(): void;
    /** Clear the explorer's pending filter debounce, close its floating menu, and detach its root el so
     *  its persistent listeners and deferred applyFilter can't fire after teardown. (#980) */
    explorer(): void;
  };
}

export interface LifecycleBoot {
  /** Release the IDE's deferred work — disposes every controller in order (the test suite calls it between boots). */
  teardown(): void;
}

// A human-readable name for a queued Home intent, used to name a boot failure (#973) instead of only
// a generic "connection failed" — e.g. "Billing" for an example template, the folder's trailing path
// segment for a recent folder. `open-folder` has no path yet (it opens a picker), so it names the action.
function intentLabel(intent: StartIntent): string {
  switch (intent.kind) {
    case 'new':
      return 'a new model';
    case 'open-folder':
      return 'the selected folder';
    case 'open-recent':
      return basename(intent.path);
    case 'open-example':
      return intent.template.name;
  }
}

export function createLifecycleBoot(deps: LifecycleBootDeps): LifecycleBoot {
  const { shared, legacyScratch, seed } = deps;

  // Set (only) in the boot ladder's .catch when a Home intent was stranded by a failed lsp.start().
  // The first onServerRestart after that consumes and re-runs it (#973); a normal mid-session restart
  // (this stays false) keeps the plain view-refresh behavior.
  let bootIntentPending = false;

  // Only one workspace-opening operation may run at a time. The shared-import branches below and
  // runStartIntent (the cold-boot intent, the route-intent subscription's return-visit intent, and the
  // onServerRestart recovery re-dispatch all funnel through it) queue through this so a Home action
  // taken during the lsp.start() connect window can't race an in-flight shared-link import — or
  // another Home action — and silently clobber it (#1046). Each call waits for whatever is already
  // running rather than firing blindly; a queued call re-checks its own preconditions (e.g.
  // hasOpenWorkspace()) once it's actually its turn.
  //
  // The lock is INJECTED, not private (#1088): ide.tsx owns the single instance and shares it with the
  // toolbar / keyboard / palette / onWorkspaceEmptied entry points, which reach the same underlying
  // newModel()/openFolder() without ever passing through this file. The raw `deps.newModel`/
  // `deps.openFolder` closures handed to us stay UNwrapped — runStartIntent already holds the lock when
  // it calls them, and the queue has no re-entrancy detection, so a self-locking action would deadlock.
  const withWorkspaceOpLock = <T>(op: () => Promise<T>): Promise<T> => deps.workspaceOpLock.run(op);

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
  // unsaved work can exist at a fresh boot, so the boot ladder skips the confirm-and-replace guard
  // (newModel directly). A RETURN visit to Home reaches this with the IDE still alive behind the route
  // — dirty buffers can exist — so the route-intent subscription passes `guarded` and every destructive
  // action asks first, matching the in-editor New/open paths.
  async function runStartIntent(intent: StartIntent, opts: { guarded?: boolean } = {}): Promise<void> {
    return withWorkspaceOpLock(async () => {
      if (opts.guarded && !(await deps.confirmReplaceWork('Replace your work?', 'Discard & continue'))) return;
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
    });
  }

  // Boot: attach listeners (inside start) before messages flow, then open the doc.
  deps.lsp.onServerRestart(() => {
    // A boot intent was stranded by a failed lsp.start(): perform it now, guarded (dirty buffers can
    // exist by the time the server recovers), and fire only once (#973). bootIntentPending only tracks
    // "a boot intent was stranded", not whether it's STILL pending — a return visit to Home can drain
    // it via the route-intent subscription below before this restart fires. takeStartIntent() then
    // returns null; fall through to the plain refresh rather than skipping it.
    if (bootIntentPending) {
      bootIntentPending = false;
      const intent = takeStartIntent();
      if (intent) {
        void runStartIntent(intent, { guarded: true });
        return;
      }
    }
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
        await withWorkspaceOpLock(async () => {
          // Re-checked HERE, once this op's turn in the queue actually comes — not before queueing
          // (#1088). Serializing alone isn't enough: the shared branch waits out lsp.start() before it
          // ever reaches the lock, so a Home pick taken during that connect window acquires the lock
          // FIRST and opens its own workspace. Importing on top of it would silently discard the
          // workspace the user just asked for — the same clobber #1046 fixed, in the reverse ordering.
          // The hash is still cleared: this boot consumed the link, so a reload must not re-import it.
          if (deps.hasOpenWorkspace()) {
            clearModelHash();
            return;
          }
          let opened = false;
          try {
            opened = await deps.importSharedWorkspace(shared.files, shared.active);
          } catch (e) {
            console.error('importing shared workspace failed:', e);
            deps.setStatus('could not open shared workspace', 'error');
          } finally {
            clearModelHash();
          }
          // An import that opened nothing (every relPath filtered as unsafe, a failed materialize, or
          // a thrown import) must not strand the editor with zero buffers behind it — every save would
          // be a silent no-op. Fall through to the default workspace, like a plain boot.
          if (!opened) await openDefaultWorkspaceFlow(legacyScratch ?? seed);
        });
      } else if (shared?.kind === 'single') {
        await withWorkspaceOpLock(async () => {
          // Same queued-turn recheck as the workspace branch above (#1088).
          if (deps.hasOpenWorkspace()) {
            clearModelHash();
            return;
          }
          try {
            await deps.openWorkspaceWith1File(shared.text);
          } catch (e) {
            console.error('opening shared model failed:', e);
            deps.setStatus('could not open shared model', 'error');
          } finally {
            clearModelHash();
          }
        });
      } else {
        // A start action chosen on the Home route (#368) is queued as a one-shot intent and performed
        // here, once. A plain editor boot has no intent: restore the workspace it was last on (#535).
        // Only a host-internal materialized dir is re-opened here (browser `example-*` / desktop
        // `<appData>/workspaces/*` — both re-acquire with NO prompt); a *picked* folder is never
        // auto-restored, by design. The default workspace flows through openDefaultWorkspaceFlow below.
        // On any restore failure we also fall through to the default.
        const intent = takeStartIntent();
        if (intent) {
          await runStartIntent(intent);
        } else {
          await withWorkspaceOpLock(async () => {
            // The restore is only a fallback for an EMPTY editor: the toolbar is interactive while the
            // server connects (a multi-second window in the browser), so a folder the user opened during
            // that window — or another queued workspace-opening operation that just finished — must not
            // be torn down and replaced by the restored/default workspace. Re-checked here (rather than
            // before queueing) so a stale read can't win once this op's turn actually comes (#1046).
            if (deps.hasOpenWorkspace()) return;
            const last = getLastWorkspace();
            const restorable = !!last && last !== DEFAULT_WS_TOKEN && (await deps.isAutoRestorableToken(last));
            const restoredExample = restorable ? (await deps.openFolderPath(last as string, { recent: false })).ok : false;
            // Legacy-scratch migration is deliberately NOT done on the example-restore path: the scratch
            // content is only ever preserved by being seeded into the default workspace.
            if (!restoredExample) await openDefaultWorkspaceFlow(legacyScratch ?? seed);
          });
        }
      }
    })
    .catch((e) => {
      // Peek (don't consume) so a still-pending intent both names this failure AND survives for the
      // onServerRestart re-dispatch above (#973). No pending intent: keep the plain generic message.
      const intent = peekStartIntent();
      if (intent) {
        bootIntentPending = true;
        const message = `Couldn't open "${intentLabel(intent)}" — the language server didn't start`;
        deps.setStatus(message, 'error');
        deps.setOutput(`// ${message}\n` + String(e), 'plain');
      } else {
        deps.setStatus('connection failed', 'error');
        deps.setOutput('// failed to start language server\n' + String(e), 'plain');
      }
    });

  // The IDE shell boots once and stays alive across Home↔Editor route swaps (main.ts toggles visibility,
  // it doesn't re-init). The boot ladder above consumes a start-intent only on that first boot — so a
  // start action taken on a *return* visit to Home would otherwise be dropped. Consume any queued intent
  // on every later transition INTO the editor route.
  //
  // But this listener must NOT act on the cold-boot transition itself. On a Home-first boot the IDE is
  // lazy-initialised the first time the editor route is reached, so createLifecycleBoot runs *inside*
  // main.ts's `set({ route: 'editor' })` notification — and JS `Set.forEach` visits listeners added
  // mid-iteration, so this freshly-registered listener DOES fire on that very transition. Running the
  // intent here would be UNGATED (it doesn't await lsp.start()): on desktop the `koine lsp` sidecar is a
  // dotnet process that takes seconds to answer `initialize`, so the model-index request beats it and the
  // host's `lsp_send` reports "LSP not started". The gated boot ladder above already owns that first
  // intent, so ignore transitions until the boot notification has drained (next microtask); only genuine
  // *return* visits — real user actions in a later task — are handled here.
  let booting = true;
  queueMicrotask(() => {
    booting = false;
  });
  const unsubRouteIntent = appStore.subscribe((s, prev) => {
    if (booting) return;
    if (s.route === 'editor' && prev.route !== 'editor') {
      const intent = takeStartIntent();
      // Guarded: unlike the cold boot above, the live editor behind the Home route can hold dirty
      // buffers, and every start intent replaces the workspace (New even resets it on disk).
      if (intent) void runStartIntent(intent, { guarded: true });
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
      deps.disposers.workspaceSeams();
      deps.disposers.theme();
      deps.disposers.autoSave();
      unsubRouteIntent();
      deps.disposers.exportMenuDismiss();
      deps.disposers.editorKeys();
      deps.disposers.statusBar();
      deps.disposers.explorer();
    },
  };
}
