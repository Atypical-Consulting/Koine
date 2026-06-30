import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Platform, TerminalTransport } from '@/host/types';

// xterm.js needs a real canvas/measurement environment the happy-dom test host lacks, so we mock it:
// a fake Terminal/FitAddon that records calls lets us assert the panel's WIRING (mount, output → view,
// keystroke → transport) without a browser. `vi.hoisted` shares the instance registry with the
// hoisted mock factory. The placeholder branch (browser) mounts no terminal at all.
const { termInstances } = vi.hoisted(() => ({ termInstances: [] as FakeTerminal[] }));

interface FakeTerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  // ANSI palette entries added in #763 — allow arbitrary string keys so the fake can hold them without
  // repeating all 16 names here.
  [key: string]: string | undefined;
}

interface FakeTerminal {
  cols: number;
  rows: number;
  // xterm's live theme bag — set at construction and reassigned by applyTheme().
  options: { theme?: FakeTerminalTheme };
  open: ReturnType<typeof vi.fn>;
  loadAddon: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
  emitKeystroke(data: string): void;
  /** Invoke the oldest `n` un-acked write callbacks (all when omitted) to simulate xterm parsing the
   *  buffered output — this is what the flow-control test uses to drain the backlog. */
  drainWrites(n?: number): void;
}

vi.mock('@xterm/xterm', () => {
  class Terminal implements FakeTerminal {
    cols = 80;
    rows = 24;
    options: { theme?: FakeTerminalTheme };
    private dataCb?: (d: string) => void;
    // The not-yet-invoked write callbacks (real xterm calls these once a chunk is parsed); the
    // flow-control test drains them via drainWrites() to model the renderer catching up.
    private writeCallbacks: Array<() => void> = [];
    open = vi.fn();
    loadAddon = vi.fn();
    // Mirrors xterm's write(data, callback?): the optional callback fires when the chunk is parsed.
    // We DON'T fire it eagerly — the test controls draining so it can hold a backlog past the mark.
    write = vi.fn((_data: string, cb?: () => void) => {
      if (cb) this.writeCallbacks.push(cb);
    });
    clear = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
    onData = vi.fn((cb: (d: string) => void) => {
      this.dataCb = cb;
      return { dispose: vi.fn() };
    });
    emitKeystroke(data: string): void {
      this.dataCb?.(data);
    }
    drainWrites(n?: number): void {
      const batch = this.writeCallbacks.splice(0, n ?? this.writeCallbacks.length);
      for (const cb of batch) cb();
    }
    constructor(opts?: { theme?: FakeTerminalTheme }) {
      this.options = { theme: opts?.theme };
      termInstances.push(this);
    }
  }
  return { Terminal };
});

vi.mock('@xterm/addon-fit', () => {
  class FitAddon {
    fit = vi.fn();
    activate = vi.fn();
    dispose = vi.fn();
  }
  return { FitAddon };
});

import {
  createTerminalPanel,
  resolveTerminalTheme,
  TERM_PAUSE_WATER,
  TERM_RESUME_WATER,
  LIGHT_ANSI,
  DARK_ANSI,
} from '@/shell/terminal/terminalPanel';

/** A fake terminal transport whose `onData`/`onExit` callbacks the test can drive. */
function makeTransport(): TerminalTransport & { emitData(s: string): void; emitExit(c: number): void } {
  let dataCb: (s: string) => void = () => {};
  let exitCb: (c: number) => void = () => {};
  return {
    start: vi.fn(async () => {}),
    write: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    onData: vi.fn((cb: (s: string) => void) => {
      dataCb = cb;
    }),
    onExit: vi.fn((cb: (c: number) => void) => {
      exitCb = cb;
    }),
    stop: vi.fn(async () => {}),
    emitData: (s) => dataCb(s),
    emitExit: (c) => exitCb(c),
  };
}

beforeEach(() => {
  termInstances.length = 0;
});

describe('resolveTerminalTheme', () => {
  // getComputedStyle only resolves an element's CSS custom properties once it is connected to the
  // document (in the app the host inherits the tokens from the cascade), so attach before reading.
  it('reads the app surface tokens (--koi-paper-2 / --koi-fg) off the element', () => {
    const el = document.createElement('div');
    el.style.setProperty('--koi-paper-2', '#161b22');
    el.style.setProperty('--koi-fg', '#d6dde8');
    document.body.appendChild(el);

    const theme = resolveTerminalTheme(el);

    expect(theme.background).toBe('#161b22');
    expect(theme.foreground).toBe('#d6dde8');
    expect(theme.cursor).toBe('#d6dde8');
    el.remove();
  });

  it('falls back to the conventional dark colours when the tokens are unset', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);

    const theme = resolveTerminalTheme(el);

    expect(theme.background).toBe('#1e1e1e');
    expect(theme.foreground).toBe('#d4d4d4');
    expect(theme.cursor).toBe('#d4d4d4');
    el.remove();
  });

  it('includes LIGHT_ANSI palette entries when the background resolves to a light colour (#763)', () => {
    // A light --koi-paper-2 means the terminal is running on a light surface; several of xterm's
    // dark-tuned defaults have poor contrast there, so the theme must swap to the curated light palette.
    const el = document.createElement('div');
    el.style.setProperty('--koi-paper-2', '#f4f6fa'); // perceived luminance ≫ 0.5 → light
    el.style.setProperty('--koi-fg', '#1c2230');
    document.body.appendChild(el);

    const theme = resolveTerminalTheme(el);

    // Spot-check a few ANSI keys that differ across the two palettes.
    expect(theme.black).toBe(LIGHT_ANSI.black);
    expect(theme.red).toBe(LIGHT_ANSI.red);
    expect(theme.green).toBe(LIGHT_ANSI.green);
    expect(theme.yellow).toBe(LIGHT_ANSI.yellow);
    expect(theme.brightWhite).toBe(LIGHT_ANSI.brightWhite);
    el.remove();
  });

  it('includes DARK_ANSI palette entries when the background resolves to a dark colour (#763)', () => {
    // A dark --koi-paper-2 → keep the dark-tuned palette (xterm's defaults, made explicit).
    const el = document.createElement('div');
    el.style.setProperty('--koi-paper-2', '#1e1e1e'); // perceived luminance ≪ 0.5 → dark
    el.style.setProperty('--koi-fg', '#d4d4d4');
    document.body.appendChild(el);

    const theme = resolveTerminalTheme(el);

    expect(theme.black).toBe(DARK_ANSI.black);
    expect(theme.red).toBe(DARK_ANSI.red);
    expect(theme.green).toBe(DARK_ANSI.green);
    expect(theme.yellow).toBe(DARK_ANSI.yellow);
    expect(theme.brightWhite).toBe(DARK_ANSI.brightWhite);
    el.remove();
  });

  it('falls back to DARK_ANSI when the background token is unset (#763)', () => {
    // The fallback background (#1e1e1e) is dark, so the dark palette should be selected.
    const el = document.createElement('div');
    document.body.appendChild(el);

    const theme = resolveTerminalTheme(el);

    expect(theme.black).toBe(DARK_ANSI.black);
    expect(theme.brightWhite).toBe(DARK_ANSI.brightWhite);
    el.remove();
  });
});

describe('createTerminalPanel', () => {
  it('renders a graceful placeholder and starts no shell when the host cannot run one', () => {
    const parent = document.createElement('div');
    const createTerminal = vi.fn();
    const platform = { canRunShell: false, createTerminal } as unknown as Platform;

    const panel = createTerminalPanel({ parent, platform, cwd: () => null });

    expect(parent.textContent).toContain('available in the Koine Studio desktop app');
    expect(createTerminal).not.toHaveBeenCalled();
    expect(termInstances).toHaveLength(0);
    panel.dispose();
  });

  it('mounts xterm and starts the shell (rooted at cwd) when the host can run one', () => {
    const parent = document.createElement('div');
    const transport = makeTransport();
    const platform = { canRunShell: true, createTerminal: () => transport } as unknown as Platform;

    const panel = createTerminalPanel({ parent, platform, cwd: () => '/work' });

    expect(termInstances).toHaveLength(1);
    expect(termInstances[0].open).toHaveBeenCalled();
    // No shellArgs getter configured ⇒ the panel passes null, leaving the host's default shell args.
    expect(transport.start).toHaveBeenCalledWith('/work', null);
    panel.dispose();
  });

  it('forwards the configured shell-args override to the transport on start (#467)', () => {
    const parent = document.createElement('div');
    const transport = makeTransport();
    const platform = { canRunShell: true, createTerminal: () => transport } as unknown as Platform;

    const panel = createTerminalPanel({ parent, platform, cwd: () => '/work', shellArgs: () => ['-l', '-i'] });

    expect(transport.start).toHaveBeenCalledWith('/work', ['-l', '-i']);
    panel.dispose();
  });

  it('writes shell output to the terminal view and forwards keystrokes to the shell', () => {
    const parent = document.createElement('div');
    const transport = makeTransport();
    const platform = { canRunShell: true, createTerminal: () => transport } as unknown as Platform;

    const panel = createTerminalPanel({ parent, platform, cwd: () => null });
    const term = termInstances[0];

    transport.emitData('hello\r\n');
    // Output is written with a flow-control callback (#441): write(chunk, cb) instead of write(chunk).
    expect(term.write).toHaveBeenCalledWith('hello\r\n', expect.any(Function));

    term.emitKeystroke('ls');
    expect(transport.write).toHaveBeenCalledWith('ls');

    panel.dispose();
  });

  it('pauses the PTY when xterm output backs up past the high-water mark, and resumes once drained (#441)', () => {
    const parent = document.createElement('div');
    const transport = makeTransport();
    const platform = { canRunShell: true, createTerminal: () => transport } as unknown as Platform;

    const panel = createTerminalPanel({ parent, platform, cwd: () => null });
    const term = termInstances[0];

    // A flooding command's output arrives while xterm is busy (no write-callbacks fired yet), so the
    // unparsed backlog only grows. One sub-mark part stays under the threshold; a second crosses it.
    const part = Math.floor(TERM_PAUSE_WATER * 0.6); // 60% of the mark — well above the resume mark too
    expect(part).toBeGreaterThan(TERM_RESUME_WATER);

    transport.emitData('x'.repeat(part));
    expect(transport.pause).not.toHaveBeenCalled(); // one part is below the high-water mark

    transport.emitData('x'.repeat(part));
    expect(transport.pause).toHaveBeenCalledTimes(1); // two parts cross it → pause the producer
    expect(transport.resume).not.toHaveBeenCalled();

    // Parse only the first part: the backlog drops but stays above the low-water mark → still paused.
    term.drainWrites(1);
    expect(transport.resume).not.toHaveBeenCalled();

    // Parse the rest: the backlog falls below the low-water mark → resume the producer (once).
    term.drainWrites();
    expect(transport.resume).toHaveBeenCalledTimes(1);

    panel.dispose();
  });

  it('a restart discards the prior shell\'s pending write callbacks so the new session backpressures correctly (#441)', () => {
    const parent = document.createElement('div');
    const transport = makeTransport();
    const platform = { canRunShell: true, createTerminal: () => transport } as unknown as Platform;

    const panel = createTerminalPanel({ parent, platform, cwd: () => null });
    const term = termInstances[0];
    const part = Math.floor(TERM_PAUSE_WATER * 0.6);

    // Session 1 floods to a pause; its write callbacks stay un-drained (xterm still busy).
    transport.emitData('x'.repeat(part));
    transport.emitData('x'.repeat(part));
    expect(transport.pause).toHaveBeenCalledTimes(1);

    // The shell exits and the user restarts (Enter). restart() bumps the epoch and zeroes the backlog.
    transport.emitExit(0);
    term.emitKeystroke('\r');
    expect(transport.start).toHaveBeenCalledTimes(2);

    // The prior session's queued callbacks now fire. WITHOUT the epoch guard they would each run
    // `pendingChars -= part`, driving the counter to ~-120k and delaying the next pause; the guard makes
    // them self-skip so the relaunched session pauses at exactly the same backlog as a fresh panel.
    term.drainWrites();
    (transport.pause as ReturnType<typeof vi.fn>).mockClear();

    transport.emitData('x'.repeat(part));
    expect(transport.pause).not.toHaveBeenCalled(); // one part is below the mark — counter wasn't left negative
    transport.emitData('x'.repeat(part));
    expect(transport.pause).toHaveBeenCalledTimes(1); // two parts cross it, exactly as for a fresh session

    panel.dispose();
  });

  it('stops the transport on dispose', () => {
    const transport = makeTransport();
    const platform = { canRunShell: true, createTerminal: () => transport } as unknown as Platform;

    const panel = createTerminalPanel({ parent: document.createElement('div'), platform, cwd: () => null });
    panel.dispose();

    expect(transport.stop).toHaveBeenCalled();
  });

  it('re-resolves the theme from the host tokens when applyTheme() is called', () => {
    // The host must be in the document for getComputedStyle to resolve its custom properties.
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const transport = makeTransport();
    const platform = { canRunShell: true, createTerminal: () => transport } as unknown as Platform;

    const panel = createTerminalPanel({ parent, platform, cwd: () => null });
    const term = termInstances[0];
    const host = parent.querySelector('.terminal-host') as HTMLElement;

    // Simulate a theme flip: the app surface tokens now resolve to the light palette.
    host.style.setProperty('--koi-paper-2', '#f4f6fa');
    host.style.setProperty('--koi-fg', '#1c2230');
    panel.applyTheme();

    // objectContaining: the theme now also carries 16 ANSI palette entries; we check the base surface
    // tokens here and the palette coverage is handled by the resolveTerminalTheme suite above.
    expect(term.options.theme).toEqual(
      expect.objectContaining({ background: '#f4f6fa', foreground: '#1c2230', cursor: '#1c2230' }),
    );

    panel.dispose();
    parent.remove();
  });

  it('applyTheme() is a no-op on the browser placeholder branch', () => {
    const parent = document.createElement('div');
    const platform = { canRunShell: false } as unknown as Platform;

    const panel = createTerminalPanel({ parent, platform, cwd: () => null });

    expect(() => panel.applyTheme()).not.toThrow();
    expect(termInstances).toHaveLength(0);
    panel.dispose();
  });
});
