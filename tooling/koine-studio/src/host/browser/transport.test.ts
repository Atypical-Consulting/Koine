import { describe, expect, test, vi } from 'vitest';

// Routing coverage for the browser WasmLspTransport: each JSON-RPC `method` must dispatch to the right
// [JSExport] on the WASM api with the right argument shape, and reply with the parsed result. The WASM
// loader is mocked so dispatch is testable without booting the .NET runtime (mirrors tools.test.ts).
// Each export is a spy returning canned JSON in the camelCase shapes CompilerInterop emits.
const api = vi.hoisted(() => ({
  DiagnoseWorkspace: vi.fn<(f: string) => string>(() => '[]'),
  InlayHints:
    vi.fn<
      (f: string, u: string, sl: number, sc: number, el: number, ec: number) => string
    >(),
  PrepareCallHierarchy: vi.fn<(f: string, u: string, l: number, c: number) => string>(),
  IncomingCalls: vi.fn<(f: string, item: string) => string>(),
  OutgoingCalls: vi.fn<(f: string, item: string) => string>(),
}));
vi.mock('@/host/browser/wasm', () => ({ loadWasmApi: () => Promise.resolve(api) }));

import { WasmLspTransport } from '@/host/browser/transport';

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
});
