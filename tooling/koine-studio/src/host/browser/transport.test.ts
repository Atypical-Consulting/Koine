import { afterEach, describe, expect, test, vi } from 'vitest';

// Routing coverage for the browser WasmLspTransport: each JSON-RPC `method` must dispatch to the right
// [JSExport] on the WASM api with the right argument shape, and reply with the parsed result. The WASM
// loader is mocked so dispatch is testable without booting the .NET runtime (mirrors tools.test.ts).
// Each export is a spy returning canned JSON in the camelCase shapes CompilerInterop emits.
const api = vi.hoisted(() => ({
  DiagnoseWorkspace: vi.fn<(f: string) => string>(() => '[]'),
  EmitPreview: vi.fn<(f: string, target: string) => string>(() => '{}'),
  SyntaxTree: vi.fn<(f: string, u: string) => string>(() => 'null'),
  InlayHints:
    vi.fn<
      (f: string, u: string, sl: number, sc: number, el: number, ec: number) => string
    >(),
  PrepareCallHierarchy: vi.fn<(f: string, u: string, l: number, c: number) => string>(),
  IncomingCalls: vi.fn<(f: string, item: string) => string>(),
  OutgoingCalls: vi.fn<(f: string, item: string) => string>(),
}));
// The transport reads getWasmWorkerClient() to route DiagnoseWorkspace through the cancellable worker
// client (#353). Default null → the main-thread path (api proxy). Supersede tests set a fake client.
const wasmState = vi.hoisted(() => ({ workerClient: null as unknown }));
vi.mock('@/host/browser/wasm', () => ({
  loadWasmApi: () => Promise.resolve(api),
  getWasmWorkerClient: () => wasmState.workerClient,
}));

import { WasmLspTransport } from '@/host/browser/transport';
import { isCompileInFlight } from '@/host/browser/compileActivity';

const URI = 'file:///a.koi';

/** Last element (ES2020 lib has no Array.prototype.at). */
const last = <T>(xs: readonly T[]): T => xs[xs.length - 1];

/** Send one request through a started transport and return the parsed `result` of the reply. */
async function roundtrip(method: string, params: unknown): Promise<unknown> {
  const transport = new WasmLspTransport();
  const replies: any[] = [];
  transport.onMessage((json) => replies.push(JSON.parse(json)));
  await transport.start();
  // Seed an open document so filesJson() carries the active file.
  await transport.send(JSON.stringify({ method: 'textDocument/didOpen', params: { textDocument: { uri: URI, text: 'x' } } }));
  await transport.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }));
  return replies.find((r) => r.id === 7)?.result;
}

describe('WasmLspTransport routing — inlay hints & call hierarchy', () => {
  test('textDocument/inlayHint reads range start/end into InlayHints and returns the parsed array', async () => {
    const hints = [{ position: { line: 1, character: 4 }, label: ': OrderId', kind: 1 }];
    api.InlayHints.mockReturnValue(JSON.stringify(hints));
    const result = await roundtrip('textDocument/inlayHint', {
      textDocument: { uri: URI },
      range: { start: { line: 1, character: 0 }, end: { line: 9, character: 2 } },
    });
    const call = last(api.InlayHints.mock.calls);
    expect(JSON.parse(call[0])).toEqual([{ uri: URI, text: 'x' }]); // filesJson envelope
    expect(call.slice(1)).toEqual([URI, 1, 0, 9, 2]); // activeUri + range bounds
    expect(result).toEqual(hints);
  });

  test('textDocument/prepareCallHierarchy passes the active uri + position to PrepareCallHierarchy', async () => {
    const items = [{ name: 'place', kind: 6, uri: URI, range: {}, selectionRange: {}, data: { chKind: 'Command' } }];
    api.PrepareCallHierarchy.mockReturnValue(JSON.stringify(items));
    const result = await roundtrip('textDocument/prepareCallHierarchy', {
      textDocument: { uri: URI },
      position: { line: 3, character: 4 },
    });
    expect(last(api.PrepareCallHierarchy.mock.calls).slice(1)).toEqual([URI, 3, 4]);
    expect(result).toEqual(items);
  });

  test('callHierarchy/incomingCalls stringifies the item (data included) into IncomingCalls', async () => {
    const item = { name: 'place', kind: 6, uri: URI, range: {}, selectionRange: {}, data: { chKind: 'Command', owningType: 'Order' } };
    const calls = [{ from: item, fromRanges: [] }];
    api.IncomingCalls.mockReturnValue(JSON.stringify(calls));
    const result = await roundtrip('callHierarchy/incomingCalls', { item });
    const itemJson = last(api.IncomingCalls.mock.calls)[1];
    expect(JSON.parse(itemJson)).toEqual(item); // verbatim, opaque data preserved
    expect(result).toEqual(calls);
  });

  test('callHierarchy/outgoingCalls stringifies the item (data included) into OutgoingCalls', async () => {
    const item = { name: 'place', kind: 6, uri: URI, range: {}, selectionRange: {}, data: { chKind: 'Event', owningType: null } };
    const calls = [{ to: item, fromRanges: [] }];
    api.OutgoingCalls.mockReturnValue(JSON.stringify(calls));
    const result = await roundtrip('callHierarchy/outgoingCalls', { item });
    const itemJson = last(api.OutgoingCalls.mock.calls)[1];
    expect(JSON.parse(itemJson)).toEqual(item);
    expect(result).toEqual(calls);
  });

  test('an absent item falls back to {} (no throw)', async () => {
    api.IncomingCalls.mockReturnValue('[]');
    const result = await roundtrip('callHierarchy/incomingCalls', {});
    expect(last(api.IncomingCalls.mock.calls)[1]).toBe('{}');
    expect(result).toEqual([]);
  });

  test('koine/syntaxTree routes to SyntaxTree with the filesJson envelope + active uri and returns the parsed tree (#890)', async () => {
    const tree = { kind: 'KoineModel', name: null, span: { line: 0, column: 0, endLine: 0, endColumn: 0, offset: 0, length: 0, file: null }, isMissing: false, isError: false, leaf: null, children: [] };
    api.SyntaxTree.mockReturnValue(JSON.stringify(tree));
    const result = await roundtrip('koine/syntaxTree', { textDocument: { uri: URI } });
    const call = last(api.SyntaxTree.mock.calls);
    expect(JSON.parse(call[0])).toEqual([{ uri: URI, text: 'x' }]); // filesJson envelope
    expect(call[1]).toBe(URI); // active uri
    expect(result).toEqual(tree);
  });

  test('koine/syntaxTree passes through the JSON literal null for an unknown active uri (#890)', async () => {
    api.SyntaxTree.mockReturnValue('null');
    const result = await roundtrip('koine/syntaxTree', { textDocument: { uri: 'file:///nope.koi' } });
    expect(last(api.SyntaxTree.mock.calls)[1]).toBe('file:///nope.koi');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Supersede stale keystroke-driven diagnostics (#353)
// ---------------------------------------------------------------------------

/** A controllable in-flight DiagnoseWorkspace call recorded by the fake worker client. */
interface RecordedCall {
  method: string;
  args: unknown[];
  signal: AbortSignal | undefined;
  resolve: (value: string) => void;
  reject: (err: Error) => void;
}

/**
 * A fake WorkerClient whose `call()` records each invocation and returns a promise the test settles
 * by hand. An aborted signal rejects the call — mirroring the real worker client's AbortSignal
 * integration (it drops the pending id on abort).
 */
function makeFakeWorkerClient(calls: RecordedCall[]) {
  return {
    call(method: string, args: unknown[], opts?: { signal?: AbortSignal }): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        const entry: RecordedCall = { method, args, signal: opts?.signal, resolve, reject };
        calls.push(entry);
        opts?.signal?.addEventListener(
          'abort',
          () => reject(new Error('AbortError: The operation was aborted.')),
          { once: true },
        );
      });
    },
    whenReady: () => Promise.resolve(),
    cancel: vi.fn(),
    terminateAndRespawn: vi.fn(),
    dispose: vi.fn(),
  };
}

describe('WasmLspTransport — supersede stale diagnostics (#353)', () => {
  afterEach(() => {
    wasmState.workerClient = null;
  });

  test('a newer didChange aborts the in-flight diagnose; only the latest diagnostics publish', async () => {
    const calls: RecordedCall[] = [];
    wasmState.workerClient = makeFakeWorkerClient(calls);

    const transport = new WasmLspTransport();
    const published: { uri: string; diagnostics: { code?: string }[] }[] = [];
    transport.onMessage((json) => {
      const m = JSON.parse(json);
      if (m.method === 'textDocument/publishDiagnostics') published.push(m.params);
    });
    await transport.start();

    // didOpen triggers a first diagnose (call #0). Resolve it so didOpen settles; it carries no
    // diagnostics, so it publishes nothing.
    const open = transport.send(
      JSON.stringify({ method: 'textDocument/didOpen', params: { textDocument: { uri: URI, text: 'a' } } }),
    );
    expect(calls).toHaveLength(1);
    calls[0].resolve('[]');
    await open;

    // Fire two didChange-driven diagnoses back-to-back WITHOUT awaiting the first — both are in flight.
    const c1 = transport.send(
      JSON.stringify({ method: 'textDocument/didChange', params: { textDocument: { uri: URI }, contentChanges: [{ text: 'aa' }] } }),
    );
    expect(calls).toHaveLength(2); // call #1 (stale) is now pending
    const c2 = transport.send(
      JSON.stringify({ method: 'textDocument/didChange', params: { textDocument: { uri: URI }, contentChanges: [{ text: 'aaa' }] } }),
    );
    expect(calls).toHaveLength(3); // call #2 (latest) issued

    // The newer request must have aborted the prior in-flight call's signal (dropping its worker id).
    expect(calls[1].signal?.aborted).toBe(true);
    expect(calls[2].signal?.aborted).toBe(false);

    // Settle the latest call with diagnostics-B. (Call #1 already rejected via its aborted signal.)
    calls[2].resolve(JSON.stringify([{ uri: URI, diagnostics: [{ code: 'B' }] }]));
    await Promise.all([c1, c2]);

    // Only the latest diagnostics reached the client; the superseded call published nothing.
    expect(published).toHaveLength(1);
    expect(published[0].uri).toBe(URI);
    expect(published[0].diagnostics[0]?.code).toBe('B');
  });

  test('without a worker client (main-thread fallback), a stale resolution never overwrites a newer one', async () => {
    // No worker client → the transport uses the api proxy and the sequence-guard drops stale results.
    const deferreds: { resolve: (v: string) => void }[] = [];
    api.DiagnoseWorkspace.mockImplementation(
      () => new Promise<string>((resolve) => deferreds.push({ resolve })) as unknown as string,
    );

    const transport = new WasmLspTransport();
    const published: { uri: string; diagnostics: { code?: string }[] }[] = [];
    transport.onMessage((json) => {
      const m = JSON.parse(json);
      if (m.method === 'textDocument/publishDiagnostics') published.push(m.params);
    });
    await transport.start();

    // Two diagnose-triggering edits in flight (didOpen #0, then didChange #1).
    const c1 = transport.send(
      JSON.stringify({ method: 'textDocument/didOpen', params: { textDocument: { uri: URI, text: 'a' } } }),
    );
    const c2 = transport.send(
      JSON.stringify({ method: 'textDocument/didChange', params: { textDocument: { uri: URI }, contentChanges: [{ text: 'aa' }] } }),
    );
    expect(deferreds).toHaveLength(2);

    // Resolve the NEWER one first (it wins), then the stale one — which must be dropped by the guard.
    deferreds[1].resolve(JSON.stringify([{ uri: URI, diagnostics: [{ code: 'NEW' }] }]));
    deferreds[0].resolve(JSON.stringify([{ uri: URI, diagnostics: [{ code: 'STALE' }] }]));
    await Promise.all([c1, c2]);

    expect(published).toHaveLength(1);
    expect(published[0].diagnostics[0]?.code).toBe('NEW');

    api.DiagnoseWorkspace.mockReturnValue('[]'); // restore the default for any later tests
  });
});

// ---------------------------------------------------------------------------
// Compile-in-flight activity for the Stop-command gate (#469)
// ---------------------------------------------------------------------------

describe('WasmLspTransport — compile-in-flight activity (#469)', () => {
  afterEach(() => {
    wasmState.workerClient = null;
    // Each test settles every diagnose it starts, so the transport balances start/end back to idle.
    expect(isCompileInFlight()).toBe(false);
  });

  test('isCompileInFlight() is true while a worker DiagnoseWorkspace is outstanding, false once it resolves', async () => {
    const calls: RecordedCall[] = [];
    wasmState.workerClient = makeFakeWorkerClient(calls);

    const transport = new WasmLspTransport();
    transport.onMessage(() => {});
    await transport.start();

    expect(isCompileInFlight()).toBe(false);

    // didOpen triggers a diagnose (call #0) that stays pending until we settle it.
    const open = transport.send(
      JSON.stringify({ method: 'textDocument/didOpen', params: { textDocument: { uri: URI, text: 'a' } } }),
    );
    expect(calls).toHaveLength(1);
    expect(isCompileInFlight()).toBe(true); // compile in flight

    calls[0].resolve('[]');
    await open;
    expect(isCompileInFlight()).toBe(false); // settled → idle
  });

  test('the in-flight count returns to idle when a diagnose settles via the supersede/abort path', async () => {
    const calls: RecordedCall[] = [];
    wasmState.workerClient = makeFakeWorkerClient(calls);

    const transport = new WasmLspTransport();
    transport.onMessage(() => {});
    await transport.start();

    // First diagnose in flight (call #0).
    const c1 = transport.send(
      JSON.stringify({ method: 'textDocument/didOpen', params: { textDocument: { uri: URI, text: 'a' } } }),
    );
    expect(isCompileInFlight()).toBe(true);

    // A newer edit supersedes it: the prior call's signal aborts (rejecting it) and call #1 issues.
    const c2 = transport.send(
      JSON.stringify({ method: 'textDocument/didChange', params: { textDocument: { uri: URI }, contentChanges: [{ text: 'aa' }] } }),
    );
    expect(calls).toHaveLength(2);
    expect(calls[0].signal?.aborted).toBe(true);
    expect(isCompileInFlight()).toBe(true); // call #1 keeps it in flight while #0 unwinds via abort

    // Settle the latest; the aborted #0 (finally) and resolved #1 (finally) both decrement → idle.
    calls[1].resolve('[]');
    await Promise.all([c1, c2]);
    expect(isCompileInFlight()).toBe(false);
  });

  test('a non-diagnose compile (koine/emitPreview) is also bracketed as in flight', async () => {
    // EmitPreview is a real compile too (the issue spec names "diagnose + emitPreview"). Drive it through
    // the api proxy as a controllable pending promise and assert the counter brackets it.
    let resolveEmit!: (v: string) => void;
    api.EmitPreview.mockImplementation(
      () => new Promise<string>((resolve) => { resolveEmit = resolve; }) as unknown as string,
    );

    const transport = new WasmLspTransport();
    transport.onMessage(() => {});
    await transport.start();
    expect(isCompileInFlight()).toBe(false);

    const p = transport.send(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'koine/emitPreview', params: { target: 'csharp' } }));
    expect(isCompileInFlight()).toBe(true); // emit compile in flight

    resolveEmit('{}');
    await p;
    expect(isCompileInFlight()).toBe(false); // settled → idle

    api.EmitPreview.mockReturnValue('{}'); // restore the default for any later tests
  });

  test('the in-flight count returns to idle when a compile rejects with a real error', async () => {
    // A genuine compiler failure (not a cancel) must still decrement via the `finally`, or the gate sticks.
    api.DiagnoseWorkspace.mockImplementationOnce(
      () => Promise.reject(new Error('compiler boom')) as unknown as string,
    );

    const transport = new WasmLspTransport();
    transport.onMessage(() => {});
    await transport.start();

    await expect(
      transport.send(JSON.stringify({ method: 'textDocument/didOpen', params: { textDocument: { uri: URI, text: 'a' } } })),
    ).rejects.toThrow();
    expect(isCompileInFlight()).toBe(false); // errored → idle (finally ran)

    api.DiagnoseWorkspace.mockReturnValue('[]'); // restore the default for any later tests
  });
});
