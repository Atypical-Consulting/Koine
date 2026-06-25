// The integrated terminal panel (issue #256). A desktop-only capability: on the Tauri host it mounts
// xterm.js over the platform's PTY transport (the Rust `pty_*` broker), so the bottom panel hosts a
// real shell rooted at the opened workspace folder. In the browser — where no host shell exists — it
// renders a graceful placeholder instead. The panel talks to the host ONLY through the Platform
// abstraction (`canRunShell` + `createTerminal`), never importing Tauri/WASM directly.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { Platform, TerminalTransport } from '@/host/types';

/** Shown in the browser, where the host cannot spawn a shell. The substring "available in the Koine
 *  Studio desktop app" is asserted by the panel test, so keep it stable. */
const PLACEHOLDER_TEXT = 'The integrated terminal is available in the Koine Studio desktop app.';

export interface TerminalPanelOptions {
  /** The element the panel mounts into (the bottom panel's `#panel-terminal`). */
  parent: HTMLElement;
  /** The host platform — gated on `canRunShell` / `createTerminal`. */
  platform: Platform;
  /** The working directory to root the shell at, read lazily (the opened folder token, or null). */
  cwd: () => string | null;
}

export interface TerminalPanel {
  /** Re-fit the terminal to its container — call when the panel is shown or the pane is resized. */
  fit(): void;
  /** Tear down: stop the shell, disconnect observers, and dispose the xterm instance. */
  dispose(): void;
}

/**
 * Create the terminal panel inside `parent`. On a host that {@link Platform.canRunShell}, mounts
 * xterm.js wired to a fresh {@link TerminalTransport}; otherwise renders the desktop-only placeholder.
 * Returns a handle the shell (ide.tsx) uses to re-fit on show/resize and to dispose on teardown.
 */
export function createTerminalPanel(opts: TerminalPanelOptions): TerminalPanel {
  const { parent, platform, cwd } = opts;

  // --- browser / no-shell host: graceful placeholder, no transport ----------
  if (!platform.canRunShell || !platform.createTerminal) {
    const placeholder = document.createElement('div');
    placeholder.className = 'terminal-placeholder';
    placeholder.textContent = PLACEHOLDER_TEXT;
    parent.appendChild(placeholder);
    return {
      fit() {
        /* nothing to reflow */
      },
      dispose() {
        placeholder.remove();
      },
    };
  }

  // --- desktop host: mount xterm over the PTY transport ----------------------
  const host = document.createElement('div');
  host.className = 'terminal-host';
  parent.appendChild(host);

  const term = new Terminal({
    cursorBlink: true,
    fontFamily: '"JetBrains Mono Variable", ui-monospace, "SFMono-Regular", monospace',
    fontSize: 13,
    // A terminal is conventionally dark regardless of the editor theme (matches VS Code's terminal);
    // the panel chrome around it themes via CSS.
    theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(host);

  const transport: TerminalTransport = platform.createTerminal();
  // True once the shell has exited; the next Enter restarts it instead of being written to a dead PTY.
  let exited = false;

  // Re-measure the viewport and tell the shell, swallowing the error a zero-size (hidden) container
  // throws so a fit() before the panel is shown is harmless.
  function fit(): void {
    try {
      fitAddon.fit();
    } catch {
      return; // container not laid out yet (panel hidden) — re-fit happens on show
    }
    void transport.resize(term.cols, term.rows);
  }

  function restart(): void {
    exited = false;
    term.clear();
    void transport.start(cwd()).then(fit);
  }

  // Shell output → the view; an exit prints a dim, actionable affordance.
  transport.onData((chunk) => term.write(chunk));
  transport.onExit((code) => {
    exited = true;
    term.write(`\r\n\x1b[2m[process ended (code ${code}) — press Enter to restart]\x1b[0m\r\n`);
  });

  // Keystrokes / pasted text → the shell. After an exit, the first Enter restarts a fresh shell.
  term.onData((data) => {
    if (exited) {
      if (data === '\r') restart();
      return;
    }
    void transport.write(data);
  });

  // Reflow on any container size change (the bottom-panel resizer drag, a window resize, the first
  // reveal). ResizeObserver is absent in some headless/test envs — guard so the panel still works.
  let resizeObserver: ResizeObserver | undefined;
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => fit());
    resizeObserver.observe(parent);
  }

  // Attach listeners (done above) BEFORE starting so no early output is missed, then spawn the shell
  // and fit once it is up.
  void transport.start(cwd()).then(fit);

  return {
    fit() {
      fit();
      term.focus();
    },
    dispose() {
      resizeObserver?.disconnect();
      void transport.stop();
      term.dispose();
      host.remove();
    },
  };
}
