import { describe, it, expect, vi, beforeEach } from 'vitest';

// Drive TauriTerminalTransport against mocked Tauri IPC: `listen` hands back a fresh unlisten spy per
// call so the test can prove the transport's restart path detaches the previous pty:// listeners
// before re-subscribing (a regression guard for the doubled-output / leaked-listener bug). Only the
// two APIs `start()` touches are mocked; tauri.ts's other imports load normally under happy-dom.
const { listenMock, invokeMock, unlistenSpies } = vi.hoisted(() => ({
  listenMock: vi.fn(),
  invokeMock: vi.fn(),
  unlistenSpies: [] as Array<ReturnType<typeof vi.fn>>,
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { TauriPlatform } from '@/host/tauri';

beforeEach(() => {
  unlistenSpies.length = 0;
  listenMock.mockReset();
  invokeMock.mockReset();
  listenMock.mockImplementation(async () => {
    const unlisten = vi.fn();
    unlistenSpies.push(unlisten);
    return unlisten;
  });
  invokeMock.mockResolvedValue(undefined);
});

describe('TauriTerminalTransport', () => {
  it('subscribes to pty://data and pty://exit and starts the shell with the given cwd', async () => {
    const transport = new TauriPlatform().createTerminal!();
    await transport.start('/work');

    expect(listenMock).toHaveBeenCalledWith('pty://data', expect.any(Function));
    expect(listenMock).toHaveBeenCalledWith('pty://exit', expect.any(Function));
    expect(invokeMock).toHaveBeenCalledWith('pty_start', { cwd: '/work' });
  });

  it('is idempotent: a restart detaches the prior listeners before re-subscribing (no leak)', async () => {
    const transport = new TauriPlatform().createTerminal!();

    await transport.start(null);
    expect(listenMock).toHaveBeenCalledTimes(2); // one data + one exit listener
    expect(unlistenSpies[0]).not.toHaveBeenCalled();
    expect(unlistenSpies[1]).not.toHaveBeenCalled();

    await transport.start(null); // the panel's restart-after-exit re-enters start() on the same instance
    expect(listenMock).toHaveBeenCalledTimes(4);
    // the FIRST pair was detached so output isn't delivered twice and the handles don't leak…
    expect(unlistenSpies[0]).toHaveBeenCalledTimes(1);
    expect(unlistenSpies[1]).toHaveBeenCalledTimes(1);
    // …and only the latest pair stays live.
    expect(unlistenSpies[2]).not.toHaveBeenCalled();
    expect(unlistenSpies[3]).not.toHaveBeenCalled();
  });

  it('stop() detaches the live listeners and asks the host to stop the PTY', async () => {
    const transport = new TauriPlatform().createTerminal!();
    await transport.start(null);
    await transport.stop();

    expect(unlistenSpies[0]).toHaveBeenCalledTimes(1);
    expect(unlistenSpies[1]).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('pty_stop');
  });
});
