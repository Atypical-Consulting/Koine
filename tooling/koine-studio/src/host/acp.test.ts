import { describe, it, expect, vi, beforeEach } from 'vitest';

// Drive TauriAcpTransport against mocked Tauri IPC, the same way tauriTerminal.test.ts drives the PTY
// transport: `listen` hands back a fresh unlisten spy per call so a restart can be proven to detach the
// previous acp:// listeners before re-subscribing. Only the two APIs `start()` touches are mocked.
const { listenMock, invokeMock, unlistenSpies } = vi.hoisted(() => ({
  listenMock: vi.fn(),
  invokeMock: vi.fn(),
  unlistenSpies: [] as Array<ReturnType<typeof vi.fn>>,
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { BrowserPlatform } from '@/host/browser';
import { TauriPlatform } from '@/host/tauri';
import type { AgentSpec, Platform } from '@/host/types';

const SPEC: AgentSpec = {
  command: 'npx',
  args: ['@zed-industries/claude-code-acp'],
  env: [{ name: 'ANTHROPIC_API_KEY', value: 'sk-x' }],
  cwd: '/work',
};

/** One `listen(name, handler)` registration, typed so a test can fire the handler without `any`. */
type Registration = [string, (event: { payload: unknown }) => void];

/** The handler the transport registered for `event`. Throws (rather than returning undefined) so a
 *  missing registration fails as itself instead of as a null-dereference three lines later. */
function handlerFor(event: string): (e: { payload: unknown }) => void {
  const registration = (listenMock.mock.calls as Registration[]).find(([name]) => name === event);
  if (!registration) throw new Error(`no listener registered for ${event}`);
  return registration[1];
}

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

describe('host capability — hosting an ACP agent', () => {
  it('the desktop host can host agents and offers the factory', () => {
    const p = new TauriPlatform();
    expect(p.canHostAgents).toBe(true);
    expect(typeof p.createAcpTransport).toBe('function');
  });

  // ACP's only stable transport is stdio, and a tab cannot spawn a child — so the browser host omits
  // the factory entirely rather than offering one that always throws (ADR 0022). Same shape as
  // canRunShell/createTerminal.
  it('the browser host cannot host agents and omits the factory entirely', () => {
    // Typed as `Platform`, not `BrowserPlatform`: the point of the assertion is that a caller holding
    // the INTERFACE finds no factory there, which is what the optional-member contract promises.
    const p: Platform = new BrowserPlatform();
    expect(p.canHostAgents).toBe(false);
    expect(p.createAcpTransport).toBeUndefined();
  });
});

describe('TauriAcpTransport', () => {
  it('subscribes to acp://message and acp://exit BEFORE spawning, and forwards the spec', async () => {
    const transport = new TauriPlatform().createAcpTransport();
    await transport.start(SPEC);

    expect(listenMock).toHaveBeenCalledWith('acp://message', expect.any(Function));
    expect(listenMock).toHaveBeenCalledWith('acp://exit', expect.any(Function));
    expect(invokeMock).toHaveBeenCalledWith('acp_start', { spec: SPEC });

    // Ordering matters: a message emitted between spawn and subscribe would be lost, and the agent's
    // `initialize` response is the very first thing on the wire. Compare against `acp_start`
    // specifically — `acp_stop` legitimately runs BEFORE the listeners (see below).
    const startIndex = invokeMock.mock.calls.findIndex(([cmd]) => cmd === 'acp_start');
    const startOrder = invokeMock.mock.invocationCallOrder[startIndex];
    expect(Math.max(...listenMock.mock.invocationCallOrder)).toBeLessThan(startOrder);
  });

  // `acp_start` refuses while an agent is alive rather than silently keeping the old child under the
  // new spec, so switching agents MUST be stop-then-start. If the transport skipped this, a switch
  // would leave Studio talking to the previous agent while the UI showed the new one.
  it('stops any running agent before starting, so a switch cannot keep the old child', async () => {
    const transport = new TauriPlatform().createAcpTransport();
    await transport.start(SPEC);

    const commands = invokeMock.mock.calls.map(([cmd]) => cmd as string);
    expect(commands).toEqual(['acp_stop', 'acp_start']);
  });

  it('a host that rejects the pre-emptive stop does not block the start', async () => {
    const transport = new TauriPlatform().createAcpTransport();
    invokeMock.mockRejectedValueOnce(new Error('nothing running'));
    await expect(transport.start(SPEC)).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenCalledWith('acp_start', { spec: SPEC });
  });

  it('delivers agent→client messages to the registered handler', async () => {
    const transport = new TauriPlatform().createAcpTransport();
    const seen: string[] = [];
    transport.onMessage((json) => seen.push(json));
    await transport.start(SPEC);

    handlerFor('acp://message')({ payload: '{"jsonrpc":"2.0","id":1}' });
    expect(seen).toEqual(['{"jsonrpc":"2.0","id":1}']);
  });

  it('reports the agent exit code, defaulting to -1 on a non-numeric payload', async () => {
    const transport = new TauriPlatform().createAcpTransport();
    const codes: number[] = [];
    transport.onExit((code) => codes.push(code));
    await transport.start(SPEC);

    const onExit = handlerFor('acp://exit');
    onExit({ payload: 3 });
    onExit({ payload: undefined });
    expect(codes).toEqual([3, -1]);
  });

  it('send() forwards one serialized message to the host', async () => {
    const transport = new TauriPlatform().createAcpTransport();
    await transport.send('{"method":"session/prompt"}');
    expect(invokeMock).toHaveBeenCalledWith('acp_send', { message: '{"method":"session/prompt"}' });
  });

  it('a restart detaches the prior listeners before re-subscribing (no leak, no doubled messages)', async () => {
    const transport = new TauriPlatform().createAcpTransport();

    await transport.start(SPEC);
    expect(listenMock).toHaveBeenCalledTimes(2);
    expect(unlistenSpies[0]).not.toHaveBeenCalled();

    await transport.start(SPEC);
    expect(listenMock).toHaveBeenCalledTimes(4);
    expect(unlistenSpies[0]).toHaveBeenCalledTimes(1);
    expect(unlistenSpies[1]).toHaveBeenCalledTimes(1);
    expect(unlistenSpies[2]).not.toHaveBeenCalled();
    expect(unlistenSpies[3]).not.toHaveBeenCalled();
  });

  it('stop() detaches the live listeners and asks the host to stop the agent', async () => {
    const transport = new TauriPlatform().createAcpTransport();
    await transport.start(SPEC);
    await transport.stop();

    expect(unlistenSpies[0]).toHaveBeenCalledTimes(1);
    expect(unlistenSpies[1]).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('acp_stop');
  });

  it('stop() is best-effort: a host that is already gone does not reject', async () => {
    const transport = new TauriPlatform().createAcpTransport();
    await transport.start(SPEC);
    invokeMock.mockRejectedValueOnce(new Error('host gone'));
    await expect(transport.stop()).resolves.toBeUndefined();
  });
});
