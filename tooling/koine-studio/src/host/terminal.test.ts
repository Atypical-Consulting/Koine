import { describe, it, expect } from 'vitest';
import type { Platform } from '@/host/types';
import { TauriPlatform } from '@/host/tauri';
import { BrowserPlatform } from '@/host/browser';

// The integrated terminal is a desktop-only capability: the Tauri host brokers a real PTY, while a
// plain browser tab cannot spawn a shell and must degrade gracefully. The platform layer advertises
// this through `canRunShell` + an OPTIONAL `createTerminal()` factory, and the two backends sit on
// opposite sides of that line. (The UI panel keys off `canRunShell` alone — issue #256.)
describe('Platform.canRunShell + terminal transport', () => {
  it('the browser backend cannot run a shell and exposes no terminal transport', () => {
    const browser: Platform = new BrowserPlatform();
    expect(browser.canRunShell).toBe(false);
    expect(browser.createTerminal).toBeUndefined();
  });

  it('the Tauri backend can run a shell and exposes a terminal transport factory', () => {
    const tauri: Platform = new TauriPlatform();
    expect(tauri.canRunShell).toBe(true);
    expect(typeof tauri.createTerminal).toBe('function');
  });

  it('the Tauri terminal transport implements the full TerminalTransport surface', () => {
    const transport = new TauriPlatform().createTerminal!();
    for (const method of ['start', 'write', 'resize', 'onData', 'onExit', 'stop'] as const) {
      expect(typeof transport[method]).toBe('function');
    }
  });
});
