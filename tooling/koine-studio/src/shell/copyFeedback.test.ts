// Unit tests for the shared clipboard-copy-with-flash-feedback helper (#1362) — extracted from three
// near-identical hand-rolled promise chains (mcp.ts's mcpCopyBtn/mcpRecipeCopy, surfaceLoaders.tsx's
// makeCopyButton). Pins the exact sequence all three call sites relied on: writeText(getText()) →
// 'Copied ✓' on resolve / 'Copy failed' on reject → back to the idle label 1600ms after the LATEST
// click (a second click before the reset restarts the timer, per surfaceLoaders.test.tsx's existing
// "Copy file flashes… then resets… after 1600ms" test and every original call site's `clearTimeout` +
// `setTimeout` pairing).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { makeCopyButton, wireCopyButton } from '@/shell/copyFeedback';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function mockClipboard(writeText: (text: string) => Promise<void>): void {
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(writeText) } });
}

describe('wireCopyButton', () => {
  test('a resolving write flashes the idle label to "Copied ✓", then resets after 1600ms', async () => {
    mockClipboard(async () => undefined);
    const btn = document.createElement('button');
    btn.textContent = 'Copy';
    wireCopyButton(btn, 'Copy', () => 'hello');

    btn.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('hello');
    expect(btn.textContent).toBe('Copied ✓');

    await vi.advanceTimersByTimeAsync(1599);
    expect(btn.textContent).toBe('Copied ✓');
    await vi.advanceTimersByTimeAsync(1);
    expect(btn.textContent).toBe('Copy');
  });

  test('a rejecting write flashes "Copy failed", then resets to the idle label after 1600ms', async () => {
    mockClipboard(async () => {
      throw new Error('denied');
    });
    const btn = document.createElement('button');
    btn.textContent = 'Copy';
    wireCopyButton(btn, 'Copy', () => 'hello');

    btn.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(btn.textContent).toBe('Copy failed');

    await vi.advanceTimersByTimeAsync(1600);
    expect(btn.textContent).toBe('Copy');
  });

  test('a second click before the reset fires restarts the timer — reset lands 1600ms after the LATEST click', async () => {
    mockClipboard(async () => undefined);
    const btn = document.createElement('button');
    btn.textContent = 'Copy';
    wireCopyButton(btn, 'Copy', () => 'hello');

    btn.click();
    await vi.advanceTimersByTimeAsync(800);
    expect(btn.textContent).toBe('Copied ✓');

    btn.click(); // restarts the timer — the FIRST click's reset (which would land at 1600) must not fire
    await vi.advanceTimersByTimeAsync(800);
    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(2);
    expect(btn.textContent).toBe('Copied ✓'); // still flashed — the original 1600ms-from-first-click mark passed with no reset

    await vi.advanceTimersByTimeAsync(800);
    expect(btn.textContent).toBe('Copy'); // 1600ms after the SECOND click, now it resets
  });

  test('getText() is read fresh at click time', async () => {
    mockClipboard(async () => undefined);
    const btn = document.createElement('button');
    let text = 'first';
    wireCopyButton(btn, 'Copy', () => text);

    btn.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('first');

    text = 'second';
    btn.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('second');
  });

  test('a disabled button does not write to the clipboard or flash', async () => {
    mockClipboard(async () => undefined);
    const btn = document.createElement('button');
    btn.textContent = 'Copy';
    btn.disabled = true;
    wireCopyButton(btn, 'Copy', () => 'hello');

    btn.click();
    await vi.advanceTimersByTimeAsync(2000);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(btn.textContent).toBe('Copy');
  });

  test('an empty string from getText() still proceeds (a genuinely empty file must still copy)', async () => {
    mockClipboard(async () => undefined);
    const btn = document.createElement('button');
    btn.textContent = 'Copy';
    wireCopyButton(btn, 'Copy', () => '');

    btn.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('');
    expect(btn.textContent).toBe('Copied ✓');
  });

  test('the returned disposer cancels a pending reset without throwing', async () => {
    mockClipboard(async () => undefined);
    const btn = document.createElement('button');
    btn.textContent = 'Copy';
    const cancelReset = wireCopyButton(btn, 'Copy', () => 'hello');

    btn.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(btn.textContent).toBe('Copied ✓');

    expect(() => cancelReset()).not.toThrow();
    await vi.advanceTimersByTimeAsync(2000);
    expect(btn.textContent).toBe('Copied ✓'); // the reset never fires — cancelled
  });
});

describe('makeCopyButton', () => {
  test('builds a fresh disabled button with the class, idle label, and tip', () => {
    const { el } = makeCopyButton('out-copy', 'Copy file', 'Copy this file', () => 'hello');
    expect(el.tagName).toBe('BUTTON');
    expect(el.type).toBe('button');
    expect(el.className).toBe('out-copy');
    expect(el.textContent).toBe('Copy file');
    expect(el.dataset.tip).toBe('Copy this file');
    expect(el.disabled).toBe(true);
  });

  test('is wired via wireCopyButton — a click on the (enabled) button flashes and resets', async () => {
    mockClipboard(async () => undefined);
    const { el } = makeCopyButton('out-copy', 'Copy file', 'Copy this file', () => 'hello');
    el.disabled = false;

    el.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('hello');
    expect(el.textContent).toBe('Copied ✓');

    await vi.advanceTimersByTimeAsync(1600);
    expect(el.textContent).toBe('Copy file');
  });

  test('cancelReset disposes the pending timer', async () => {
    mockClipboard(async () => undefined);
    const { el, cancelReset } = makeCopyButton('out-copy', 'Copy file', 'Copy this file', () => 'hello');
    el.disabled = false;

    el.click();
    await vi.advanceTimersByTimeAsync(0);
    cancelReset();
    await vi.advanceTimersByTimeAsync(2000);
    expect(el.textContent).toBe('Copied ✓');
  });

  test('stays inert while disabled (default state) — no write, no flash', async () => {
    mockClipboard(async () => undefined);
    const { el } = makeCopyButton('out-copy', 'Copy file', 'Copy this file', () => 'hello');

    el.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(el.textContent).toBe('Copy file');
  });
});
