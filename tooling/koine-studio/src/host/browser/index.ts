// Browser platform backend: the compiler runs in-process via Koine.Wasm (WasmLspTransport) and
// files go through the File System Access API (fs.ts). Used when the studio is served as a plain
// web page rather than hosted in the Tauri desktop shell.
import type { KoiFile, LspTransport, Platform, SourceDoc } from '../types';
import { WasmLspTransport } from './transport';
import * as fs from './fs';

// Injected by Vite's `define` (see vite.config.ts) from package.json's version.
declare const __APP_VERSION__: string;

export class BrowserPlatform implements Platform {
  readonly kind = 'browser' as const;
  readonly canOpenFolders = fs.supported();

  createLspTransport(): LspTransport {
    return new WasmLspTransport();
  }

  async appVersion(): Promise<string> {
    return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';
  }

  pickFolder(title: string): Promise<string | null> {
    return fs.pickFolder(title);
  }

  folderName(token: string): string {
    return fs.folderName(token);
  }

  listKoiFiles(token: string): Promise<KoiFile[]> {
    return fs.listKoiFiles(token);
  }

  readTextFile(path: string): Promise<string> {
    return fs.readTextFile(path);
  }

  writeTextFile(path: string, contents: string): Promise<void> {
    return fs.writeTextFile(path, contents);
  }

  pickSavePath(defaultName: string): Promise<string | null> {
    return fs.pickSavePath(defaultName);
  }

  async saveZip(defaultName: string, data: Uint8Array): Promise<boolean> {
    // A browser download is fire-and-forget — there is no cancel signal, so it always "succeeds".
    fs.downloadBytes(defaultName, data, 'application/zip');
    return true;
  }

  readFolderSources(token: string): Promise<SourceDoc[]> {
    return fs.readFolderSources(token);
  }
}
