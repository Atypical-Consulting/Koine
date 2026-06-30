// The integrated terminal panel (issue #256). A desktop-only capability: on the Tauri host it mounts
// xterm.js over the platform's PTY transport (the Rust `pty_*` broker), so the bottom panel hosts a
// real shell rooted at the opened workspace folder. In the browser — where no host shell exists — it
// renders a graceful placeholder instead. The panel talks to the host ONLY through the Platform
// abstraction (`canRunShell` + `createTerminal`), never importing Tauri/WASM directly.
import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { Platform, TerminalTransport } from '@/host/types';

/** Shown in the browser, where the host cannot spawn a shell. The substring "available in the Koine
 *  Studio desktop app" is asserted by the panel test, so keep it stable. */
const PLACEHOLDER_TEXT = 'The integrated terminal is available in the Koine Studio desktop app.';

/**
 * Flow-control water marks (#441). The panel pairs `term.write` with the PTY's pause/resume so a
 * high-throughput command (`yes`, `cat bigfile`) can't outrun the renderer: it tracks the chars handed
 * to xterm but not yet parsed, and when that backlog crosses {@link TERM_PAUSE_WATER} it pauses the
 * producer, resuming only once the backlog drains below {@link TERM_RESUME_WATER}. The two-mark
 * hysteresis (resume well below pause) avoids thrashing the PTY on every chunk. Values mirror xterm's
 * documented write-callback flow-control example; exported for the panel's flow-control test.
 */
export const TERM_PAUSE_WATER = 100_000;
export const TERM_RESUME_WATER = 10_000;

export interface TerminalPanelOptions {
  /** The element the panel mounts into (the bottom panel's `#panel-terminal`). */
  parent: HTMLElement;
  /** The host platform — gated on `canRunShell` / `createTerminal`. */
  platform: Platform;
  /** The working directory to root the shell at, read lazily (the opened folder token, or null). */
  cwd: () => string | null;
  /** The terminal's shell-args override, read lazily (the Studio `terminal.shellArgs` setting, #467).
   *  Empty/null/omitted keeps the host's default `-l` login shell — read at each (re)start so a changed
   *  setting takes effect on the next spawn. */
  shellArgs?: () => string[] | null;
}

export interface TerminalPanel {
  /** Re-fit the terminal to its container — call when the panel is shown or the pane is resized. */
  fit(): void;
  /** Re-resolve the app surface tokens into the xterm theme — call on a dark/light flip so the
   *  running terminal re-themes live. A no-op on the browser placeholder branch (no terminal). */
  applyTheme(): void;
  /** Tear down: stop the shell, disconnect observers, and dispose the xterm instance. */
  dispose(): void;
}

/**
 * The 16-colour ANSI palette tuned for **dark** terminal backgrounds (#763). These match xterm's
 * built-in defaults but are made explicit so they can be swapped live on a dark↔light theme flip
 * and tested as a unit.
 */
export const DARK_ANSI = {
  black:         '#1e1e1e',
  red:           '#f14c4c',
  green:         '#23d18b',
  yellow:        '#f5f543',
  blue:          '#3b8eea',
  magenta:       '#d670d6',
  cyan:          '#29b8db',
  white:         '#e5e5e5',
  brightBlack:   '#666666',
  brightRed:     '#f1897f',
  brightGreen:   '#23d18b',
  brightYellow:  '#f5f543',
  brightBlue:    '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan:    '#29b8db',
  brightWhite:   '#e5e5e5',
} as const;

/**
 * The 16-colour ANSI palette tuned for **light** terminal backgrounds (#763). Derived from the
 * GNOME Terminal Tango palette which has been validated for legibility on light surfaces; darker/
 * saturated variants keep ≈WCAG AA contrast against `--koi-paper-2` in light theme.
 */
export const LIGHT_ANSI = {
  black:         '#171421',
  red:           '#c01c28',
  green:         '#26a269',
  yellow:        '#a2734c',
  blue:          '#12488b',
  magenta:       '#a347ba',
  cyan:          '#007a87',
  white:         '#d0d0d0',
  brightBlack:   '#5e5c64',
  brightRed:     '#f66151',
  brightGreen:   '#33d17a',
  brightYellow:  '#e9ad0c',
  brightBlue:    '#2a7bde',
  brightMagenta: '#c061cb',
  brightCyan:    '#0fbed8',
  brightWhite:   '#ffffff',
} as const;

/**
 * Return true when `hex` is a light colour (perceived luminance > 0.5), using the W3C formula.
 * Accepts `#rrggbb` and `#rgb` forms; anything that doesn't parse is treated as dark.
 */
function isLightBackground(hex: string): boolean {
  const h = hex.replace('#', '');
  let r: number, g: number, b: number;
  if (h.length === 6) {
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
  } else if (h.length === 3) {
    r = parseInt(h[0] + h[0], 16);
    g = parseInt(h[1] + h[1], 16);
    b = parseInt(h[2] + h[2], 16);
  } else {
    return false; // unknown format → assume dark
  }
  return (r * 0.299 + g * 0.587 + b * 0.114) / 255 > 0.5;
}

/**
 * Resolve the app's surface design-tokens into an xterm `ITheme`, so the terminal matches the rest of
 * Studio instead of a hardcoded scheme. xterm paints glyphs from concrete colour strings (it can't read
 * `var(--koi-…)`), so the live token values are pulled off `el`'s computed style with `getComputedStyle`
 * and re-resolved on every dark/light flip (see {@link TerminalPanel.applyTheme}). Background tracks the
 * bottom panel's own surface (`--koi-paper-2`); foreground/cursor track `--koi-fg`. The `||` fallbacks
 * keep today's conventional `#1e1e1e`/`#d4d4d4` if a token is missing (detached node / unset var) so the
 * terminal never renders un-themed. The 16 ANSI colour slots are filled from {@link LIGHT_ANSI} or
 * {@link DARK_ANSI} depending on the resolved background luminance, so program output (test runners,
 * `git status`, build logs) stays legible in both themes (#763).
 */
export function resolveTerminalTheme(el: HTMLElement): ITheme {
  const cs = getComputedStyle(el);
  const read = (name: string) => cs.getPropertyValue(name).trim();
  const bg = read('--koi-paper-2') || '#1e1e1e';
  const fg = read('--koi-fg') || '#d4d4d4';
  const ansi = isLightBackground(bg) ? LIGHT_ANSI : DARK_ANSI;
  return { background: bg, foreground: fg, cursor: fg, ...ansi };
}

/**
 * Create the terminal panel inside `parent`. On a host that {@link Platform.canRunShell}, mounts
 * xterm.js wired to a fresh {@link TerminalTransport}; otherwise renders the desktop-only placeholder.
 * Returns a handle the shell (ide.tsx) uses to re-fit on show/resize and to dispose on teardown.
 */
export function createTerminalPanel(opts: TerminalPanelOptions): TerminalPanel {
  const { parent, platform, cwd, shellArgs } = opts;

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
      applyTheme() {
        /* no terminal to re-theme on the placeholder branch */
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
    // Theme the terminal off the app's surface tokens so it matches the bottom panel it lives in
    // (background = --koi-paper-2, foreground/cursor = --koi-fg) instead of a fixed dark scheme.
    // Re-applied on the dark/light toggle via applyTheme() — xterm needs concrete colours, not var().
    theme: resolveTerminalTheme(host),
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(host);

  const transport: TerminalTransport = platform.createTerminal();
  // True once the shell has exited; the next Enter restarts it instead of being written to a dead PTY.
  let exited = false;

  // Flow-control state (#441): `pendingChars` is the count of chars handed to xterm but not yet parsed
  // (the renderer backlog); `flowPaused` tracks whether we've asked the PTY to pause. `flowEpoch` is
  // bumped on restart and dispose so a write callback queued under a prior shell — or after teardown —
  // self-skips instead of decrementing `pendingChars` into a stale (negative) count or poking a
  // torn-down transport. Reset on restart so a relaunched shell never starts wedged in the paused state.
  let pendingChars = 0;
  let flowPaused = false;
  let flowEpoch = 0;

  // The cols/rows last sent to the shell, so an unchanged fit() doesn't re-issue a pty_resize IPC.
  let sentCols = 0;
  let sentRows = 0;

  // Re-measure the viewport and, only when the character grid actually changed, tell the shell.
  // `fitAddon.fit()` throws on a zero-size (hidden) container — swallow it so a fit() before the panel
  // is shown is harmless (a real fit follows on reveal/start). The resize invoke is best-effort: it
  // can reject with "PTY not started" if a reveal-fit races ahead of start(), so its error is ignored
  // (start()'s own .then(fit) re-syncs the size once the shell is up).
  function fit(): void {
    try {
      fitAddon.fit();
    } catch {
      return; // container not laid out yet (panel hidden) — re-fit happens on show
    }
    if (term.cols === sentCols && term.rows === sentRows) return;
    sentCols = term.cols;
    sentRows = term.rows;
    void transport.resize(term.cols, term.rows).catch(() => {});
  }

  function restart(): void {
    exited = false;
    pendingChars = 0;
    flowPaused = false;
    flowEpoch++; // stale write callbacks from the prior shell must not touch the new session's counter
    term.clear();
    void transport.start(cwd(), shellArgs?.() ?? null).then(fit);
  }

  // Shell output → the view, WITH flow control (#441). xterm's write(chunk, cb) fires the callback once
  // the chunk is parsed, so the number of chars written-but-not-yet-parsed is the renderer backlog.
  // When that backlog crosses TERM_PAUSE_WATER we pause the PTY (the producer); xterm draining it below
  // TERM_RESUME_WATER resumes it. The two-mark hysteresis stops us toggling pause/resume on every
  // chunk. Without this a flooding command outruns the UI thread and the IPC bridge backs up; pausing
  // the reader fills the kernel PTY buffer and blocks the shell — real backpressure, no data dropped.
  transport.onData((chunk) => {
    const epoch = flowEpoch;
    pendingChars += chunk.length;
    term.write(chunk, () => {
      if (epoch !== flowEpoch) return; // a restart/dispose happened since this write — stale callback
      pendingChars -= chunk.length;
      if (flowPaused && pendingChars <= TERM_RESUME_WATER) {
        flowPaused = false;
        // Revert the intent if the resume IPC fails, so a later callback retries rather than stranding
        // the reader parked (pause/resume are infallible host commands, but keep the state consistent).
        void transport.resume().catch(() => {
          flowPaused = true;
        });
      }
    });
    if (!flowPaused && pendingChars >= TERM_PAUSE_WATER) {
      flowPaused = true;
      // Revert if the pause IPC fails, so the next chunk retries rather than silently losing backpressure.
      void transport.pause().catch(() => {
        flowPaused = false;
      });
    }
  });
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
  // reveal), DEBOUNCED so a drag — which fires the observer every frame — coalesces into one fit (and
  // at most one pty_resize) when it settles, instead of a per-frame IPC storm. ResizeObserver is
  // absent in some headless/test envs — guard so the panel still works without it.
  let resizeObserver: ResizeObserver | undefined;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(fit, 50);
    });
    resizeObserver.observe(parent);
  }

  // Attach listeners (done above) BEFORE starting so no early output is missed, then spawn the shell
  // and fit once it is up.
  void transport.start(cwd(), shellArgs?.() ?? null).then(fit);

  return {
    fit() {
      fit();
      term.focus();
    },
    applyTheme() {
      // Re-read the (now-flipped) app surface tokens and push them into xterm's live theme.
      term.options.theme = resolveTerminalTheme(host);
    },
    dispose() {
      flowEpoch++; // a write callback firing during teardown must not resume an already-stopped PTY
      resizeObserver?.disconnect();
      clearTimeout(resizeTimer);
      void transport.stop();
      term.dispose();
      host.remove();
    },
  };
}
