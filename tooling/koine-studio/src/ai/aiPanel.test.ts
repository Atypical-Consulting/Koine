import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  buildExplainPrompt,
  buildRepairPrompt,
  buildSystem,
  createAssistantPanel,
  formatDomainIndex,
  MAX_REPAIR_ROUNDS,
  type AssistantContext,
  type AssistantPanelOptions,
  type DomainIndex,
} from '@/ai/aiPanel';
import { runAssistant } from '@/ai/ai';

// Stream a fenced ```koine block as the reply so a generative turn would normally offer "Apply"; the
// Explain path must suppress that affordance while still rendering the reply bubble.
vi.mock('@/ai/ai', async (orig) => ({
  ...(await orig<typeof import('@/ai/ai')>()),
  runAssistant: vi.fn(async (req: { onText: (t: string) => void }) => {
    const full = 'Here:\n```koine\ncontext X {}\n```';
    req.onText(full);
    return full;
  }),
}));

// A representative, populated domain index: ≥2 contexts, ≥1 aggregate with a root, ≥1 relation,
// and a partial glossary coverage (4/7).
const populatedIndex: DomainIndex = {
  contexts: ['Sales', 'Shipping'],
  aggregates: [
    { name: 'Order', root: 'Order' },
    { name: 'Cart', root: '' },
  ],
  relations: [{ upstream: 'Sales', downstream: 'Shipping', kind: 'customer-supplier' }],
  glossaryCoverage: { documented: 4, total: 7 },
};

const emptyIndex: DomainIndex = {
  contexts: [],
  aggregates: [],
  relations: [],
  glossaryCoverage: { documented: 0, total: 0 },
};

function baseCtx(): AssistantContext {
  return {
    fileName: 'shop.koi',
    source: 'context Sales {\n  aggregate Order root Order { }\n}',
    diagnostics: [
      { line: 2, col: 3, severity: 'error', message: 'unknown type Money' },
      { line: 5, col: 1, severity: 'warning', message: 'unused value' },
    ],
  };
}

describe('formatDomainIndex', () => {
  test('renders contexts, aggregate→root list, relations, and glossary coverage', () => {
    const out = formatDomainIndex(populatedIndex);
    expect(out).toContain('Compiled domain structure');
    // contexts
    expect(out).toContain('Sales');
    expect(out).toContain('Shipping');
    // aggregate with a root that differs only when non-empty/differing → here equal, so just the name;
    // and an aggregate with an empty root renders as just its name. Pin the suppression branch: an
    // equal root must NOT render as `Order → Order`, nor an empty root as `Cart → `.
    expect(out).toContain('Order');
    expect(out).toContain('Cart');
    expect(out).not.toContain('Order → Order');
    expect(out).not.toContain('Cart →');
    // relations
    expect(out).toContain('Sales');
    expect(out).toContain('customer-supplier');
    // coverage
    expect(out).toContain('4/7');
  });

  test('renders an aggregate as `name → root` when root is non-empty and differs', () => {
    const idx: DomainIndex = {
      contexts: ['Sales'],
      aggregates: [{ name: 'Order', root: 'OrderHead' }],
      relations: [],
      glossaryCoverage: { documented: 1, total: 1 },
    };
    expect(formatDomainIndex(idx)).toContain('Order → OrderHead');
  });

  test('a fully-empty index renders the empty string', () => {
    expect(formatDomainIndex(emptyIndex)).toBe('');
  });
});

describe('buildSystem', () => {
  test('with no domainIndex does not inject the compiled domain structure', () => {
    const ctx = baseCtx();
    const out = buildSystem(ctx);
    expect(out).not.toContain('Compiled domain structure');
  });

  test('with a populated domainIndex appends the formatted summary after the source block', () => {
    const ctx: AssistantContext = { ...baseCtx(), domainIndex: populatedIndex };
    const out = buildSystem(ctx);
    const baseline = buildSystem(baseCtx());
    const summary = formatDomainIndex(populatedIndex);

    // The summary is appended verbatim, separated by a blank line, and ends the prompt.
    expect(out).toContain(summary);
    expect(out.endsWith(summary)).toBe(true);
    // It is the baseline plus the summary block (byte-identical prefix).
    expect(out.startsWith(baseline)).toBe(true);
    // The summary comes AFTER the model source block.
    expect(out.indexOf('Compiled domain structure')).toBeGreaterThan(out.indexOf('Current model source'));
  });

  test('with an empty domainIndex injects nothing', () => {
    const ctx: AssistantContext = { ...baseCtx(), domainIndex: emptyIndex };
    expect(buildSystem(ctx)).toBe(buildSystem(baseCtx()));
  });
});

describe('buildExplainPrompt', () => {
  const SELECTION = 'value Money { amount: Decimal\n  invariant amount >= 0 "non-negative" }';
  const FILE = 'context Sales {\n  value Money { amount: Decimal }\n}';

  test('a non-blank selection is the code explained, wrapped in a ```koine block', () => {
    const out = buildExplainPrompt(SELECTION, FILE);
    // Plain-language, domain-expert framing.
    expect(out.toLowerCase()).toContain('plain language');
    expect(out.toLowerCase()).toContain("doesn't code");
    // Explicitly explanatory, not generative.
    expect(out.toLowerCase()).toContain('do not output');
    expect(out.toLowerCase()).toContain('explanation only');
    // The SELECTION is the wrapped code, not the whole file.
    expect(out).toContain('```koine\n' + SELECTION + '\n```');
    expect(out).not.toContain(FILE);
  });

  test('null selection falls back to the whole file source', () => {
    const out = buildExplainPrompt(null, FILE);
    expect(out).toContain('```koine\n' + FILE + '\n```');
    expect(out.toLowerCase()).toContain('explanation only');
    expect(out.toLowerCase()).toContain('do not output');
  });

  test('a blank/whitespace selection falls back to the whole file source', () => {
    const out = buildExplainPrompt('   \n  ', FILE);
    expect(out).toContain('```koine\n' + FILE + '\n```');
  });
});

describe('explain action (panel integration)', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  function makeOpts(container: HTMLElement, overrides: Partial<AssistantPanelOptions> = {}): AssistantPanelOptions {
    return {
      container,
      getProvider: () => 'anthropic',
      getBaseUrl: () => '',
      getApiKey: () => 'sk',
      getModel: () => '',
      getContext: () => ({ fileName: 'm.koi', source: 'context X {}', diagnostics: [] }),
      onApplyModel: () => {},
      onOpenPrefs: () => {},
      getWorkspaceKey: () => 'test',
      getSelection: () => ({ text: 'value Money { ... }' }),
      getUseTools: () => false,
      // Default the constraint OFF in these legacy-behavior tests so the apply-gate is bypassed; the
      // #257 grammar-constraint tests below opt it on explicitly.
      getConstrainGrammar: () => false,
      ...overrides,
    };
  }

  // The streamed reply contains a ```koine block, so the run completes; await a few microtasks for the
  // async send to settle, then check whether the Apply affordance was attached.
  async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }

  test('explain suppresses Apply but still renders the reply', async () => {
    const container = document.createElement('div');
    const panel = createAssistantPanel(makeOpts(container));
    panel.explainSelection();
    await settle();

    // Explanatory run: no "Apply to editor" button even though the reply carries a ```koine block.
    expect(container.querySelector('.koi-assistant-apply')).toBeNull();
    // The reply DID render (the run completed end-to-end).
    expect(container.querySelector('.koi-msg-assistant .koi-md')).not.toBeNull();
  });

  test('a rejected API key shows actionable guidance, not a raw 401 JSON blob', async () => {
    const container = document.createElement('div');
    let openedPrefs = false;
    createAssistantPanel(makeOpts(container, { onOpenPrefs: () => (openedPrefs = true) }));
    // The provider rejects a present-but-invalid key (the pre-flight check only catches a BLANK key).
    vi.mocked(runAssistant).mockRejectedValueOnce(
      new Error('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'),
    );
    container.querySelector<HTMLButtonElement>('.koi-assistant-quick .koi-assistant-action')!.click();
    await settle();

    const reply = container.querySelector('.koi-msg-assistant:last-of-type');
    expect(reply?.textContent).toMatch(/rejected your API key/i);
    expect(reply?.textContent).not.toMatch(/401|\{|authentication_error/); // no raw blob
    const openBtn = reply?.querySelector<HTMLButtonElement>('.koi-link-btn');
    expect(openBtn).not.toBeNull();
    openBtn!.click();
    expect(openedPrefs).toBe(true);
  });

  test('a non-auth request failure surfaces the JSON "message", not the whole blob', async () => {
    const container = document.createElement('div');
    createAssistantPanel(makeOpts(container));
    vi.mocked(runAssistant).mockRejectedValueOnce(
      new Error('500 {"error":{"message":"upstream timeout"}}'),
    );
    container.querySelector<HTMLButtonElement>('.koi-assistant-quick .koi-assistant-action')!.click();
    await settle();

    const reply = container.querySelector('.koi-msg-assistant:last-of-type');
    expect(reply?.textContent).toContain('upstream timeout');
    expect(reply?.textContent).not.toContain('{');
  });

  test('a normal generative turn DOES offer Apply (contrast)', async () => {
    const container = document.createElement('div');
    createAssistantPanel(makeOpts(container));
    // Drive a normal send via a quick-action button (offerApply defaults to true).
    const action = container.querySelector<HTMLButtonElement>('.koi-assistant-quick .koi-assistant-action');
    expect(action).not.toBeNull();
    action!.click();
    await settle();

    expect(container.querySelector('.koi-assistant-apply')).not.toBeNull();
  });

  test('a persisted explain turn replays without Apply (suppression survives reload)', async () => {
    const c1 = document.createElement('div');
    const panel = createAssistantPanel(makeOpts(c1));
    panel.explainSelection();
    await settle();

    // A fresh panel pointed at the SAME workspace key replays the stored explain turn. Even though
    // the persisted reply carries a ```koine block, the apply opt-out was stored with the turn, so
    // the replayed bubble must stay apply-free (the live suppression survives the reload).
    const c2 = document.createElement('div');
    createAssistantPanel(makeOpts(c2));
    expect(c2.querySelector('.koi-msg-assistant .koi-md')).not.toBeNull(); // the turn replayed
    expect(c2.querySelector('.koi-assistant-apply')).toBeNull(); // …without Apply
  });
});

describe('buildRepairPrompt', () => {
  test('feeds the previous model AND the line:column diagnostics back, asking for ONLY a koine block', () => {
    const out = buildRepairPrompt('context X {', 'ok: false — 1 error(s):\n- [error] 1:11 expected }');
    expect(out).toContain('does not parse');
    expect(out.toLowerCase()).toContain('only');
    expect(out).toContain('```koine\ncontext X {\n```'); // the previous candidate, fenced
    expect(out).toContain('- [error] 1:11 expected }'); // the diagnostics verbatim
  });
});

// --- grammar-constraint wiring (#257): chip, apply-gate, repair counter ------
describe('grammar-constraint mechanisms (panel integration)', () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset the shared runAssistant mock's call log AND implementation so `mock.calls[0]` is this
    // test's own first call (earlier describe blocks leave calls accumulated on the shared spy).
    vi.mocked(runAssistant).mockReset();
  });
  afterEach(() => {
    localStorage.clear();
    vi.mocked(runAssistant).mockReset();
  });

  const CLEAN = 'ok: true — no diagnostics. The model compiles.';
  const DIRTY = 'ok: false — 1 error(s), 0 warning(s):\n- [error] 1:1 boom';

  // The default mocked runAssistant streams a fenced koine block (a generative turn that offers Apply).
  function mockReply(body = 'Here is your model:\n```koine\ncontext X {}\n```'): void {
    vi.mocked(runAssistant).mockImplementation(async (req: { onText: (t: string) => void }) => {
      req.onText(body);
      return body;
    });
  }

  function opts(container: HTMLElement, over: Partial<AssistantPanelOptions> = {}): AssistantPanelOptions {
    return {
      container,
      getProvider: () => 'openai',
      getBaseUrl: () => 'http://localhost:1234/v1',
      getApiKey: () => 'sk',
      getModel: () => '',
      getContext: () => ({ fileName: 'm.koi', source: 'context X {}', diagnostics: [] }),
      onApplyModel: () => {},
      onOpenPrefs: () => {},
      getWorkspaceKey: () => 'ws',
      getSelection: () => null,
      getUseTools: () => false,
      getConstrainGrammar: () => true,
      ...over,
    };
  }

  // Drive a normal generative send via the first quick action (offerApply defaults true).
  function fire(container: HTMLElement): void {
    container.querySelector<HTMLButtonElement>('.koi-assistant-quick .koi-assistant-action')!.click();
  }

  test('gbnf path: attaches the grammar to the request, shows the chip, enables Apply when valid', async () => {
    mockReply();
    const container = document.createElement('div');
    createAssistantPanel(
      opts(container, {
        getGrammar: () => Promise.resolve('root ::= "x"'),
        runCompilerTool: () => Promise.resolve(CLEAN),
      }),
    );
    fire(container);

    await vi.waitFor(() => expect(container.querySelector('.koi-assistant-apply')).not.toBeNull());
    // The GBNF rode along on the request body.
    expect(vi.mocked(runAssistant).mock.calls[0][0].grammar).toBe('root ::= "x"');
    // The "grammar-constrained" chip is shown and Apply is enabled (valid by construction).
    expect(container.querySelector('.koi-assistant-chip')?.textContent).toBe('grammar-constrained');
    expect(container.querySelector<HTMLButtonElement>('.koi-assistant-apply')!.disabled).toBe(false);
    expect(container.querySelector('.koi-assistant-invalid')).toBeNull();
  });

  test('gbnf path: a BARE .koi reply (no ```koine fence — the grammar can\'t emit one) still chips + applies', async () => {
    // A genuinely grammar-constrained backend returns the model itself, not a fenced block.
    mockReply('context X {}');
    const container = document.createElement('div');
    createAssistantPanel(
      opts(container, {
        getGrammar: () => Promise.resolve('root ::= "x"'),
        runCompilerTool: () => Promise.resolve(CLEAN),
      }),
    );
    fire(container);

    await vi.waitFor(() => expect(container.querySelector('.koi-assistant-apply')).not.toBeNull());
    expect(container.querySelector('.koi-assistant-chip')?.textContent).toBe('grammar-constrained');
    expect(container.querySelector<HTMLButtonElement>('.koi-assistant-apply')!.disabled).toBe(false);
  });

  test('repair path (Anthropic): never valid → "repair k/N" counter, notice, Apply stays disabled', async () => {
    mockReply();
    const container = document.createElement('div');
    createAssistantPanel(
      opts(container, {
        getProvider: () => 'anthropic',
        getBaseUrl: () => '',
        runCompilerTool: () => Promise.resolve(DIRTY), // always invalid
      }),
    );
    fire(container);

    await vi.waitFor(() => expect(container.querySelector('.koi-assistant-invalid')).not.toBeNull());
    // The parse-and-repair chip + the counter that reached the max, and NO Apply button.
    expect(container.querySelector('.koi-assistant-chip')?.textContent).toBe('parse-and-repair');
    expect(container.querySelector('.koi-assistant-repair-counter')?.textContent).toBe(
      `repair ${MAX_REPAIR_ROUNDS}/${MAX_REPAIR_ROUNDS}`,
    );
    expect(container.querySelector('.koi-assistant-apply')).toBeNull();
    // No grammar was attached (Anthropic can't be token-masked).
    expect(vi.mocked(runAssistant).mock.calls[0][0].grammar).toBeUndefined();
    // initial turn + one regenerate per repair round.
    expect(vi.mocked(runAssistant).mock.calls.length).toBe(1 + MAX_REPAIR_ROUNDS);
  });

  test('repair path: invalid then valid on the first round → counter "repair 1/N", Apply enabled', async () => {
    mockReply();
    let n = 0;
    const container = document.createElement('div');
    createAssistantPanel(
      opts(container, {
        getProvider: () => 'anthropic',
        getBaseUrl: () => '',
        runCompilerTool: () => Promise.resolve(n++ === 0 ? DIRTY : CLEAN),
      }),
    );
    fire(container);

    await vi.waitFor(() => expect(container.querySelector('.koi-assistant-apply')).not.toBeNull());
    expect(container.querySelector('.koi-assistant-chip')?.textContent).toBe('parse-and-repair');
    expect(container.querySelector('.koi-assistant-repair-counter')?.textContent).toBe(`repair 1/${MAX_REPAIR_ROUNDS}`);
    expect(container.querySelector('.koi-assistant-invalid')).toBeNull();
  });

  test('desktop fallback: capable provider but no GBNF accessor → repair path, no grammar attached', async () => {
    mockReply();
    const container = document.createElement('div');
    createAssistantPanel(
      opts(container, {
        // getGrammar omitted (desktop host) though provider/baseUrl are grammar-capable.
        runCompilerTool: () => Promise.resolve(CLEAN),
      }),
    );
    fire(container);

    await vi.waitFor(() => expect(container.querySelector('.koi-assistant-apply')).not.toBeNull());
    expect(container.querySelector('.koi-assistant-chip')?.textContent).toBe('parse-and-repair');
    expect(vi.mocked(runAssistant).mock.calls[0][0].grammar).toBeUndefined();
  });

  test('no validate seam (host can\'t run tools): constraint degrades to the unguarded affordance', async () => {
    mockReply();
    const container = document.createElement('div');
    // runCompilerTool omitted → no way to parse, so Apply is offered as before, with no chip.
    createAssistantPanel(opts(container, { getProvider: () => 'anthropic', getBaseUrl: () => '' }));
    fire(container);

    await vi.waitFor(() => expect(container.querySelector('.koi-assistant-apply')).not.toBeNull());
    expect(container.querySelector('.koi-assistant-chip')).toBeNull();
  });
});
