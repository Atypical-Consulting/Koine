// Browser platform backend: the compiler runs in-process via Koine.Wasm (WasmLspTransport) and
// files go through the File System Access API (fs.ts). Used when the studio is served as a plain
// web page rather than hosted in the Tauri desktop shell.
import type { FsEntry, KoiFile, LspTransport, Platform, SourceDoc } from '@/host/types';
import { WasmLspTransport } from '@/host/browser/transport';
import { runWasmTool } from '@/host/browser/tools';
import { loadWasmApi } from '@/host/browser/wasm';
import * as fs from '@/host/browser/fs';
import { saveMetaFor } from '@/host/saveMeta';

// Injected by Vite's `define` (see vite.config.ts) from package.json's version.
declare const __APP_VERSION__: string;

export class BrowserPlatform implements Platform {
  readonly kind = 'browser' as const;
  readonly canOpenFolders = fs.supported();
  readonly canSaveProjects = fs.supported();
  readonly persistsWorkspace = fs.persistsWorkspace();

  createLspTransport(): LspTransport {
    return new WasmLspTransport();
  }

  async appVersion(): Promise<string> {
    return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';
  }

  // A browser tab cannot listen as a server, so there is no MCP HTTP endpoint to advertise; the
  // `koine mcp --http` CLI recipe covers the web user. Null hides the desktop-only affordance.
  async mcpEndpoint(): Promise<string | null> {
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
