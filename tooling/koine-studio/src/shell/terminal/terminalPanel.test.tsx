import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Platform, TerminalTransport } from '@/host/types';

// xterm.js needs a real canvas/measurement environment the happy-dom test host lacks, so we mock it:
// a fake Terminal/FitAddon that records calls lets us assert the panel's WIRING (mount, output → view,
// keystroke → transport) without a browser. `vi.hoisted` shares the instance registry with the
// hoisted mock factory. The placeholder branch (browser) mounts no terminal at all.
const { termInstances } = vi.hoisted(() => ({ termInstances: [] as FakeTerminal[] }));

interface FakeTerminal {
  cols: number;
  rows: number;
  open: ReturnType<typeof vi.fn>;
  loadAddon: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
  emitKeystroke(data: string): void;
}

vi.mock('@xterm/xterm', () => {
  class Terminal implements FakeTerminal {
    cols = 80;
    rows = 24;
    private dataCb?: (d: string) => void;
    open = vi.fn();
    loadAddon = vi.fn();
    write = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
    onData = vi.fn((cb: (d: string) => void) => {
      this.dataCb = cb;
      return { dispose: vi.fn() };
    });
    emitKeystroke(data: string): void {
      this.dataCb?.(data);
    }
    constructor() {
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

import { createTerminalPanel, resolveTerminalTheme } from '@/shell/terminal/terminalPanel';

/** A fake terminal transport whose `onData`/`onExit` callbacks the test can drive. */
function makeTransport(): TerminalTransport & { emitData(s: string): void; emitExit(c: number): void } {
  let dataCb: (s: string) => void = () => {};
  let exitCb: (c: number) => void = () => {};
  return {
    start: vi.fn(async () => {}),
    write: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
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
    expect(transport.start).toHaveBeenCalledWith('/work');
    panel.dispose();
  });

  it('writes shell output to the terminal view and forwards keystrokes to the shell', () => {
    const parent = document.createElement('div');
    const transport = makeTransport();
    const platform = { canRunShell: true, createTerminal: () => transport } as unknown as Platform;

    const panel = createTerminalPanel({ parent, platform, cwd: () => null });
    const term = termInstances[0];

    transport.emitData('hello\r\n');
    expect(term.write).toHaveBeenCalledWith('hello\r\n');

    term.emitKeystroke('ls');
    expect(transport.write).toHaveBeenCalledWith('ls');

    panel.dispose();
  });

  it('stops the transport on dispose', () => {
    const transport = makeTransport();
    const platform = { canRunShell: true, createTerminal: () => transport } as unknown as Platform;

    const panel = createTerminalPanel({ parent: document.createElement('div'), platform, cwd: () => null });
    panel.dispose();

    expect(transport.stop).toHaveBeenCalled();
  });
});
