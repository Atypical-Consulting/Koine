import { describe, expect, test } from 'vitest';
import {
  buildExplainPrompt,
  buildRepairPrompt,
  buildSystem,
  formatDomainIndex,
  type AssistantContext,
  type DomainIndex,
} from '@/ai/aiPrompts';

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

describe('buildRepairPrompt', () => {
  test('feeds the previous model AND the line:column diagnostics back, asking for ONLY a koine block', () => {
    const out = buildRepairPrompt('context X {', 'ok: false — 1 error(s):\n- [error] 1:11 expected }');
    expect(out).toContain('does not parse');
    expect(out.toLowerCase()).toContain('only');
    expect(out).toContain('```koine\ncontext X {\n```'); // the previous candidate, fenced
    expect(out).toContain('- [error] 1:11 expected }'); // the diagnostics verbatim
  });
});
