import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KOINE_PRIMER } from '@/ai/assistantTools';
import { CURSOR_MARKER, requestInline } from './inlineCompletionClient';
import type { Settings } from '@/settings/persistence';

// The client is a thin adapter over the chat AI layer + persisted settings. We mock both: the provider
// (runAssistant) so no network is touched and we can inspect the request it built, and loadSettings so
// we can drive the "configured / not configured" branches deterministically.
const h = vi.hoisted(() => ({
  runImpl: null as null | ((req: { system: string; messages: { content: string }[] }) => Promise<string>),
  lastReq: null as null | Record<string, unknown>,
  settings: null as Settings | null,
}));

vi.mock('@/ai/ai', () => ({
  runAssistant: (req: Record<string, unknown>) => {
    h.lastReq = req;
    return h.runImpl!(req as never);
  },
}));

vi.mock('@/settings/persistence', () => ({
  loadSettings: () => h.settings,
}));

function configured(over: Partial<Settings> = {}): Settings {
  return {
    aiProvider: 'anthropic',
    aiBaseUrl: 'https://api.openai.com/v1',
    aiApiKey: 'sk-test',
    aiModel: 'claude-opus-4-8',
    aiModelOpenai: 'gpt-4o',
    ...over,
  } as Settings;
}

const ctx = { before: 'value Money {\n  amount: ', after: '\n}', uri: 'file:///m.koi' };

describe('inline-completion client', () => {
  beforeEach(() => {
    h.runImpl = async () => 'Decimal';
    h.lastReq = null;
    h.settings = configured();
  });

  it('returns the model continuation', async () => {
    h.runImpl = async () => 'Decimal';
    const res = await requestInline(ctx, new AbortController().signal);
    expect(res).toBe('Decimal');
  });

  it('returns null (and never calls the provider) when no key is configured for a provider that needs one', async () => {
    h.settings = configured({ aiApiKey: '' });
    const res = await requestInline(ctx, new AbortController().signal);
    expect(res).toBeNull();
    expect(h.lastReq).toBeNull();
  });

  it('still suggests for a keyless local OpenAI-compatible server (no key required)', async () => {
    h.settings = configured({ aiProvider: 'openai', aiBaseUrl: 'http://localhost:1234/v1', aiApiKey: '' });
    const res = await requestInline(ctx, new AbortController().signal);
    expect(res).toBe('Decimal');
    expect(h.lastReq).not.toBeNull();
  });

  it('returns null when the request was aborted', async () => {
    const c = new AbortController();
    c.abort();
    h.runImpl = async () => 'Decimal'; // even if the provider returns text, an aborted signal wins
    const res = await requestInline(ctx, c.signal);
    expect(res).toBeNull();
  });

  it('returns null and never throws on a provider error', async () => {
    h.runImpl = async () => {
      throw new Error('500 internal error');
    };
    await expect(requestInline(ctx, new AbortController().signal)).resolves.toBeNull();
  });

  it('builds a prompt that carries the Koine primer and a cursor marker around the buffer', async () => {
    await requestInline(ctx, new AbortController().signal);
    expect(h.lastReq).not.toBeNull();
    expect(String(h.lastReq!.system)).toContain(KOINE_PRIMER);
    const user = (h.lastReq!.messages as { content: string }[]).map((m) => m.content).join('\n');
    expect(user).toContain(CURSOR_MARKER);
    expect(user).toContain('value Money {');
    expect(user).toContain(`${ctx.before}${CURSOR_MARKER}${ctx.after}`);
  });

  it('forwards the provider-appropriate model (OpenAI id for the openai provider)', async () => {
    h.settings = configured({ aiProvider: 'openai', aiBaseUrl: 'http://localhost:1234/v1', aiApiKey: '' });
    await requestInline(ctx, new AbortController().signal);
    expect(h.lastReq!.model).toBe('gpt-4o');
  });

  it('unwraps a fenced block and trims trailing whitespace the model may add', async () => {
    h.runImpl = async () => '```koine\norder: Order\n```\n';
    const res = await requestInline(ctx, new AbortController().signal);
    expect(res).toBe('order: Order');
  });

  it('returns null when the model produces only whitespace', async () => {
    h.runImpl = async () => '   \n  ';
    const res = await requestInline(ctx, new AbortController().signal);
    expect(res).toBeNull();
  });
});
