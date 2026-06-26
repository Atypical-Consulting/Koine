// Covers the happy-dom requestAnimationFrame/cancelAnimationFrame shim that test-setup.ts installs
// (issue #493). CodeMirror's EditorView captures its owning window as `this.win` and reads
// `this.win.requestAnimationFrame` from a DEFERRED measure (DOMObserver.onResize schedules a 50ms
// setTimeout -> view.requestMeasure()). If that timer fires after the owning test/file has ended and
// happy-dom has torn the window's rAF down, the read throws an uncaught
// `TypeError: this.win.requestAnimationFrame is not a function`, which Vitest counts as a run error and
// exits the worker non-zero — failing the studio job despite a fully green suite. Destroying every
// EditorView in teardown is the operative fix; this shim is the defense-in-depth safety net (it
// guarantees a setTimeout-backed rAF/cAF whenever the host lacks one — e.g. a future happy-dom that
// ships without it), and must stay inert when a real rAF is present so a browser/Playwright run is
// never clobbered.
import { describe, expect, test, vi } from 'vitest';
import { installRafShim } from './test-setup';

describe('installRafShim (#493)', () => {
  test('installs a setTimeout-backed requestAnimationFrame/cancelAnimationFrame when absent', () => {
    const target: Record<string, unknown> = {};
    installRafShim(target);
    expect(typeof target.requestAnimationFrame).toBe('function');
    expect(typeof target.cancelAnimationFrame).toBe('function');

    // setTimeout-backed: the callback is deferred, then drains under the timer queue with the numeric
    // timestamp CodeMirror's measure callback expects.
    vi.useFakeTimers();
    try {
      const cb = vi.fn();
      (target.requestAnimationFrame as (cb: FrameRequestCallback) => number)(cb);
      expect(cb).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(cb).toHaveBeenCalledTimes(1);
      expect(typeof (cb.mock.calls[0] as unknown[])[0]).toBe('number');
    } finally {
      vi.useRealTimers();
    }
  });

  test('cancelAnimationFrame stops a pending callback (clearTimeout-backed)', () => {
    const target: Record<string, unknown> = {};
    installRafShim(target);
    vi.useFakeTimers();
    try {
      const cb = vi.fn();
      const id = (target.requestAnimationFrame as (cb: FrameRequestCallback) => number)(cb);
      (target.cancelAnimationFrame as (id: number) => void)(id);
      vi.runAllTimers();
      expect(cb).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('is inert when the host already provides requestAnimationFrame (never clobbers a real one)', () => {
    const realRaf = (): number => 0;
    const realCaf = (): void => {};
    const target: Record<string, unknown> = { requestAnimationFrame: realRaf, cancelAnimationFrame: realCaf };
    installRafShim(target);
    // The browser/Playwright (storybook) project must keep its compositor-backed rAF untouched.
    expect(target.requestAnimationFrame).toBe(realRaf);
    expect(target.cancelAnimationFrame).toBe(realCaf);
  });

  test('the setup file installed the shim contract onto window and globalThis', () => {
    // happy-dom 20 already ships rAF, so the live values may be happy-dom's native ones — either way the
    // contract the shim guarantees (callable rAF/cAF on both surfaces) must hold for CodeMirror.
    expect(typeof window.requestAnimationFrame).toBe('function');
    expect(typeof window.cancelAnimationFrame).toBe('function');
    expect(typeof globalThis.requestAnimationFrame).toBe('function');
    expect(typeof globalThis.cancelAnimationFrame).toBe('function');
  });
});
