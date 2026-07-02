// Browser platform backend: the compiler runs in-process via Koine.Wasm (WasmLspTransport) and
// files go through the File System Access API (fs.ts). Used when the studio is served as a plain
// web page rather than hosted in the Tauri desktop shell.
import type { EditSession } from '@/ai/editSession';
import type { FsEntry, GitLogEntry, GitStatus, KoiFile, LspTransport, McpEndpoint, Platform, SourceDoc } from '@/host/types';
import { WasmLspTransport } from '@/host/browser/transport';
import {
  runEditTool as runEditToolImpl,
  runWasmTool,
  validateStagedWorkspace as validateStagedWorkspaceImpl,
} from '@/host/browser/tools';
import { loadWasmApi } from '@/host/browser/wasm';
import * as fs from '@/host/browser/fs';
import { saveMetaFor } from '@/host/saveMeta';

// Injected by Vite's `define` (see vite.config.ts) from package.json's version.
declare const __APP_VERSION__: string;

export class BrowserPlatform implements Platform {
  readonly kind = 'browser' as const;
  readonly canHostMcp = false;
  readonly compatNeedsInProcessSources = true;
  readonly usesServiceWorker = true;
  readonly canOpenFolders = fs.supported();
  readonly canSaveProjects = fs.supported();
  readonly persistsWorkspace = fs.persistsWorkspace();
  // A browser tab cannot spawn a host shell, so there is no integrated terminal: the panel shows a
  // graceful "desktop only" placeholder. `createTerminal` is deliberately omitted (not implemented).
  readonly canRunShell = false;

  createLspTransport(): LspTransport {
    return new WasmLspTransport();
  }

  async appVersion(): Promise<string> {
    return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';
  }

  // A browser tab cannot listen as a server, so there is no MCP HTTP endpoint to advertise; the
  // `koine mcp --http` CLI recipe covers the web user. Null hides the desktop-only affordance.
  async mcpEndpoint(): Promise<McpEndpoint | null> {
    return null;
  }

  // A browser tab never launched a server, so there is nothing to stop.
  async mcpStop(): Promise<void> {
    // no-op
  }

  // The Assistant's koine tools run in-process against the resident Koine.Wasm compiler.
  runCompilerTool(name: string, argsJson: string): Promise<string> {
    return runWasmTool(name, argsJson);
  }

  // The host-local edit tools dispatch against the per-turn staging session (stage-only; the
  // whole-workspace validation runs once per turn via validateStagedWorkspace, issue #474).
  runEditTool(name: string, argsJson: string, session: EditSession): Promise<string> {
    return runEditToolImpl(name, argsJson, session);
  }

  // Validate the whole staged workspace once at end of an agentic turn (in-process WASM DiagnoseWorkspace).
  validateStagedWorkspace(session: EditSession): Promise<string> {
    return validateStagedWorkspaceImpl(session);
  }

  // The GBNF grammar for grammar-constrained decoding (#257) comes straight from the resident
  // Koine.Wasm module's `GbnfGrammar()` export. Browser-host only — the desktop host omits this.
  async gbnfGrammar(): Promise<string> {
    const api = await loadWasmApi();
    return api.GbnfGrammar();
  }

  openExternal(url: string): void {
    // A null return means the popup blocker (or a sandboxed frame) stopped the new tab; log it so a
    // link that does nothing isn't completely silent.
    const win = window.open(url, '_blank', 'noopener,noreferrer');
    if (!win) console.warn(`Browser blocked opening external URL: ${url}`);
  }

  pickFolder(title: string): Promise<string | null> {
    return fs.pickFolder(title);
  }

  saveProjectToRoot(name: string, files: { relPath: string; contents: string }[]): Promise<string | null> {
    return fs.saveProjectToRoot(name, files);
  }

  workspaceRootName(): Promise<string | null> {
    return fs.workspaceRootName();
  }

  pickWorkspaceRoot(): Promise<string | null> {
    return fs.pickWorkspaceRoot();
  }

  materializeWorkspace(
    name: string,
    files: { relPath: string; contents: string }[],
    persist?: boolean,
  ): Promise<string | null> {
    return fs.materializeWorkspace(name, files, persist);
  }

  defaultWorkspace(seed: string): Promise<string | null> {
    return fs.openDefaultWorkspace(seed);
  }

  // The OPFS default + `example-*` example dirs re-acquire with no permission prompt, so boot may
  // restore them; a picked folder needs a user-gesture re-grant, so it stays a manual Recents click.
  isAutoRestorableToken(token: string): Promise<boolean> {
    return Promise.resolve(fs.isAutoRestorableToken(token));
  }

  folderName(token: string): string {
    return fs.folderName(token);
  }

  listKoiFiles(token: string): Promise<KoiFile[]> {
    return fs.listKoiFiles(token);
  }

  // A browser tab has no git, so per-element change history (#150) is unavailable: null hides the
  // inspector's "Change history" section gracefully (no console errors).
  gitLogForRange(): Promise<null> {
    return Promise.resolve(null);
  }

  // --- source control (git) --------------------------------------------------
  // git is a desktop-only capability (issue #272): a browser tab has none, so `canUseGit` is false and
  // the Source Control panel renders its "desktop only" placeholder instead of calling anything below.
  readonly canUseGit = false;

  // The shared stub for every git method. It REJECTS (rather than returning fake-empty data) so a caller
  // that forgot to guard on `canUseGit` gets a handled error, not a "clean working tree" that looks
  // real. The rejection is asynchronous (never a synchronous throw) and logs nothing, so a guarded UI
  // never reaches it and an unguarded one degrades gracefully. `Promise<never>` is assignable to every
  // git method's return type.
  private gitUnavailable(): Promise<never> {
    return Promise.reject(new Error('git is unavailable in the browser host; check `canUseGit` before calling'));
  }

  gitStatus(): Promise<GitStatus> {
    return this.gitUnavailable();
  }

  gitDiff(): Promise<string> {
    return this.gitUnavailable();
  }

  gitStage(): Promise<void> {
    return this.gitUnavailable();
  }

  gitUnstage(): Promise<void> {
    return this.gitUnavailable();
  }

  gitCommit(): Promise<void> {
    return this.gitUnavailable();
  }

  gitBranches(): Promise<string[]> {
    return this.gitUnavailable();
  }

  gitCheckout(): Promise<void> {
    return this.gitUnavailable();
  }

  gitLog(): Promise<GitLogEntry[]> {
    return this.gitUnavailable();
  }

  gitInit(): Promise<void> {
    return this.gitUnavailable();
  }

  readTextFile(path: string): Promise<string> {
    return fs.readTextFile(path);
  }

  writeTextFile(path: string, contents: string): Promise<void> {
    return fs.writeTextFile(path, contents);
  }

  async saveZip(defaultName: string, data: Uint8Array): Promise<boolean> {
    // A browser download is fire-and-forget — there is no cancel signal, so it always "succeeds". The Blob
    // MIME is derived from the extension (#271) so a `.svg`/`.png`/`.puml` export isn't tagged `application/zip`.
    fs.downloadBytes(defaultName, data, saveMetaFor(defaultName).mime);
    return true;
  }

  readFolderSources(token: string): Promise<SourceDoc[]> {
    return fs.readFolderSources(token);
  }

  listEntries(folderToken: string): Promise<FsEntry[]> {
    return fs.listEntries(folderToken);
  }

  listDir(folderToken: string, relPath: string): Promise<FsEntry[]> {
    return fs.listDir(folderToken, relPath);
  }

  createFile(folderToken: string, relPath: string, contents?: string): Promise<string> {
    return fs.createFile(folderToken, relPath, contents);
  }

  createFolder(folderToken: string, relPath: string): Promise<string> {
    return fs.createFolder(folderToken, relPath);
  }

  renameEntry(token: string, newName: string): Promise<string> {
    return fs.renameEntry(token, newName);
  }

  deleteEntry(token: string): Promise<void> {
    return fs.deleteEntry(token);
  }

  moveEntry(token: string, destFolderToken: string, newRelPath: string, copy?: boolean): Promise<string> {
    return fs.moveEntry(token, destFolderToken, newRelPath, copy);
  }
}
