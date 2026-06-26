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

    await vi.waitFor(() => expect(vi.mocked(runAssistant)).toHaveBeenCalled());
    const req = vi.mocked(runAssistant).mock.calls[0][0];
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
});
