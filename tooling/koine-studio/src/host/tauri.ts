// Desktop (Tauri) platform backend. This is the studio's original behavior, extracted verbatim
// behind the Platform/LspTransport interfaces: the LSP runs as a `koine lsp` child brokered by
// the Rust host over IPC (lsp_start/lsp_send + lsp://message|exit|restart events), and files go
// through the Rust workspace commands (list_koi_files / read_text_file / write_text_file) and the
// dialog plugin. Folder/file tokens are absolute filesystem paths.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import type { KoiFile, LspTransport, Platform, SourceDoc } from './types';

/** LSP transport over Tauri IPC. Mirrors the wiring previously inlined in lsp.ts. */
class TauriLspTransport implements LspTransport {
  private msgCb?: (json: string) => void;
  private exitCb?: (code: number) => void;
  private restartCb?: () => void;
  private unlistenMsg?: UnlistenFn;
  private unlistenExit?: UnlistenFn;
  private unlistenRestart?: UnlistenFn;

  onMessage(cb: (json: string) => void): void {
    this.msgCb = cb;
  }

  onExit(cb: (code: number) => void): void {
    this.exitCb = cb;
  }

  onRestart(cb: () => void): void {
    this.restartCb = cb;
  }

  // Attach the event listeners FIRST (so no message is missed), then spawn the child.
  async start(): Promise<void> {
    this.unlistenMsg = await listen<string>('lsp://message', (e) => this.msgCb?.(e.payload));
    this.unlistenExit = await listen<number>('lsp://exit', (e) =>
      this.exitCb?.(typeof e.payload === 'number' ? e.payload : -1),
    );
    this.unlistenRestart = await listen('lsp://restart', () => this.restartCb?.());
    await invoke('lsp_start');
  }

  send(message: string): Promise<void> {
    return invoke('lsp_send', { message }) as Promise<void>;
  }

  async stop(): Promise<void> {
    this.unlistenMsg?.();
    this.unlistenExit?.();
    this.unlistenRestart?.();
    // Intentional improvement over the studio's original inline dispose() (which only detached the
    // event listeners): also ask the host to stop the sidecar so it isn't leaked. lsp_stop is
    // idempotent and safe when nothing is running; errors are swallowed.
    try {
      await invoke('lsp_stop');
    } catch {
      // best effort — the host may already be gone
    }
  }
}

export class TauriPlatform implements Platform {
  readonly kind = 'tauri' as const;
  readonly canOpenFolders = true;

  createLspTransport(): LspTransport {
    return new TauriLspTransport();
  }

  appVersion(): Promise<string> {
    return invoke<string>('app_version');
  }

  async pickFolder(title: string): Promise<string | null> {
    const picked = await openDialog({ directory: true, title });
    return Array.isArray(picked) ? picked[0] ?? null : picked;
  }

  folderName(token: string): string {
    return token.split(/[\\/]/).filter(Boolean).pop() ?? token;
  }

  listKoiFiles(token: string): Promise<KoiFile[]> {
    return invoke<KoiFile[]>('list_koi_files', { dir: token });
  }

  readTextFile(path: string): Promise<string> {
    return invoke<string>('read_text_file', { path });
  }

  writeTextFile(path: string, contents: string): Promise<void> {
    return invoke('write_text_file', { path, contents }) as Promise<void>;
  }

  pickSavePath(defaultName: string): Promise<string | null> {
    return saveDialog({
      title: 'Save model',
      defaultPath: defaultName,
      filters: [{ name: 'Koine model', extensions: ['koi'] }],
    });
  }

  // The desktop compatibility check reads the baseline path server-side, so this is unused; it is
  // implemented for interface parity (and would work if a caller ever needs it).
  async readFolderSources(token: string): Promise<SourceDoc[]> {
    const files = await this.listKoiFiles(token);
    const out: SourceDoc[] = [];
    for (const f of files) {
      try {
        out.push({ uri: f.path, text: await this.readTextFile(f.path) });
      } catch {
        // skip unreadable files
      }
    }
    return out;
  }
}
