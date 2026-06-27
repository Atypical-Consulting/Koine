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
import { GRAMMAR_PROBE_GBNF, GRAMMAR_PROBE_SENTINEL, resetGrammarCapabilityCache } from '@/ai/grammarConstraint';
import { saveChat } from '@/settings/persistence';

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

  test('a 401 with no key configured says "no API key configured", not "rejected" (#530)', async () => {
    const container = document.createElement('div');
    // openai + a loopback baseUrl ⇒ needsKey === false, so the pre-flight blank-key guard is bypassed
    // and the request actually goes out with no key; the server still 401s (e.g. a local proxy that
    // requires auth, or a future call site). The error mapper must not claim a key was "rejected".
    createAssistantPanel(
      makeOpts(container, {
        getProvider: () => 'openai',
        getBaseUrl: () => 'http://localhost:1234/v1',
        getApiKey: () => '',
      }),
    );
    vi.mocked(runAssistant).mockRejectedValueOnce(
      new Error('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'),
    );
    container.querySelector<HTMLButtonElement>('.koi-assistant-quick .koi-assistant-action')!.click();
    await settle();

    const reply = container.querySelector('.koi-msg-assistant:last-of-type');
    expect(reply?.textContent).toMatch(/no api key configured/i);
    expect(reply?.textContent).not.toMatch(/rejected/i);
    // Still actionable: the Open Settings affordance is present on this path too.
    expect(reply?.querySelector('.koi-link-btn')).not.toBeNull();
  });

  test('a whitespace-only key is treated as blank: Add-key note, no provider call (#530)', async () => {
    const container = document.createElement('div');
    // anthropic (default) ⇒ needsKey; a whitespace-only stored key is truthy but unusable — the
    // pre-flight guard must short-circuit to the "add a key" note WITHOUT calling the provider.
    createAssistantPanel(makeOpts(container, { getApiKey: () => '   ' }));
    vi.mocked(runAssistant).mockClear();
    container.querySelector<HTMLButtonElement>('.koi-assistant-quick .koi-assistant-action')!.click();
    await settle();

    const reply = container.querySelector('.koi-msg-assistant:last-of-type');
    expect(reply?.textContent).toMatch(/add your api key in settings/i);
    expect(vi.mocked(runAssistant)).not.toHaveBeenCalled();
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
    // The grammar-capability verdict is cached per endpoint (module-level, #446) — clear it so each test
    // re-probes from scratch rather than inheriting a sibling test's verdict for the same baseUrl.
    resetGrammarCapabilityCache();
  });
  afterEach(() => {
    localStorage.clear();
    vi.mocked(runAssistant).mockReset();
    resetGrammarCapabilityCache();
  });

  const CLEAN = 'ok: true — no diagnostics. The model compiles.';
  const DIRTY = 'ok: false — 1 error(s), 0 warning(s):\n- [error] 1:1 boom';

  // The default mocked runAssistant streams a fenced koine block (a generative turn that offers Apply).
  // It also plays a grammar-HONOURING local backend: a probe request (one carrying the sentinel-only
  // GBNF, #446) gets the sentinel back, so `probeGrammarCapability` deems the endpoint capable and the
  // gbnf path is taken. The not-capable case uses `mockReplyIgnoresGrammar` below instead.
  function mockReply(body = 'Here is your model:\n```koine\ncontext X {}\n```'): void {
    vi.mocked(runAssistant).mockImplementation(async (req: { onText: (t: string) => void; grammar?: string }) => {
      if (req.grammar === GRAMMAR_PROBE_GBNF) return GRAMMAR_PROBE_SENTINEL; // probe → honoured
      req.onText(body);
      return body;
    });
  }

  // A local backend that IGNORES a top-level grammar (Ollama's OpenAI-compat endpoint): the probe gets
  // an unconstrained reply, never the sentinel, so the endpoint is judged not-capable (#446).
  function mockReplyIgnoresGrammar(body = 'Here is your model:\n```koine\ncontext X {}\n```'): void {
    vi.mocked(runAssistant).mockImplementation(async (req: { onText: (t: string) => void; grammar?: string }) => {
      if (req.grammar === GRAMMAR_PROBE_GBNF) return 'I will gladly help! Here is some unconstrained prose.';
      req.onText(body);
      return body;
    });
  }

  // The runAssistant request objects for actual generation/repair — i.e. NOT the capability probe (#446).
  // The probe adds one runAssistant call per capable-endpoint turn; filtering it out keeps the count
  // assertions about the generation + repair loop, independent of the probe.
  function genCalls(): { grammar?: string }[] {
    return vi
      .mocked(runAssistant)
      .mock.calls.map((c) => c[0] as { grammar?: string })
      .filter((a) => a.grammar !== GRAMMAR_PROBE_GBNF);
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
    // The endpoint was probed first with the sentinel-only grammar (#446) …
    expect(vi.mocked(runAssistant).mock.calls[0][0].grammar).toBe(GRAMMAR_PROBE_GBNF);
    // … then, the probe having confirmed the grammar is honoured, the REAL GBNF rode along on generation.
    expect(genCalls()[0].grammar).toBe('root ::= "x"');
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

  test('gbnf path: a constrained candidate that still fails validate degrades to parse-and-repair (#446)', async () => {
    // The probe confirmed the grammar is honoured, so the gbnf path is taken — but a GBNF only constrains
    // tokens, not full semantic validity, so the generated model can still fail `koine_validate`. Instead
    // of disabling Apply right there (strictly worse than parse-and-repair), the gbnf path must fall into
    // the SAME bounded repair loop the repair mechanism uses.
    mockReply();
    const container = document.createElement('div');
    createAssistantPanel(
      opts(container, {
        getGrammar: () => Promise.resolve('root ::= "x"'),
        runCompilerTool: () => Promise.resolve(DIRTY), // constrained output still doesn't fully parse
      }),
    );
    fire(container);

    await vi.waitFor(() => expect(container.querySelector('.koi-assistant-invalid')).not.toBeNull());
    // We did NOT stop after the single validate: the initial turn + one regenerate per repair round ran
    // (the capability probe is filtered out by `genCalls`).
    expect(genCalls().length).toBe(1 + MAX_REPAIR_ROUNDS);
    // The live "repair k/N" counter ticked to the cap …
    expect(container.querySelector('.koi-assistant-repair-counter')?.textContent).toBe(
      `repair ${MAX_REPAIR_ROUNDS}/${MAX_REPAIR_ROUNDS}`,
    );
    // … and the chip stops claiming a constraint that didn't hold — it degraded to parse-and-repair.
    expect(container.querySelector('.koi-assistant-chip')?.textContent).toBe('parse-and-repair');
    expect(container.querySelector('.koi-assistant-apply')).toBeNull();
  });

  test('gbnf path: a constrained candidate that repairs to valid enables Apply (degrade, then heal) (#446)', async () => {
    // Same gbnf path, but the first repair round produces a parseable model: Apply must end up enabled
    // (the gbnf path is never worse than parse-and-repair).
    mockReply();
    let n = 0;
    const container = document.createElement('div');
    createAssistantPanel(
      opts(container, {
        getGrammar: () => Promise.resolve('root ::= "x"'),
        runCompilerTool: () => Promise.resolve(n++ === 0 ? DIRTY : CLEAN),
      }),
    );
    fire(container);

    await vi.waitFor(() => expect(container.querySelector('.koi-assistant-apply')).not.toBeNull());
    expect(container.querySelector<HTMLButtonElement>('.koi-assistant-apply')!.disabled).toBe(false);
    expect(container.querySelector('.koi-assistant-repair-counter')?.textContent).toBe(`repair 1/${MAX_REPAIR_ROUNDS}`);
    expect(container.querySelector('.koi-assistant-chip')?.textContent).toBe('parse-and-repair');
  });

  test('probe: a loopback endpoint that IGNORES the grammar (Ollama) is judged not-capable — no chip lie (#446)', async () => {
    // The endpoint advertises as a grammar-capable local OpenAI server, but the probe reply doesn't honour
    // the sentinel grammar (Ollama uses its own `format`). So no GBNF is attached, the mechanism falls to
    // parse-and-repair, and the chip never claims "grammar-constrained".
    mockReplyIgnoresGrammar();
    const container = document.createElement('div');
    createAssistantPanel(
      opts(container, {
        getGrammar: () => Promise.resolve('root ::= "x"'),
        runCompilerTool: () => Promise.resolve(CLEAN),
      }),
    );
    fire(container);

    await vi.waitFor(() => expect(container.querySelector('.koi-assistant-apply')).not.toBeNull());
    // No GBNF rode along on the generation request — the probe withheld it.
    expect(genCalls().every((c) => c.grammar === undefined)).toBe(true);
    // The chip tells the truth: parse-and-repair, NOT a "grammar-constrained" badge over an ignored grammar.
    expect(container.querySelector('.koi-assistant-chip')?.textContent).toBe('parse-and-repair');
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

  // #447: the GBNF and the compiler tools are mutually exclusive at the decoder — a grammar that only
  // accepts `.koi` can't also emit the tool-call JSON the agentic loop needs. When the grammar is
  // EFFECTIVE for the turn (mechanism === 'gbnf'), grammar wins: the request must keep the grammar and
  // WITHHOLD the tools, never advertise tools the GBNF would silently render uncallable.
  test('both tools AND grammar on (gbnf turn): keeps the grammar, withholds the tools (grammar wins)', async () => {
    mockReply('context X {}');
    const container = document.createElement('div');
    const runCompilerTool = vi.fn(() => Promise.resolve(CLEAN));
    createAssistantPanel(
      opts(container, {
        getUseTools: () => true, // tools ON…
        getConstrainGrammar: () => true, // …and grammar ON, on a grammar-capable backend
        getGrammar: () => Promise.resolve('root ::= "x"'),
        runCompilerTool,
      }),
    );
    fire(container);

    // Wait for the GENERATION call (after the capability probe, #446), then inspect it.
    await vi.waitFor(() => expect(genCalls().length).toBeGreaterThan(0));
    const req = genCalls()[0] as { grammar?: string; runCompilerTool?: unknown };
    expect(req.grammar).toBe('root ::= "x"'); // grammar rode along
    expect(req.runCompilerTool).toBeUndefined(); // tools withheld — the GBNF can't call them
  });

  // The runtime guard is gated on the grammar being EFFECTIVE: on a non-capable backend the grammar
  // falls back to parse-and-repair (mechanism === 'repair'), the GBNF is never attached, so the tools
  // must still run (the existing behavior) rather than being needlessly withheld.
  test('both on but a NON-capable backend (repair turn): no grammar, tools still advertised', async () => {
    mockReply();
    const container = document.createElement('div');
    const runCompilerTool = vi.fn(() => Promise.resolve(CLEAN));
    createAssistantPanel(
      opts(container, {
        getProvider: () => 'anthropic',
        getBaseUrl: () => '',
        getUseTools: () => true,
        getConstrainGrammar: () => true,
        runCompilerTool,
      }),
    );
    fire(container);

    await vi.waitFor(() => expect(vi.mocked(runAssistant)).toHaveBeenCalled());
    const req = vi.mocked(runAssistant).mock.calls[0][0];
    expect(req.grammar).toBeUndefined(); // Anthropic can't be token-masked
    expect(req.runCompilerTool).toBe(runCompilerTool); // tools still run — grammar wasn't effective
  });
});

// --- multi-file change set (#... agentic edits): the per-file review/apply panel ----------------
describe('multi-file change set (agentic edits)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(runAssistant).mockReset();
  });
  afterEach(() => {
    localStorage.clear();
    vi.mocked(runAssistant).mockReset();
  });

  function opts(container: HTMLElement, over: Partial<AssistantPanelOptions> = {}): AssistantPanelOptions {
    return {
      container,
      getProvider: () => 'anthropic',
      getBaseUrl: () => '',
      getApiKey: () => 'sk',
      getModel: () => '',
      getContext: () => ({ fileName: 'm.koi', source: 'context X {}', diagnostics: [] }),
      onApplyModel: () => {},
      onOpenPrefs: () => {},
      getWorkspaceKey: () => 'ws',
      getSelection: () => null,
      getUseTools: () => true,
      getConstrainGrammar: () => false,
      ...over,
    };
  }

  // Drive a normal generative send via the first quick action (offerApply defaults true).
  function fire(container: HTMLElement): void {
    container.querySelector<HTMLButtonElement>('.koi-assistant-quick .koi-assistant-action')!.click();
  }

  test('renders a per-file review for a staged multi-file turn, Apply writes only accepted files', async () => {
    // The model stages two full-file edits into the per-turn session: one revising an existing file
    // (orders.koi, present in the workspace snapshot → "modified") and one brand-new (events.koi → "new").
    vi.mocked(runAssistant).mockImplementation(async (req: any) => {
      req.editSession?.stage('orders.koi', 'context Orders { /* edited */ }'); // modified (in initial)
      req.editSession?.stage('events.koi', 'integration event OrderPlaced {}'); // new (absent from snapshot)
      req.onText('Stationed two edits.');
      return 'Stationed two edits.';
    });

    const onApplyChangeSet = vi.fn(
      async (_files: { relPath: string; body: string; isNew: boolean }[]) => ({ failed: [] as string[] }),
    );
    const container = document.createElement('div');
    createAssistantPanel(
      opts(container, {
        getUseTools: () => true,
        getWorkspaceFiles: () => ({ 'orders.koi': 'context Orders {}' }),
        runEditTool: vi.fn(async () => 'ok'), // stub — the mock stages directly
        onApplyChangeSet,
      }),
    );
    fire(container);

    await vi.waitFor(() => expect(container.querySelector('.koi-changeset')).not.toBeNull());

    // Exactly two file rows, one badge of each kind, two checked accept boxes, apply labelled "2".
    const rows = container.querySelectorAll('.koi-changeset-file');
    expect(rows.length).toBe(2);
    expect(container.querySelectorAll('.koi-changeset-badge-modified').length).toBe(1);
    expect(container.querySelectorAll('.koi-changeset-badge-new').length).toBe(1);
    const checks = container.querySelectorAll<HTMLInputElement>('.koi-changeset-accept');
    expect(checks.length).toBe(2);
    expect([...checks].every((c) => c.checked)).toBe(true);
    const applyBtn = container.querySelector<HTMLButtonElement>('.koi-changeset-apply')!;
    expect(applyBtn.textContent).toContain('2');

    // Uncheck the events.koi (new) row → the apply label drops to "1".
    const eventsRow = [...rows].find((r) => r.textContent?.includes('events.koi'))!;
    const eventsCheck = eventsRow.querySelector<HTMLInputElement>('.koi-changeset-accept')!;
    eventsCheck.checked = false;
    eventsCheck.dispatchEvent(new Event('change'));
    expect(applyBtn.textContent).toContain('1');

    // Apply writes ONLY the still-accepted file (orders.koi).
    applyBtn.click();
    await vi.waitFor(() => expect(onApplyChangeSet).toHaveBeenCalledTimes(1));
    const accepted = onApplyChangeSet.mock.calls[0][0];
    expect(accepted.length).toBe(1);
    expect(accepted[0].relPath).toBe('orders.koi');
  });

  test('surfaces the end-of-turn validation diagnostics in the change set, before apply (issue #474)', async () => {
    // The model stages a BROKEN file; the agentic loop's single end-of-turn validation reports the
    // error via onStagedValidation. The change-set panel must show those diagnostics alongside the
    // staged file so a write that broke the model is visible BEFORE the user applies anything.
    const DIAG = 'ok: false — 1 error(s), 0 warning(s):\n- [error] 1:16 unexpected end of input';
    vi.mocked(runAssistant).mockImplementation(async (req: any) => {
      req.editSession?.stage('orders.koi', 'context Orders {'); // unbalanced — broken
      req.onStagedValidation?.(DIAG);
      req.onText('Staged one edit.');
      return 'Staged one edit.';
    });
    const container = document.createElement('div');
    createAssistantPanel(
      opts(container, {
        getUseTools: () => true,
        getWorkspaceFiles: () => ({ 'orders.koi': 'context Orders {}' }),
        runEditTool: vi.fn(async () => 'ok'),
        validateStaged: vi.fn(async () => DIAG),
        onApplyChangeSet: vi.fn(async () => ({ failed: [] as string[] })),
      }),
    );
    fire(container);

    await vi.waitFor(() => expect(container.querySelector('.koi-changeset')).not.toBeNull());
    // The staged file row is present...
    expect(container.querySelector('.koi-changeset-file')?.textContent).toContain('orders.koi');
    // ...and the end-of-turn diagnostics are rendered, pre-apply.
    const diag = container.querySelector('.koi-changeset-diagnostics');
    expect(diag).not.toBeNull();
    expect(diag?.textContent).toContain('1 error');
    expect(diag?.textContent).toContain('unexpected end of input');
  });

  test('a CLEAN end-of-turn validation shows the change set without a diagnostics block', async () => {
    vi.mocked(runAssistant).mockImplementation(async (req: any) => {
      req.editSession?.stage('orders.koi', 'context Orders { /* ok */ }');
      req.onStagedValidation?.('ok: true — no diagnostics. The model compiles.');
      req.onText('Staged one edit.');
      return 'Staged one edit.';
    });
    const container = document.createElement('div');
    createAssistantPanel(
      opts(container, {
        getUseTools: () => true,
        getWorkspaceFiles: () => ({ 'orders.koi': 'context Orders {}' }),
        runEditTool: vi.fn(async () => 'ok'),
        validateStaged: vi.fn(async () => 'ok: true — no diagnostics. The model compiles.'),
        onApplyChangeSet: vi.fn(async () => ({ failed: [] as string[] })),
      }),
    );
    fire(container);

    await vi.waitFor(() => expect(container.querySelector('.koi-changeset')).not.toBeNull());
    // No errors ⇒ no alarming diagnostics block (the clean `ok: true` summary isn't shown).
    expect(container.querySelector('.koi-changeset-diagnostics')).toBeNull();
  });

  test('a "could not validate" note (validation did not run) is surfaced in the change set', async () => {
    // When the end-of-turn validation could not run (e.g. desktop MCP sidecar unreachable), the panel
    // must show the note so the user knows the staged set was NOT validated before applying.
    const NOTE = 'ok: false — could not validate the staged workspace: MCP koine_validate failed: HTTP 503';
    vi.mocked(runAssistant).mockImplementation(async (req: any) => {
      req.editSession?.stage('orders.koi', 'context Orders {}');
      req.onStagedValidation?.(NOTE);
      req.onText('Staged one edit.');
      return 'Staged one edit.';
    });
    const container = document.createElement('div');
    createAssistantPanel(
      opts(container, {
        getUseTools: () => true,
        getWorkspaceFiles: () => ({ 'orders.koi': 'context Orders {}' }),
        runEditTool: vi.fn(async () => 'ok'),
        validateStaged: vi.fn(async () => NOTE),
        onApplyChangeSet: vi.fn(async () => ({ failed: [] as string[] })),
      }),
    );
    fire(container);

    await vi.waitFor(() => expect(container.querySelector('.koi-changeset')).not.toBeNull());
    const diag = container.querySelector('.koi-changeset-diagnostics');
    expect(diag).not.toBeNull();
    expect(diag?.textContent).toContain('could not validate');
  });

  test('a non-staged generative turn still shows single-file Apply (no change set)', async () => {
    // An ordinary generative reply (a fenced koine block, nothing staged) → the legacy single-file gate.
    vi.mocked(runAssistant).mockImplementation(async (req: any) => {
      const body = 'Here:\n```koine\ncontext X {}\n```';
      req.onText(body);
      return body;
    });
    const container = document.createElement('div');
    createAssistantPanel(
      opts(container, {
        getUseTools: () => true,
        getWorkspaceFiles: () => ({ 'orders.koi': 'context Orders {}' }),
        runEditTool: vi.fn(async () => 'ok'),
        onApplyChangeSet: vi.fn(async () => ({ failed: [] as string[] })),
      }),
    );
    fire(container);

    await vi.waitFor(() => expect(container.querySelector('.koi-assistant-apply')).not.toBeNull());
    expect(container.querySelector('.koi-changeset')).toBeNull();
  });

  test('a partial-apply failure is surfaced (no false "Applied ✓"), and a successful apply locks the review', async () => {
    vi.mocked(runAssistant).mockImplementation(async (req: any) => {
      req.editSession?.stage('orders.koi', 'context Orders { /* edited */ }');
      req.editSession?.stage('events.koi', 'integration event OrderPlaced {}');
      req.onText('Two edits.');
      return 'Two edits.';
    });
    // First apply fails to write events.koi; the panel must report it and NOT show a terminal "Applied ✓".
    const onApplyChangeSet = vi.fn(async (_files: { relPath: string; body: string; isNew: boolean }[]) => ({
      failed: ['events.koi'] as string[],
    }));
    const container = document.createElement('div');
    createAssistantPanel(
      opts(container, {
        getUseTools: () => true,
        getWorkspaceFiles: () => ({ 'orders.koi': 'context Orders {}' }),
        runEditTool: vi.fn(async () => 'ok'),
        onApplyChangeSet,
      }),
    );
    fire(container);

    await vi.waitFor(() => expect(container.querySelector('.koi-changeset-apply')).not.toBeNull());
    const applyBtn = container.querySelector<HTMLButtonElement>('.koi-changeset-apply')!;
    applyBtn.click();
    await vi.waitFor(() =>
      expect(container.querySelector('.koi-changeset-status')?.textContent).toContain('events.koi'),
    );
    // Discard is still present (the change set isn't terminal) and Apply re-opened for a retry.
    expect(container.querySelector('.koi-changeset-discard')).not.toBeNull();
    expect(applyBtn.textContent).not.toContain('✓');
    expect(applyBtn.disabled).toBe(false);
  });

  // #633: onApply can REJECT, not just resolve with { failed }. applyFileEdit only converts disk-write
  // errors into a { failed } return; an un-guarded throw from a non-disk op (renderer/LSP sync, dirty
  // refresh, saved-callback) escapes as a rejection. Without a .catch the Apply button is left stuck
  // disabled forever, the error is swallowed, and the rejection is unhandled. A rejected apply must
  // re-enable Apply and surface the error in the status live region.
  test('a REJECTED apply re-enables Apply and surfaces the error (no stuck-disabled button)', async () => {
    vi.mocked(runAssistant).mockImplementation(async (req: any) => {
      req.editSession?.stage('orders.koi', 'context Orders { /* edited */ }');
      req.editSession?.stage('events.koi', 'integration event OrderPlaced {}');
      req.onText('Two edits.');
      return 'Two edits.';
    });
    // The apply REJECTS (throws) rather than resolving with { failed } — an un-guarded throw mid-apply.
    const onApplyChangeSet = vi.fn(async (_files: { relPath: string; body: string; isNew: boolean }[]) => {
      throw new Error('setDoc blew up');
    });
    const container = document.createElement('div');
    createAssistantPanel(
      opts(container, {
        getUseTools: () => true,
        getWorkspaceFiles: () => ({ 'orders.koi': 'context Orders {}' }),
        runEditTool: vi.fn(async () => 'ok'),
        onApplyChangeSet,
      }),
    );
    fire(container);

    await vi.waitFor(() => expect(container.querySelector('.koi-changeset-apply')).not.toBeNull());
    const applyBtn = container.querySelector<HTMLButtonElement>('.koi-changeset-apply')!;
    applyBtn.click();

    // The rejection is surfaced in the polite live region (not swallowed)…
    await vi.waitFor(() =>
      expect(container.querySelector('.koi-changeset-status')?.textContent).toContain('setDoc blew up'),
    );
    // …and Apply is re-enabled (not stuck disabled), so the user can retry the still-checked set; the
    // panel is non-terminal (no "Applied ✓", Discard still present).
    expect(applyBtn.disabled).toBe(false);
    expect(applyBtn.textContent).not.toContain('✓');
    expect(container.querySelector('.koi-changeset-discard')).not.toBeNull();
  });

  // #473 (Task 1): a stale change-set panel from a prior turn must not stay clickable after a NEW send —
  // a late Apply on it would write stale full-file bodies wholesale over everything done since.
  test('a new send supersedes the prior un-applied change set (Apply + checkboxes disabled, superseded notice)', async () => {
    // Each turn stages a one-file change set.
    vi.mocked(runAssistant).mockImplementation(async (req: any) => {
      req.editSession?.stage('orders.koi', 'context Orders { /* edited */ }');
      req.onText('Edit.');
      return 'Edit.';
    });
    const container = document.createElement('div');
    createAssistantPanel(
      opts(container, {
        getUseTools: () => true,
        getWorkspaceFiles: () => ({ 'orders.koi': 'context Orders {}' }),
        runEditTool: vi.fn(async () => 'ok'),
        onApplyChangeSet: vi.fn(async () => ({ failed: [] as string[] })),
      }),
    );

    // First turn stages a change set; capture its (still-live) Apply button + accept checkboxes.
    fire(container);
    await vi.waitFor(() => expect(container.querySelector('.koi-changeset')).not.toBeNull());
    const firstPanel = container.querySelector('.koi-changeset')!;
    const firstApply = firstPanel.querySelector<HTMLButtonElement>('.koi-changeset-apply')!;
    const firstChecks = firstPanel.querySelectorAll<HTMLInputElement>('.koi-changeset-accept');
    expect(firstApply.disabled).toBe(false);
    expect([...firstChecks].some((c) => c.disabled)).toBe(false);

    // A second send begins → the prior panel is retired: Apply + every accept checkbox disabled and a
    // "superseded" notice in its status live region, so a late click can't clobber newer work.
    fire(container);
    await vi.waitFor(() => expect(container.querySelectorAll('.koi-changeset').length).toBe(2));

    expect(firstApply.disabled).toBe(true);
    expect([...firstChecks].every((c) => c.disabled)).toBe(true);
    expect(firstPanel.querySelector('.koi-changeset-status')?.textContent).toMatch(/superseded/i);
  });

  // Idempotency: invalidation must never overwrite an ALREADY-applied panel's terminal "Applied ✓".
  test('superseding an already-applied change set is a no-op (keeps "Applied ✓", no "superseded")', async () => {
    vi.mocked(runAssistant).mockImplementation(async (req: any) => {
      req.editSession?.stage('orders.koi', 'context Orders { /* edited */ }');
      req.onText('Edit.');
      return 'Edit.';
    });
    const container = document.createElement('div');
    createAssistantPanel(
      opts(container, {
        getUseTools: () => true,
        getWorkspaceFiles: () => ({ 'orders.koi': 'context Orders {}' }),
        runEditTool: vi.fn(async () => 'ok'),
        onApplyChangeSet: vi.fn(async () => ({ failed: [] as string[] })),
      }),
    );

    fire(container);
    await vi.waitFor(() => expect(container.querySelector('.koi-changeset')).not.toBeNull());
    const firstPanel = container.querySelector('.koi-changeset')!;
    const firstApply = firstPanel.querySelector<HTMLButtonElement>('.koi-changeset-apply')!;
    // Apply the first change set to terminal "Applied ✓".
    firstApply.click();
    await vi.waitFor(() => expect(firstApply.textContent).toContain('✓'));

    // A later send must NOT overwrite the applied panel's terminal status with a "superseded" notice.
    fire(container);
    await vi.waitFor(() => expect(container.querySelectorAll('.koi-changeset').length).toBe(2));
    expect(firstApply.textContent).toContain('✓');
    expect(firstPanel.querySelector('.koi-changeset-status')?.textContent).not.toMatch(/superseded/i);
  });

  // #684: the reverse of the "already-applied" guard above. A panel superseded WHILE its apply is in
  // flight must stay terminal — a late-settling FAILURE (reject from #633's .catch, or a { failed }
  // result from the partial-failure branch) must not call refreshApply() (re-enabling Apply on the
  // retired panel) nor overwrite the "superseded" notice with an "Apply failed" / "couldn't write" one.
  test('superseded mid-apply: a later REJECTED apply does not un-retire the panel (#684)', async () => {
    vi.mocked(runAssistant).mockImplementation(async (req: any) => {
      req.editSession?.stage('orders.koi', 'context Orders { /* edited */ }');
      req.onText('Edit.');
      return 'Edit.';
    });
    // A deferred apply we settle by hand, so the panel can be superseded WHILE the apply is in flight.
    let rejectApply!: (e: unknown) => void;
    const applyGate = new Promise<{ failed: string[] }>((_res, rej) => {
      rejectApply = rej;
    });
    const onApplyChangeSet = vi.fn(async () => applyGate);
    const container = document.createElement('div');
    createAssistantPanel(
      opts(container, {
        getUseTools: () => true,
        getWorkspaceFiles: () => ({ 'orders.koi': 'context Orders {}' }),
        runEditTool: vi.fn(async () => 'ok'),
        onApplyChangeSet,
      }),
    );

    // Turn 1 stages a change set; click Apply → onApply goes in flight (the deferred above).
    fire(container);
    await vi.waitFor(() => expect(container.querySelector('.koi-changeset')).not.toBeNull());
    const firstPanel = container.querySelector('.koi-changeset')!;
    const firstApply = firstPanel.querySelector<HTMLButtonElement>('.koi-changeset-apply')!;
    firstApply.click();
    await vi.waitFor(() => expect(onApplyChangeSet).toHaveBeenCalledTimes(1));
    expect(firstApply.disabled).toBe(true); // in-flight guard

    // A new send supersedes panel 1 WHILE its apply is still in flight.
    fire(container);
    await vi.waitFor(() => expect(container.querySelectorAll('.koi-changeset').length).toBe(2));
    expect(firstApply.disabled).toBe(true);
    expect(firstPanel.querySelector('.koi-changeset-status')?.textContent).toMatch(/superseded/i);

    // The in-flight apply now REJECTS. The retired panel must STAY terminal: no "Apply failed"
    // overwrite of the "superseded" notice, and Apply must NOT be re-enabled.
    rejectApply(new Error('setDoc blew up'));
    await new Promise((r) => setTimeout(r, 0)); // flush the rejection's .catch

    expect(firstApply.disabled).toBe(true);
    expect(firstPanel.querySelector('.koi-changeset-status')?.textContent).toMatch(/superseded/i);
    expect(firstPanel.querySelector('.koi-changeset-status')?.textContent).not.toMatch(/Apply failed/i);
  });

  test('superseded mid-apply: a later { failed } apply does not un-retire the panel (#684)', async () => {
    vi.mocked(runAssistant).mockImplementation(async (req: any) => {
      req.editSession?.stage('orders.koi', 'context Orders { /* edited */ }');
      req.onText('Edit.');
      return 'Edit.';
    });
    // A deferred apply we resolve by hand with a partial failure once the panel is already superseded.
    let resolveApply!: (v: { failed: string[] }) => void;
    const applyGate = new Promise<{ failed: string[] }>((res) => {
      resolveApply = res;
    });
    const onApplyChangeSet = vi.fn(async () => applyGate);
    const container = document.createElement('div');
    createAssistantPanel(
      opts(container, {
        getUseTools: () => true,
        getWorkspaceFiles: () => ({ 'orders.koi': 'context Orders {}' }),
        runEditTool: vi.fn(async () => 'ok'),
        onApplyChangeSet,
      }),
    );

    fire(container);
    await vi.waitFor(() => expect(container.querySelector('.koi-changeset')).not.toBeNull());
    const firstPanel = container.querySelector('.koi-changeset')!;
    const firstApply = firstPanel.querySelector<HTMLButtonElement>('.koi-changeset-apply')!;
    firstApply.click();
    await vi.waitFor(() => expect(onApplyChangeSet).toHaveBeenCalledTimes(1));

    // Supersede panel 1 while its apply is in flight.
    fire(container);
    await vi.waitFor(() => expect(container.querySelectorAll('.koi-changeset').length).toBe(2));
    expect(firstPanel.querySelector('.koi-changeset-status')?.textContent).toMatch(/superseded/i);

    // The in-flight apply settles as a partial failure. The retired panel stays terminal: no
    // "couldn't write …" overwrite, Apply not re-enabled.
    resolveApply({ failed: ['orders.koi'] });
    await new Promise((r) => setTimeout(r, 0)); // flush the .then

    expect(firstApply.disabled).toBe(true);
    expect(firstPanel.querySelector('.koi-changeset-status')?.textContent).toMatch(/superseded/i);
    expect(firstPanel.querySelector('.koi-changeset-status')?.textContent).not.toMatch(/couldn't write/i);
  });

  // #684: even a SUCCESSFUL in-flight apply that settles after a supersede must not present the retired
  // panel as the live applied set — the disk write is unavoidable once in flight, but the panel keeps
  // the "superseded" notice rather than flipping to a misleading "Applied ✓".
  test('superseded mid-apply: a later SUCCESSFUL apply still shows "superseded", not "Applied ✓" (#684)', async () => {
    vi.mocked(runAssistant).mockImplementation(async (req: any) => {
      req.editSession?.stage('orders.koi', 'context Orders { /* edited */ }');
      req.onText('Edit.');
      return 'Edit.';
    });
    let resolveApply!: (v: { failed: string[] }) => void;
    const applyGate = new Promise<{ failed: string[] }>((res) => {
      resolveApply = res;
    });
    const onApplyChangeSet = vi.fn(async () => applyGate);
    const container = document.createElement('div');
    createAssistantPanel(
      opts(container, {
        getUseTools: () => true,
        getWorkspaceFiles: () => ({ 'orders.koi': 'context Orders {}' }),
        runEditTool: vi.fn(async () => 'ok'),
        onApplyChangeSet,
      }),
    );

    fire(container);
    await vi.waitFor(() => expect(container.querySelector('.koi-changeset')).not.toBeNull());
    const firstPanel = container.querySelector('.koi-changeset')!;
    const firstApply = firstPanel.querySelector<HTMLButtonElement>('.koi-changeset-apply')!;
    firstApply.click();
    await vi.waitFor(() => expect(onApplyChangeSet).toHaveBeenCalledTimes(1));

    fire(container);
    await vi.waitFor(() => expect(container.querySelectorAll('.koi-changeset').length).toBe(2));
    expect(firstPanel.querySelector('.koi-changeset-status')?.textContent).toMatch(/superseded/i);

    // The in-flight apply succeeds AFTER the supersede. The retired panel keeps its "superseded"
    // status and Apply stays disabled — no terminal "Applied ✓" flip on a panel the user retired.
    resolveApply({ failed: [] });
    await new Promise((r) => setTimeout(r, 0)); // flush the .then

    expect(firstApply.disabled).toBe(true);
    expect(firstApply.textContent).not.toContain('✓');
    expect(firstPanel.querySelector('.koi-changeset-status')?.textContent).toMatch(/superseded/i);
  });

  // #473 (Task 2): a file edited between SEND and Apply (the staged body was computed against the OLD
  // text) must not be silently clobbered — detect the drift against a LIVE read, warn, and skip it,
  // while clean files still apply.
  test('drift: a file changed between send and apply is warned + skipped; clean files still apply', async () => {
    // The live workspace read; reassigned (not mutated) to simulate a concurrent edit after SEND.
    let ws: Record<string, string> = { 'orders.koi': 'context Orders {}', 'events.koi': 'context Events {}' };
    vi.mocked(runAssistant).mockImplementation(async (req: any) => {
      req.editSession?.stage('orders.koi', 'context Orders { /* a */ }');
      req.editSession?.stage('events.koi', 'context Events { /* b */ }');
      req.onText('Two edits.');
      return 'Two edits.';
    });
    const onApplyChangeSet = vi.fn(
      async (_files: { relPath: string; body: string; isNew: boolean }[]) => ({ failed: [] as string[] }),
    );
    const container = document.createElement('div');
    createAssistantPanel(
      opts(container, {
        getUseTools: () => true,
        getWorkspaceFiles: () => ws, // a LIVE read — currentText reflects concurrent edits at apply time
        runEditTool: vi.fn(async () => 'ok'),
        onApplyChangeSet,
      }),
    );
    fire(container);
    await vi.waitFor(() => expect(container.querySelector('.koi-changeset')).not.toBeNull());

    // Concurrent edit: the Domain Developer keeps typing in orders.koi while the turn ran — its live
    // text now differs from the snapshot the change set was staged against. events.koi is untouched.
    ws = { ...ws, 'orders.koi': 'context Orders { /* user typed this */ }' };

    const applyBtn = container.querySelector<HTMLButtonElement>('.koi-changeset-apply')!;
    applyBtn.click();
    await vi.waitFor(() => expect(onApplyChangeSet).toHaveBeenCalledTimes(1));

    // Only the clean file (events.koi) was written; the drifted one (orders.koi) was skipped.
    const written = onApplyChangeSet.mock.calls[0][0].map((f) => f.relPath);
    expect(written).toEqual(['events.koi']);

    // The drifted row carries a "changed since this was proposed" warning.
    const ordersRow = [...container.querySelectorAll('.koi-changeset-file')].find((r) =>
      r.textContent?.includes('orders.koi'),
    )!;
    expect(ordersRow.querySelector('.koi-changeset-drift')?.textContent).toMatch(/changed since/i);
    // …and the status live region announces the skip.
    expect(container.querySelector('.koi-changeset-status')?.textContent).toMatch(/changed since|skipped/i);
  });

  test('drift: every accepted file changed ⇒ nothing is written and Apply stays usable for a fresh review', async () => {
    let ws: Record<string, string> = { 'orders.koi': 'context Orders {}' };
    vi.mocked(runAssistant).mockImplementation(async (req: any) => {
      req.editSession?.stage('orders.koi', 'context Orders { /* staged */ }');
      req.onText('One edit.');
      return 'One edit.';
    });
    const onApplyChangeSet = vi.fn(async () => ({ failed: [] as string[] }));
    const container = document.createElement('div');
    createAssistantPanel(
      opts(container, {
        getUseTools: () => true,
        getWorkspaceFiles: () => ws,
        runEditTool: vi.fn(async () => 'ok'),
        onApplyChangeSet,
      }),
    );
    fire(container);
    await vi.waitFor(() => expect(container.querySelector('.koi-changeset')).not.toBeNull());

    // The only accepted file drifts.
    ws = { 'orders.koi': 'context Orders { /* user edit */ }' };
    const applyBtn = container.querySelector<HTMLButtonElement>('.koi-changeset-apply')!;
    applyBtn.click();
    await vi.waitFor(() =>
      expect(container.querySelector('.koi-changeset-status')?.textContent).toMatch(/changed since|nothing/i),
    );

    // Nothing was written, Apply is NOT stranded disabled, and the panel is still open (Discard present).
    expect(onApplyChangeSet).not.toHaveBeenCalled();
    expect(applyBtn.disabled).toBe(false);
    expect(applyBtn.textContent).not.toContain('✓');
    expect(container.querySelector('.koi-changeset-discard')).not.toBeNull();
  });

  test('drift edge: a new file whose path now EXISTS is treated as drift (not clobbered)', async () => {
    let ws: Record<string, string> = { 'orders.koi': 'context Orders {}' };
    vi.mocked(runAssistant).mockImplementation(async (req: any) => {
      req.editSession?.stage('events.koi', 'integration event OrderPlaced {}'); // NEW (absent at send)
      req.onText('New file.');
      return 'New file.';
    });
    const onApplyChangeSet = vi.fn(async () => ({ failed: [] as string[] }));
    const container = document.createElement('div');
    createAssistantPanel(
      opts(container, {
        getUseTools: () => true,
        getWorkspaceFiles: () => ws,
        runEditTool: vi.fn(async () => 'ok'),
        onApplyChangeSet,
      }),
    );
    fire(container);
    await vi.waitFor(() => expect(container.querySelector('.koi-changeset')).not.toBeNull());

    // A file appeared at events.koi since SEND (created by the user / another action) → presence = drift.
    ws = { ...ws, 'events.koi': 'context Events {}' };
    const applyBtn = container.querySelector<HTMLButtonElement>('.koi-changeset-apply')!;
    applyBtn.click();
    await vi.waitFor(() =>
      expect(container.querySelector('.koi-changeset-status')?.textContent).toMatch(/changed since|nothing/i),
    );
    expect(onApplyChangeSet).not.toHaveBeenCalled();
    const eventsRow = [...container.querySelectorAll('.koi-changeset-file')].find((r) =>
      r.textContent?.includes('events.koi'),
    )!;
    expect(eventsRow.querySelector('.koi-changeset-drift')).not.toBeNull();
  });

  // #473 (Task 3): both guards active on the same panel/turn driver. A new send supersedes the prior
  // panel (across-turn staleness) AND the still-live panel skips a file edited since SEND (within-turn
  // staleness) — the two guards cover disjoint windows and coexist.
  test('both guards together: a new send supersedes the first panel; the second skips a drifted file', async () => {
    let ws: Record<string, string> = { 'a.koi': 'context A {}', 'b.koi': 'context B {}' };
    let turn = 0;
    vi.mocked(runAssistant).mockImplementation(async (req: any) => {
      turn++;
      if (turn === 1) {
        req.editSession?.stage('a.koi', 'context A { /* t1 */ }');
      } else {
        req.editSession?.stage('a.koi', 'context A { /* t2 */ }');
        req.editSession?.stage('b.koi', 'context B { /* t2 */ }');
      }
      req.onText('staged');
      return 'staged';
    });
    const onApplyChangeSet = vi.fn(
      async (_files: { relPath: string; body: string; isNew: boolean }[]) => ({ failed: [] as string[] }),
    );
    const container = document.createElement('div');
    createAssistantPanel(
      opts(container, {
        getUseTools: () => true,
        getWorkspaceFiles: () => ws,
        runEditTool: vi.fn(async () => 'ok'),
        onApplyChangeSet,
      }),
    );

    // Turn 1 stages a change set.
    fire(container);
    await vi.waitFor(() => expect(container.querySelectorAll('.koi-changeset').length).toBe(1));
    const firstPanel = container.querySelector('.koi-changeset')!;
    const firstApply = firstPanel.querySelector<HTMLButtonElement>('.koi-changeset-apply')!;

    // Guard A (across-turn): a second send supersedes turn 1's panel.
    fire(container);
    await vi.waitFor(() => expect(container.querySelectorAll('.koi-changeset').length).toBe(2));
    expect(firstApply.disabled).toBe(true);
    expect(firstPanel.querySelector('.koi-changeset-status')?.textContent).toMatch(/superseded/i);

    // Guard B (within-turn): a concurrent edit drifts a.koi before turn 2's panel is applied.
    ws = { ...ws, 'a.koi': 'context A { /* user edit */ }' };
    const secondPanel = container.querySelectorAll('.koi-changeset')[1];
    const secondApply = secondPanel.querySelector<HTMLButtonElement>('.koi-changeset-apply')!;
    secondApply.click();
    await vi.waitFor(() => expect(onApplyChangeSet).toHaveBeenCalledTimes(1));

    // The drifted a.koi was skipped; only the clean b.koi was written.
    const written = onApplyChangeSet.mock.calls[0][0].map((f) => f.relPath);
    expect(written).toEqual(['b.koi']);
    const aRow = [...secondPanel.querySelectorAll('.koi-changeset-file')].find((r) => r.textContent?.includes('a.koi'))!;
    expect(aRow.querySelector('.koi-changeset-drift')).not.toBeNull();
  });
});

// --- apply-gate re-validation at the legacy entry points (#444) -------------------------------
// #423 gates the LIVE generation path: validate the `.koi` before enabling "Apply to editor". Two
// legacy entry points still reached `maybeOfferApply` WITHOUT re-validating — transcript replay
// (`replayMessage` trusted the stored `offerApply` flag) and stop-mid-stream (the abort handler
// committed the partial reply and offered Apply on it) — so a previously-rejected or truncated model
// could be applied after a reload or a Stop. Both must now re-run the SAME validate adapter the live
// path uses and offer Apply only when the model parses: fail closed when validation can't run, and
// keep the legacy unguarded affordance when the constraint toggle is off (the gate only claims the
// constrained contract).
describe('apply-gate re-validation at legacy entry points (#444)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(runAssistant).mockReset();
  });
  afterEach(() => {
    localStorage.clear();
    vi.mocked(runAssistant).mockReset();
  });

  const CLEAN = 'ok: true — no diagnostics. The model compiles.';
  const DIRTY = 'ok: false — 1 error(s), 0 warning(s):\n- [error] 1:1 boom';
  // A persisted GENERATIVE turn (a fenced `.koi` block, no apply opt-out).
  const MODEL_TURN = 'Here is your model:\n```koine\ncontext X {}\n```';

  async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
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

  // Seed a persisted generative turn under the panel's workspace key so a fresh mount replays it.
  function seedModelTurn(): void {
    saveChat('ws', [
      { role: 'user', content: 'design a model' },
      { role: 'assistant', content: MODEL_TURN },
    ]);
  }

  // Drive a generative send via the first quick action (offerApply defaults true).
  function fire(container: HTMLElement): void {
    container.querySelector<HTMLButtonElement>('.koi-assistant-quick .koi-assistant-action')!.click();
  }

  test('replay of a turn whose .koi is INVALID re-validates and withholds Apply', async () => {
    seedModelTurn();
    const runCompilerTool = vi.fn(() => Promise.resolve(DIRTY));
    const container = document.createElement('div');
    createAssistantPanel(opts(container, { runCompilerTool }));

    // The persisted turn replayed (its body rendered)…
    expect(container.querySelector('.koi-md')).not.toBeNull();
    // …and the gate RE-VALIDATED the stored `.koi` rather than trusting the stored flag…
    await vi.waitFor(() => expect(runCompilerTool).toHaveBeenCalled());
    await settle();
    // …and because it doesn't parse, Apply is withheld (the #444 replay bypass is closed).
    expect(container.querySelector('.koi-assistant-apply')).toBeNull();
  });

  test('replay of a turn whose .koi is VALID still offers Apply', async () => {
    seedModelTurn();
    const container = document.createElement('div');
    createAssistantPanel(opts(container, { runCompilerTool: () => Promise.resolve(CLEAN) }));

    await vi.waitFor(() => expect(container.querySelector('.koi-assistant-apply')).not.toBeNull());
  });

  test('constraint toggle OFF: replay keeps the legacy unguarded Apply, never consulting validate', async () => {
    seedModelTurn();
    const runCompilerTool = vi.fn(() => Promise.resolve(DIRTY));
    const container = document.createElement('div');
    // Toggle off → the gate makes no promises, so Apply is offered as it always was and the validate
    // adapter is never even consulted.
    createAssistantPanel(opts(container, { getConstrainGrammar: () => false, runCompilerTool }));

    await vi.waitFor(() => expect(container.querySelector('.koi-assistant-apply')).not.toBeNull());
    expect(runCompilerTool).not.toHaveBeenCalled();
  });

  test('constraint on but no validate seam: replay fails closed (no Apply)', async () => {
    seedModelTurn();
    const container = document.createElement('div');
    // runCompilerTool omitted → can't prove the model parses → withhold Apply.
    createAssistantPanel(opts(container));

    expect(container.querySelector('.koi-md')).not.toBeNull(); // replayed…
    await settle();
    expect(container.querySelector('.koi-assistant-apply')).toBeNull(); // …without Apply (fail closed)
  });

  // --- stop-mid-stream (the abort partial-commit path) ---------------------------------------
  // A Stop mid-generation commits the partial reply and offers Apply on it. A partial often holds a
  // TRUNCATED/invalid model, so the abort branch must clear the same gate the live path enforces.

  // Mock `runAssistant` to stream `body`, then have the user hit Stop (aborting the in-flight
  // request) before it finishes — exactly the stop-mid-stream sequence.
  function streamThenStop(container: HTMLElement, body: string): void {
    vi.mocked(runAssistant).mockImplementation(async (req: { onText: (t: string) => void }) => {
      req.onText(body);
      container.querySelector<HTMLButtonElement>('.koi-assistant-stop')!.click(); // user Stops
      throw new DOMException('aborted', 'AbortError'); // the fetch rejects on abort
    });
  }

  test('stop mid-stream with a truncated/invalid .koi: re-validates and withholds Apply', async () => {
    const runCompilerTool = vi.fn(() => Promise.resolve(DIRTY));
    const container = document.createElement('div');
    createAssistantPanel(opts(container, { runCompilerTool }));
    // A fenced block whose model is incomplete (unbalanced braces) — the kind a Stop leaves behind.
    streamThenStop(container, 'Working on it…\n```koine\ncontext X {\n```');
    fire(container);

    // The stop-partial branch ran (the "Stopped." note is shown)…
    await vi.waitFor(() => expect(container.querySelector('.koi-assistant-stopped')).not.toBeNull());
    // …and it RE-VALIDATED the partial rather than offering Apply blindly…
    await vi.waitFor(() => expect(runCompilerTool).toHaveBeenCalled());
    await settle();
    // …so the truncated model is NOT applicable (the #444 stop bypass is closed).
    expect(container.querySelector('.koi-assistant-apply')).toBeNull();
  });

  test('stop mid-stream with a VALID complete .koi still offers Apply', async () => {
    const container = document.createElement('div');
    createAssistantPanel(opts(container, { runCompilerTool: () => Promise.resolve(CLEAN) }));
    streamThenStop(container, 'Done early:\n```koine\ncontext X {}\n```');
    fire(container);

    await vi.waitFor(() => expect(container.querySelector('.koi-assistant-stopped')).not.toBeNull());
    await vi.waitFor(() => expect(container.querySelector('.koi-assistant-apply')).not.toBeNull());
  });
});

// --- bare grammar-constrained candidate recovery at the legacy entry points (#561) ------------
// #444 routed the two legacy entry points (transcript replay, stop-mid-stream) through the apply-gate
// so they can't offer Apply for a model that never passed validation — closing an OVER-offering bypass.
// But both still locate the candidate with `extractKoine()` ONLY, which returns null for an UNFENCED
// program. On the grammar-constrained (`gbnf`) path the GBNF root emits a BARE `.koi` program (no
// ```koine fence), and the live path recovers it with a `mechanism === 'gbnf'` fallback — so a valid
// bare model is applicable live but silently loses Apply on reload/Stop. This is the UNDER-offering
// mirror image: when there's no fence and the constraint toggle is on, `maybeOfferApply` must fall back
// to the trimmed body as the candidate and let the SAME `shouldOfferApply` gate decide (valid → Apply,
// prose → no Apply), without persisting any mechanism and without reopening the #444 bypass.
describe('bare grammar-constrained candidate recovery at legacy entry points (#561)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(runAssistant).mockReset();
  });
  afterEach(() => {
    localStorage.clear();
    vi.mocked(runAssistant).mockReset();
  });

  const CLEAN = 'ok: true — no diagnostics. The model compiles.';
  const DIRTY = 'ok: false — 1 error(s), 0 warning(s):\n- [error] 1:1 boom';
  // A genuinely grammar-constrained reply: a BARE `.koi` program with NO fence (the GBNF root can't
  // emit a ```koine fence), so `extractKoine()` returns null for it.
  const BARE_MODEL = 'context Billing {}';

  async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
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

  // Seed a persisted GENERATIVE turn whose assistant content is a BARE program (no fence, no opt-out)
  // so a fresh mount replays it through `maybeOfferApply`.
  function seedBareTurn(content: string = BARE_MODEL): void {
    saveChat('ws', [
      { role: 'user', content: 'design a model' },
      { role: 'assistant', content },
    ]);
  }

  // Drive a generative send via the first quick action (offerApply defaults true).
  function fire(container: HTMLElement): void {
    container.querySelector<HTMLButtonElement>('.koi-assistant-quick .koi-assistant-action')!.click();
  }

  // Mock `runAssistant` to stream `body`, then have the user hit Stop before it finishes — the
  // stop-mid-stream sequence whose partial is committed and routed through `maybeOfferApply`.
  function streamThenStop(container: HTMLElement, body: string): void {
    vi.mocked(runAssistant).mockImplementation(async (req: { onText: (t: string) => void }) => {
      req.onText(body);
      container.querySelector<HTMLButtonElement>('.koi-assistant-stop')!.click(); // user Stops
      throw new DOMException('aborted', 'AbortError'); // the fetch rejects on abort
    });
  }

  test('replay of a BARE valid grammar-constrained .koi (no fence) offers Apply', async () => {
    seedBareTurn();
    const container = document.createElement('div');
    // constraint ON + validate CLEAN: the bare program is recovered and passes the gate.
    createAssistantPanel(opts(container, { runCompilerTool: () => Promise.resolve(CLEAN) }));

    expect(container.querySelector('.koi-md')).not.toBeNull(); // replayed…
    await vi.waitFor(() => expect(container.querySelector('.koi-assistant-apply')).not.toBeNull());
  });

  test('replay of a BARE INVALID grammar-constrained .koi (no fence) withholds Apply', async () => {
    seedBareTurn();
    const runCompilerTool = vi.fn(() => Promise.resolve(DIRTY));
    const container = document.createElement('div');
    createAssistantPanel(opts(container, { runCompilerTool }));

    expect(container.querySelector('.koi-md')).not.toBeNull(); // replayed…
    // The recovered candidate is gated: it doesn't parse → Apply withheld (#444 bypass stays closed).
    await vi.waitFor(() => expect(runCompilerTool).toHaveBeenCalled());
    await settle();
    expect(container.querySelector('.koi-assistant-apply')).toBeNull();
  });

  test('constraint OFF: replay of a bare program stays fenced-only (no Apply, never validates)', async () => {
    seedBareTurn();
    const runCompilerTool = vi.fn(() => Promise.resolve(CLEAN));
    const container = document.createElement('div');
    // Toggle off → the bare-program fallback does NOT engage (today's "off ⇒ fenced-only" behavior),
    // so an unfenced body yields no candidate and the validate adapter is never consulted.
    createAssistantPanel(opts(container, { getConstrainGrammar: () => false, runCompilerTool }));

    expect(container.querySelector('.koi-md')).not.toBeNull(); // replayed…
    await settle();
    expect(container.querySelector('.koi-assistant-apply')).toBeNull();
    expect(runCompilerTool).not.toHaveBeenCalled();
  });

  test('replay of prose (no fence, constraint on) withholds Apply', async () => {
    seedBareTurn('Sure — a billing context tracks invoices and payments.');
    const runCompilerTool = vi.fn(() => Promise.resolve(DIRTY)); // prose doesn't parse
    const container = document.createElement('div');
    createAssistantPanel(opts(container, { runCompilerTool }));

    expect(container.querySelector('.koi-md')).not.toBeNull(); // replayed…
    await settle();
    // The prose is gated like any candidate and rejected — Apply withheld (no spurious offer).
    expect(container.querySelector('.koi-assistant-apply')).toBeNull();
  });

  // --- stop-mid-stream (the abort partial-commit path) ---------------------------------------
  // A Stop mid-generation commits the partial reply and offers Apply on it via the SAME
  // `maybeOfferApply` sink. When the streamed partial is a complete BARE grammar-constrained program
  // (no fence), the candidate must be recovered there too, so a valid model stays applicable after Stop.
  test('stop mid-stream with a complete BARE valid .koi (no fence) offers Apply', async () => {
    const container = document.createElement('div');
    createAssistantPanel(opts(container, { runCompilerTool: () => Promise.resolve(CLEAN) }));
    // A fully-streamed bare grammar-constrained program, then a Stop on the in-flight request.
    streamThenStop(container, BARE_MODEL);
    fire(container);

    await vi.waitFor(() => expect(container.querySelector('.koi-assistant-stopped')).not.toBeNull());
    await vi.waitFor(() => expect(container.querySelector('.koi-assistant-apply')).not.toBeNull());
  });
});
