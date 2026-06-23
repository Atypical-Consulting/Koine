import { afterEach, describe, expect, test, vi } from 'vitest';
import { createCommandPalette, type Command } from '@/shared/palette';

// Each createCommandPalette() self-mounts one .koi-palette-backdrop on document.body. Wipe the body
// between tests so stale backdrops/handlers (and the central Esc listener's stack entries) don't leak.
afterEach(() => {
  document.body.innerHTML = '';
});

// Build a Command whose run() is a spy so we can assert it fired (and that close() ran first).
function cmd(id: string, title: string, extra: Partial<Command> = {}): Command {
  return { id, title, run: vi.fn(), ...extra };
}

// The four sample commands cover hint/no-hint and a range of titles the subsequence matcher exercises.
function sampleCommands(): Command[] {
  return [
    cmd('open', 'Open File', { hint: 'Cmd+O' }),
    cmd('save', 'Save File', { hint: 'Cmd+S' }),
    cmd('close', 'Close Tab'),
    cmd('format', 'Format Document', { hint: 'Shift+Alt+F' }),
  ];
}

// The single backdrop the most-recently-created palette mounted.
const backdrop = (): HTMLElement => document.body.querySelector('.koi-palette-backdrop')!;
const input = (): HTMLInputElement => backdrop().querySelector('.koi-palette-input')!;
const rows = (): HTMLElement[] => Array.from(backdrop().querySelectorAll('.koi-palette-item'));
const titles = (): (string | null)[] =>
  rows().map((r) => r.querySelector('.koi-palette-item-title')!.textContent);
const selectedIndex = (): number => rows().findIndex((r) => r.getAttribute('aria-selected') === 'true');

// happy-dom doesn't implement scrollIntoView; the palette calls it on selection. Stub it so the
// selection paths don't throw. (jsdom/happy-dom both leave it undefined on elements.)
function stubScrollIntoView(): void {
  if (typeof (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView !== 'function') {
    (HTMLElement.prototype as { scrollIntoView: () => void }).scrollIntoView = () => {};
  }
}
stubScrollIntoView();

// Dispatch a keydown on the palette input (where onKeydown is bound).
function keydown(key: string): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  input().dispatchEvent(e);
  return e;
}

// Set the input's value and fire the 'input' event that drives applyFilter.
function typeQuery(value: string): void {
  input().value = value;
  input().dispatchEvent(new Event('input'));
}

describe('createCommandPalette — mounting & structure', () => {
  test('self-mounts a hidden backdrop with the dialog/input/list chrome', () => {
    createCommandPalette(sampleCommands);

    const bd = backdrop();
    expect(bd).not.toBeNull();
    expect(bd.hidden).toBe(true);

    const panel = bd.querySelector('.koi-palette')!;
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-modal')).toBe('true');

    const inp = bd.querySelector<HTMLInputElement>('.koi-palette-input')!;
    expect(inp.type).toBe('text');
    expect(inp.getAttribute('aria-label')).toBe('Command palette');
    expect(inp.placeholder).toBe('Type a command…');

    expect(bd.querySelector('.koi-palette-list')!.getAttribute('role')).toBe('listbox');
  });

  test('starts closed; the list is empty until open() snapshots the provider', () => {
    const palette = createCommandPalette(sampleCommands);
    expect(palette.isOpen).toBe(false);
    // Nothing rendered before the first open.
    expect(rows().length).toBe(0);
  });
});

describe('open / close / toggle', () => {
  test('open() reveals the backdrop, renders every command, and selects the first', () => {
    const palette = createCommandPalette(sampleCommands);
    palette.open();

    expect(palette.isOpen).toBe(true);
    expect(backdrop().hidden).toBe(false);
    expect(titles()).toEqual(['Open File', 'Save File', 'Close Tab', 'Format Document']);
    expect(selectedIndex()).toBe(0);
  });

  test('open() snapshots the provider fresh each time (commands can change between opens)', () => {
    let set: Command[] = [cmd('a', 'Alpha')];
    const palette = createCommandPalette(() => set);

    palette.open();
    expect(titles()).toEqual(['Alpha']);
    palette.close();

    set = [cmd('b', 'Beta'), cmd('g', 'Gamma')];
    palette.open();
    expect(titles()).toEqual(['Beta', 'Gamma']);
  });

  test('open() is idempotent — a second open() while open does not re-snapshot or reset', () => {
    const provider = vi.fn(sampleCommands);
    const palette = createCommandPalette(provider);

    palette.open();
    expect(provider).toHaveBeenCalledTimes(1);
    palette.open(); // already open → no-op
    expect(provider).toHaveBeenCalledTimes(1);
    expect(palette.isOpen).toBe(true);
  });

  test('close() hides the backdrop and reports closed', () => {
    const palette = createCommandPalette(sampleCommands);
    palette.open();
    palette.close();

    expect(palette.isOpen).toBe(false);
    expect(backdrop().hidden).toBe(true);
  });

  test('close() is idempotent — closing an already-closed palette is a no-op', () => {
    const palette = createCommandPalette(sampleCommands);
    expect(() => palette.close()).not.toThrow();
    expect(palette.isOpen).toBe(false);
  });

  test('toggle() flips open↔closed', () => {
    const palette = createCommandPalette(sampleCommands);
    palette.toggle();
    expect(palette.isOpen).toBe(true);
    palette.toggle();
    expect(palette.isOpen).toBe(false);
  });

  test('reopening resets the query and selection back to the first command', () => {
    const palette = createCommandPalette(sampleCommands);
    palette.open();
    typeQuery('format');
    keydown('ArrowDown'); // would move selection within the (single) filtered set
    palette.close();

    palette.open();
    expect(input().value).toBe('');
    expect(titles()).toEqual(['Open File', 'Save File', 'Close Tab', 'Format Document']);
    expect(selectedIndex()).toBe(0);
  });

  test('open() moves focus into the input', () => {
    const palette = createCommandPalette(sampleCommands);
    palette.open();
    expect(document.activeElement).toBe(input());
  });

  test('close() restores focus to whatever was focused before opening', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const palette = createCommandPalette(sampleCommands);
    palette.open();
    expect(document.activeElement).toBe(input());

    palette.close();
    expect(document.activeElement).toBe(opener);
  });
});

describe('rendering rows', () => {
  test('renders the hint span only for commands that carry a hint', () => {
    const palette = createCommandPalette(sampleCommands);
    palette.open();

    const r = rows();
    // 'Open File' has a hint; 'Close Tab' (index 2) has none.
    expect(r[0].querySelector('.koi-palette-item-hint')!.textContent).toBe('Cmd+O');
    expect(r[2].querySelector('.koi-palette-item-hint')).toBeNull();
  });

  test('each row is a listbox option with aria-selected reflecting the current selection', () => {
    const palette = createCommandPalette(sampleCommands);
    palette.open();
    const r = rows();
    expect(r.every((row) => row.getAttribute('role') === 'option')).toBe(true);
    expect(r.map((row) => row.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false']);
  });

  test('shows the empty state and no option rows when nothing matches', () => {
    const palette = createCommandPalette(sampleCommands);
    palette.open();
    typeQuery('zzzzz');

    expect(rows().length).toBe(0);
    const empty = backdrop().querySelector('.koi-palette-empty')!;
    expect(empty.textContent).toBe('No matching commands');
  });
});

describe('filtering / subsequence matching', () => {
  test('empty query matches every command', () => {
    const palette = createCommandPalette(sampleCommands);
    palette.open();
    typeQuery('   '); // trimmed to '' → matches all
    expect(titles()).toEqual(['Open File', 'Save File', 'Close Tab', 'Format Document']);
  });

  test('filters by plain substring (case-insensitive)', () => {
    const palette = createCommandPalette(sampleCommands);
    palette.open();
    typeQuery('file');
    expect(titles()).toEqual(['Open File', 'Save File']);
  });

  test('matches a non-contiguous subsequence in order', () => {
    const palette = createCommandPalette(sampleCommands);
    palette.open();
    // 'ot' → "f-O-rmat-T..." : O before T in "Format Document"; also "Close Tab"? c-l-O-se T-ab → o..t yes.
    typeQuery('opn'); // O…p…n appears in "Open File" only (O-pe-N)
    expect(titles()).toEqual(['Open File']);
  });

  test('an exact full-title query keeps just that command', () => {
    const palette = createCommandPalette(sampleCommands);
    palette.open();
    typeQuery('Close Tab');
    expect(titles()).toEqual(['Close Tab']);
  });

  test('respects character order — out-of-order chars do NOT match', () => {
    const palette = createCommandPalette(sampleCommands);
    palette.open();
    // "nepo" is "open" reversed: the chars exist but not in order → no match.
    typeQuery('nepo');
    expect(rows().length).toBe(0);
  });

  test('clamps the selection into range when filtering shrinks the list', () => {
    const palette = createCommandPalette(sampleCommands);
    palette.open();
    // Move selection to the last row (index 3).
    keydown('ArrowUp'); // wraps to last
    expect(selectedIndex()).toBe(3);

    // Filter down to two rows: selection clamps to the new last index (1), not the stale 3.
    typeQuery('file');
    expect(titles()).toEqual(['Open File', 'Save File']);
    expect(selectedIndex()).toBe(1);
  });

  test('selection resets to 0 when a filter empties then refills the list', () => {
    const palette = createCommandPalette(sampleCommands);
    palette.open();
    keydown('ArrowUp'); // selected = 3
    typeQuery('zzzzz'); // no matches → selected pinned at 0
    expect(rows().length).toBe(0);
    typeQuery('file'); // back to two matches
    expect(selectedIndex()).toBe(0);
  });
});

describe('keyboard navigation', () => {
  test('ArrowDown moves selection down and preventDefault()s', () => {
    const palette = createCommandPalette(sampleCommands);
    palette.open();
    const e = keydown('ArrowDown');
    expect(selectedIndex()).toBe(1);
    expect(e.defaultPrevented).toBe(true);
  });

  test('ArrowUp from the first row wraps to the last', () => {
    const palette = createCommandPalette(sampleCommands);
    palette.open();
    const e = keydown('ArrowUp');
    expect(selectedIndex()).toBe(3);
    expect(e.defaultPrevented).toBe(true);
  });

  test('ArrowDown from the last row wraps back to the first', () => {
    const palette = createCommandPalette(sampleCommands);
    palette.open();
    keydown('ArrowDown'); // 1
    keydown('ArrowDown'); // 2
    keydown('ArrowDown'); // 3
    expect(selectedIndex()).toBe(3);
    keydown('ArrowDown'); // wraps to 0
    expect(selectedIndex()).toBe(0);
  });

  test('arrow keys with an empty (no-match) list are a safe no-op', () => {
    const palette = createCommandPalette(sampleCommands);
    palette.open();
    typeQuery('zzzzz');
    expect(() => {
      keydown('ArrowDown');
      keydown('ArrowUp');
    }).not.toThrow();
    expect(rows().length).toBe(0);
  });

  test('an unrelated key (e.g. a letter) leaves selection alone and is not prevented', () => {
    const palette = createCommandPalette(sampleCommands);
    palette.open();
    const e = keydown('a');
    expect(selectedIndex()).toBe(0);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe('running commands', () => {
  test('Enter runs the selected command, closes the palette, and preventDefault()s', () => {
    const commands = sampleCommands();
    const palette = createCommandPalette(() => commands);
    palette.open();
    keydown('ArrowDown'); // select 'Save File' (index 1)

    const e = keydown('Enter');
    expect(commands[1].run).toHaveBeenCalledTimes(1);
    expect(commands[0].run).not.toHaveBeenCalled();
    expect(palette.isOpen).toBe(false);
    expect(e.defaultPrevented).toBe(true);
  });

  test('runs the command that matches after filtering, not the original index', () => {
    const commands = sampleCommands();
    const palette = createCommandPalette(() => commands);
    palette.open();
    typeQuery('format'); // only 'Format Document' remains, selected at 0
    keydown('Enter');
    expect(commands[3].run).toHaveBeenCalledTimes(1); // Format Document
  });

  test('Enter with no matching command does nothing and stays open', () => {
    const commands = sampleCommands();
    const palette = createCommandPalette(() => commands);
    palette.open();
    typeQuery('zzzzz'); // empty filtered list
    keydown('Enter');
    expect(commands.every((c) => (c.run as ReturnType<typeof vi.fn>).mock.calls.length === 0)).toBe(true);
    expect(palette.isOpen).toBe(true);
  });

  test('clicking a row runs that command and closes', () => {
    const commands = sampleCommands();
    const palette = createCommandPalette(() => commands);
    palette.open();

    rows()[2].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(commands[2].run).toHaveBeenCalledTimes(1); // Close Tab
    expect(palette.isOpen).toBe(false);
  });

  test('close runs BEFORE the command body (so a command can reopen the palette)', () => {
    const order: string[] = [];
    const reopening = createCommandPalette(() => [
      {
        id: 'x',
        title: 'Reopen',
        run() {
          order.push('run');
          // The palette is already closed by the time run() executes; reopening must work.
          expect(reopening.isOpen).toBe(false);
        },
      },
    ]);
    reopening.open();
    keydown('Enter');
    expect(order).toEqual(['run']);
  });
});

describe('pointer selection', () => {
  test('mousemove over a row previews selection without running it', () => {
    const commands = sampleCommands();
    const palette = createCommandPalette(() => commands);
    palette.open();

    rows()[2].dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(selectedIndex()).toBe(2);
    expect(commands[2].run).not.toHaveBeenCalled();
  });

  test('re-selecting the already-selected row via mousemove is a no-op (no aria churn)', () => {
    const palette = createCommandPalette(sampleCommands);
    palette.open();
    // Row 0 is already selected; a mousemove on it should not change anything.
    rows()[0].dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(selectedIndex()).toBe(0);
  });
});

describe('backdrop dismissal', () => {
  test('mousedown on the backdrop itself closes the palette', () => {
    const palette = createCommandPalette(sampleCommands);
    palette.open();

    const e = new MouseEvent('mousedown', { bubbles: true });
    Object.defineProperty(e, 'target', { value: backdrop() });
    backdrop().dispatchEvent(e);

    expect(palette.isOpen).toBe(false);
  });

  test('mousedown inside the panel does NOT close (target is not the backdrop)', () => {
    const palette = createCommandPalette(sampleCommands);
    palette.open();

    const panel = backdrop().querySelector('.koi-palette')!;
    const e = new MouseEvent('mousedown', { bubbles: true });
    Object.defineProperty(e, 'target', { value: panel });
    backdrop().dispatchEvent(e);

    expect(palette.isOpen).toBe(true);
  });
});

describe('overlay-stack integration (Esc)', () => {
  test('Escape closes the palette via the shared overlay stack', () => {
    const palette = createCommandPalette(sampleCommands);
    palette.open();
    expect(palette.isOpen).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(palette.isOpen).toBe(false);
  });

  test('a closed palette is unregistered — Escape after close does not throw', () => {
    const palette = createCommandPalette(sampleCommands);
    palette.open();
    palette.close();
    expect(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    ).not.toThrow();
    expect(palette.isOpen).toBe(false);
  });
});
