import { describe, expect, test } from 'vitest';
import {
  KOINE_TOOLS,
  KOINE_TOOL_DEFS,
  KOINE_TOOL_NAMES,
  COMPILE_TARGETS,
  toOpenAiTool,
  toAnthropicTool,
  formatValidate,
  formatCompile,
  summarizeForChip,
} from '@/ai/assistantTools';

describe('KOINE_TOOLS definitions', () => {
  test('advertises exactly validate/compile/format as OpenAI function tools', () => {
    const names = KOINE_TOOLS.map((t) => t.function.name).sort();
    expect(names).toEqual(['koine_compile', 'koine_format', 'koine_validate']);
    expect([...KOINE_TOOL_NAMES].sort()).toEqual(names);
  });

  test('every tool requires a source string and has a non-empty description', () => {
    for (const t of KOINE_TOOLS) {
      expect(t.type).toBe('function');
      expect(t.function.description && t.function.description.length).toBeGreaterThan(0);
      const params = t.function.parameters as { required?: string[]; properties: Record<string, unknown> };
      expect(params.required).toContain('source');
      expect(params.properties.source).toBeTruthy();
    }
  });

  test('compile restricts target to the WASM-backed targets only', () => {
    const compile = KOINE_TOOLS.find((t) => t.function.name === 'koine_compile')!;
    const params = compile.function.parameters as { properties: { target: { enum: string[] } } };
    expect(params.properties.target.enum).toEqual([...COMPILE_TARGETS]);
    // glossary/docs are NOT valid EmitPreview targets — they must not be advertised.
    expect(params.properties.target.enum).not.toContain('glossary');
    expect(params.properties.target.enum).not.toContain('docs');
  });
});

describe('neutral tool defs + adapters', () => {
  test('KOINE_TOOL_DEFS has exactly validate/compile/format, each source-required', () => {
    const names = KOINE_TOOL_DEFS.map((d) => d.name).sort();
    expect(names).toEqual(['koine_compile', 'koine_format', 'koine_validate']);
    for (const def of KOINE_TOOL_DEFS) {
      expect(def.description.length).toBeGreaterThan(0);
      const schema = def.inputSchema as { required?: string[]; properties: Record<string, unknown> };
      expect(typeof def.inputSchema).toBe('object');
      expect(schema.required).toContain('source');
      expect(schema.properties.source).toBeTruthy();
    }
  });

  test('toOpenAiTool wraps a def as an OpenAI function tool; KOINE_TOOLS is the derived view', () => {
    const def = KOINE_TOOL_DEFS[0];
    const tool = toOpenAiTool(def);
    expect(tool).toEqual({
      type: 'function',
      function: { name: def.name, description: def.description, parameters: def.inputSchema },
    });
    expect(KOINE_TOOLS).toEqual(KOINE_TOOL_DEFS.map(toOpenAiTool));
  });

  test('toAnthropicTool maps a def 1:1, sharing the neutral inputSchema reference', () => {
    const def = KOINE_TOOL_DEFS[0];
    const tool = toAnthropicTool(def);
    expect(tool).toEqual({ name: def.name, description: def.description, input_schema: def.inputSchema });
    expect(tool.input_schema).toBe(def.inputSchema); // referential, no schema rewrite
  });
});

describe('formatValidate', () => {
  test('reports ok when there are no diagnostics', () => {
    const out = formatValidate([{ uri: 'file:///model.koi', diagnostics: [] }]);
    expect(out).toContain('ok: true');
    expect(out.toLowerCase()).toContain('no diagnostics');
  });

  test('lists errors with 1-based line:col and an ok:false header', () => {
    const out = formatValidate([
      {
        uri: 'file:///model.koi',
        diagnostics: [
          { range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } }, severity: 1, code: 'K1', message: 'unknown type Mony' },
          { range: { start: { line: 5, character: 0 }, end: { line: 5, character: 3 } }, severity: 2, code: null, message: 'unused value' },
        ],
      },
    ]);
    expect(out).toContain('ok: false');
    expect(out).toContain('1 error');
    expect(out).toContain('1 warning');
    expect(out).toContain('3:5'); // 0-based 2:4 -> 1-based 3:5
    expect(out).toContain('unknown type Mony');
  });
});

describe('formatCompile', () => {
  test('returns the emitted files on success', () => {
    const out = formatCompile({
      target: 'csharp',
      files: [{ path: 'Money.cs', contents: 'public readonly record struct Money;' }],
      diagnostics: [],
      error: null,
    });
    expect(out).toContain('csharp');
    expect(out).toContain('Money.cs');
    expect(out).toContain('record struct Money');
  });

  test('surfaces a hard error', () => {
    const out = formatCompile({ target: 'typescript', files: [], diagnostics: [], error: 'unknown target' });
    expect(out.toLowerCase()).toContain('fail');
    expect(out).toContain('unknown target');
  });

  test('surfaces compile-blocking diagnostics instead of files', () => {
    const out = formatCompile({
      target: 'csharp',
      files: [],
      diagnostics: [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, code: 'E', message: 'syntax error' },
      ],
      error: null,
    });
    expect(out.toLowerCase()).toContain('fail');
    expect(out).toContain('syntax error');
  });
});

describe('summarizeForChip', () => {
  test('produces a short single-line status', () => {
    const s = summarizeForChip('koine_validate', 'ok: false — 2 error(s), 0 warning(s):\n- [error] 1:1 boom');
    expect(s).not.toContain('\n');
    expect(s.length).toBeLessThanOrEqual(90);
    expect(s).toContain('2 error');
  });
});
