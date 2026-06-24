import { afterEach, describe, expect, test, vi } from 'vitest';
import { KoineLsp } from '@/lsp/lsp';
import type { CallHierarchyItem } from '@/lsp/lsp';
import type { LspTransport } from '@/host/types';

// Document-sync protocol coverage for KoineLsp, driven through a fake LspTransport that records every
// outgoing JSON-RPC message. These pin the ordering invariants the client exists to guarantee — version
// monotonicity, the debounced-didChange/flush dance, and "a didChange can never precede a didOpen" —
// without a real sidecar or WASM server. notify() calls transport.send() synchronously, so a recorded
// message is observable immediately after the call that triggers it (no awaiting needed).

type Sent = { jsonrpc: string; id?: number; method: string; params: any };

function harness() {
  const sent: Sent[] = [];
  const transport: LspTransport = {
    start: () => Promise.resolve(),
    send: (m: string) => {
      sent.push(JSON.parse(m));
      return Promise.resolve();
    },
    onMessage: () => {},
    onExit: () => {},
    onRestart: () => {},
    stop: () => Promise.resolve(),
  };
  return { lsp: new KoineLsp(transport), sent };
}

const byMethod = (sent: Sent[], method: string) => sent.filter((m) => m.method === method);

const URI = 'file:///a.koi';

describe('KoineLsp document sync', () => {
  test('openDoc sends didOpen at version 1 with the full text', () => {
    const { lsp, sent } = harness();
    lsp.openDoc(URI, 'hello');
    const opens = byMethod(sent, 'textDocument/didOpen');
    expect(opens).toHaveLength(1);
    expect(opens[0].params.textDocument).toMatchObject({ uri: URI, languageId: 'koine', version: 1, text: 'hello' });
  });

  test('re-opening a tracked uri bumps the version', () => {
    const { lsp, sent } = harness();
    lsp.openDoc(URI, 'v1');
    lsp.openDoc(URI, 'v2');
    const opens = byMethod(sent, 'textDocument/didOpen');
    expect(opens.map((o) => o.params.textDocument.version)).toEqual([1, 2]);
  });

  test('changeDoc on an unopened uri is dropped (never a didChange before a didOpen)', () => {
    const { lsp, sent } = harness();
    lsp.changeDoc(URI, 'edit');
    lsp.flush();
    expect(byMethod(sent, 'textDocument/didChange')).toHaveLength(0);
  });

  test('flush() emits the debounced didChange synchronously, at the next version', () => {
    const { lsp, sent } = harness();
    lsp.openDoc(URI, 'v1');
    lsp.changeDoc(URI, 'v2');
    expect(byMethod(sent, 'textDocument/didChange')).toHaveLength(0); // still debounced
    lsp.flush();
    const changes = byMethod(sent, 'textDocument/didChange');
    expect(changes).toHaveLength(1);
    expect(changes[0].params.textDocument.version).toBe(2);
    expect(changes[0].params.contentChanges).toEqual([{ text: 'v2' }]);
  });

  test('flush() with nothing pending is a no-op', () => {
    const { lsp, sent } = harness();
    lsp.openDoc(URI, 'v1');
    lsp.flush();
    expect(byMethod(sent, 'textDocument/didChange')).toHaveLength(0);
  });

  test('the debounced didChange fires on its own after the debounce window', () => {
    vi.useFakeTimers();
    const { lsp, sent } = harness();
    lsp.openDoc(URI, 'v1');
    lsp.changeDoc(URI, 'v2');
    expect(byMethod(sent, 'textDocument/didChange')).toHaveLength(0);
    vi.advanceTimersByTime(250);
    expect(byMethod(sent, 'textDocument/didChange')).toHaveLength(1);
  });

  test('syncDoc falls back to didOpen for an untracked uri', () => {
    const { lsp, sent } = harness();
    lsp.syncDoc(URI, 'x');
    expect(byMethod(sent, 'textDocument/didOpen')).toHaveLength(1);
    expect(byMethod(sent, 'textDocument/didChange')).toHaveLength(0);
  });

  test('syncDoc on a tracked uri sends an immediate didChange (no debounce) at the next version', () => {
    const { lsp, sent } = harness();
    lsp.openDoc(URI, 'v1');
    lsp.syncDoc(URI, 'v2');
    const changes = byMethod(sent, 'textDocument/didChange');
    expect(changes).toHaveLength(1);
    expect(changes[0].params.textDocument.version).toBe(2);
  });

  test('reopen() re-sends didOpen for every tracked document with a bumped version', () => {
    const { lsp, sent } = harness();
    lsp.openDoc('file:///a.koi', 'a');
    lsp.openDoc('file:///b.koi', 'b');
    sent.length = 0; // ignore the initial opens
    lsp.reopen();
    const opens = byMethod(sent, 'textDocument/didOpen');
    expect(opens).toHaveLength(2);
    expect(opens.every((o) => o.params.textDocument.version === 2)).toBe(true);
  });

  test('closeDoc sends didClose and stops tracking (a later changeDoc is dropped)', () => {
    const { lsp, sent } = harness();
    lsp.openDoc(URI, 'v1');
    lsp.closeDoc(URI);
    expect(byMethod(sent, 'textDocument/didClose')).toHaveLength(1);
    lsp.changeDoc(URI, 'after-close');
    lsp.flush();
    expect(byMethod(sent, 'textDocument/didChange')).toHaveLength(0);
  });
});

// A harness that, unlike the document-sync one above, can ANSWER requests: the fake transport echoes
// each outgoing request id back through its onMessage handler with a canned `result`, so the request
// promise resolves. `setActive(URI)` is called so every request method's `textDocument.uri` is filled.
function responder(reply: (method: string, params: any) => unknown) {
  const sent: Sent[] = [];
  let onMessage: ((json: string) => void) | undefined;
  const transport: LspTransport = {
    start: () => Promise.resolve(),
    send: (m: string) => {
      const msg = JSON.parse(m) as Sent;
      sent.push(msg);
      // Only requests (those with an id) get a reply; notifications are recorded only.
      if (msg.id != null) {
        const result = reply(msg.method, msg.params);
        // Resolve on the next microtask so the client has finished registering the pending entry.
        queueMicrotask(() => onMessage?.(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })));
      }
      return Promise.resolve();
    },
    onMessage: (cb) => {
      onMessage = cb;
    },
    onExit: () => {},
    onRestart: () => {},
    stop: () => Promise.resolve(),
  };
  // start() attaches the onMessage handler; do it directly here (no handshake needed).
  transport.onMessage((json) => lsp['handle'](JSON.parse(json)));
  const lsp = new KoineLsp(transport);
  lsp.setActive(URI);
  return { lsp, sent };
}

const lastReq = (sent: Sent[], method: string) => {
  const all = byMethod(sent, method);
  return all[all.length - 1];
};

const ITEM: CallHierarchyItem = {
  name: 'place',
  kind: 6,
  uri: URI,
  range: { start: { line: 3, character: 2 }, end: { line: 3, character: 7 } },
  selectionRange: { start: { line: 3, character: 2 }, end: { line: 3, character: 7 } },
  data: { chKind: 'Command', owningType: 'Order' },
};

describe('KoineLsp inlay hints', () => {
  test('sends textDocument/inlayHint with the active uri + 0-based range and maps the result', async () => {
    const hints = [{ position: { line: 1, character: 4 }, label: ': OrderId', kind: 1 }];
    const { lsp, sent } = responder(() => hints);
    const res = await lsp.inlayHints(1, 0, 9, 0);
    const req = lastReq(sent, 'textDocument/inlayHint');
    expect(req.params.textDocument).toEqual({ uri: URI });
    expect(req.params.range).toEqual({ start: { line: 1, character: 0 }, end: { line: 9, character: 0 } });
    expect(res).toEqual(hints);
  });

  test('maps a null result to []', async () => {
    const { lsp } = responder(() => null);
    expect(await lsp.inlayHints(0, 0, 1, 0)).toEqual([]);
  });
});

describe('KoineLsp call hierarchy', () => {
  test('prepareCallHierarchy sends the active uri + position and maps the items', async () => {
    const { lsp, sent } = responder(() => [ITEM]);
    const res = await lsp.prepareCallHierarchy(3, 4);
    const req = lastReq(sent, 'textDocument/prepareCallHierarchy');
    expect(req.params.textDocument).toEqual({ uri: URI });
    expect(req.params.position).toEqual({ line: 3, character: 4 });
    expect(res).toEqual([ITEM]);
  });

  test('prepareCallHierarchy maps a null result to []', async () => {
    const { lsp } = responder(() => null);
    expect(await lsp.prepareCallHierarchy(0, 0)).toEqual([]);
  });

  test('incomingCalls forwards the item verbatim (data included) and maps the calls', async () => {
    const calls = [{ from: ITEM, fromRanges: [ITEM.range] }];
    const { lsp, sent } = responder(() => calls);
    const res = await lsp.incomingCalls(ITEM);
    const req = lastReq(sent, 'callHierarchy/incomingCalls');
    expect(req.params).toEqual({ item: ITEM }); // whole item, including its opaque `data`
    expect(req.params.item.data).toEqual({ chKind: 'Command', owningType: 'Order' });
    expect(res).toEqual(calls);
  });

  test('incomingCalls maps a null result to []', async () => {
    const { lsp } = responder(() => null);
    expect(await lsp.incomingCalls(ITEM)).toEqual([]);
  });

  test('outgoingCalls forwards the item verbatim (data included) and maps the calls', async () => {
    const calls = [{ to: ITEM, fromRanges: [ITEM.range] }];
    const { lsp, sent } = responder(() => calls);
    const res = await lsp.outgoingCalls(ITEM);
    const req = lastReq(sent, 'callHierarchy/outgoingCalls');
    expect(req.params).toEqual({ item: ITEM });
    expect(req.params.item.data).toEqual({ chKind: 'Command', owningType: 'Order' });
    expect(res).toEqual(calls);
  });

  test('outgoingCalls maps a null result to []', async () => {
    const { lsp } = responder(() => null);
    expect(await lsp.outgoingCalls(ITEM)).toEqual([]);
  });
});

describe('KoineLsp capability queries', () => {
  test('emitTargets() sends a document-independent koine/emitTargets request (#282)', () => {
    vi.useFakeTimers(); // the request stays pending (no server here); keep its 15s timeout off the real clock.
    const { lsp, sent } = harness();
    void lsp.emitTargets().catch(() => {}); // resolves on a server response; swallow the eventual timeout.
    const reqs = byMethod(sent, 'koine/emitTargets');
    expect(reqs).toHaveLength(1);
    expect(typeof reqs[0].id).toBe('number');
    expect(reqs[0].params).toEqual({}); // no textDocument — the capability query is document-independent.
  });
});

afterEach(() => {
  vi.useRealTimers();
});
