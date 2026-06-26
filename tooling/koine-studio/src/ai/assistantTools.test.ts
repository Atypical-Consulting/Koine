import { describe, expect, test } from 'vitest';
import {
  koineTools,
  koineToolDefs,
  KOINE_TOOL_NAMES,
  KOINE_COMPILER_TOOL_NAMES,
  KOINE_EDIT_TOOL_NAMES,
  compileTargets,
  toOpenAiTool,
  toAnthropicTool,
  formatValidate,
  formatCompile,
  formatListFiles,
  formatReadFile,
  formatWriteFile,
  summarizeForChip,
} from '@/ai/assistantTools';

const ALL_SIX = [
  'koine_compile',
  'koine_format',
  'koine_list_files',
  'koine_read_file',
  'koine_validate',
  'koine_write_file',
];
const isCompilerTool = (name: string) => (KOINE_COMPILER_TOOL_NAMES as readonly string[]).includes(name);

describe('koineTools() definitions', () => {
  test('advertises all six compiler+edit tools as OpenAI function tools', () => {
    const names = koineTools().map((t) => t.function.name).sort();
    expect(names).toEqual(ALL_SIX);
    expect([...KOINE_TOOL_NAMES].sort()).toEqual(names);
  });

  test('every COMPILER tool requires a source string and has a non-empty description', () => {
    for (const t of koineTools().filter((t) => isCompilerTool(t.function.name))) {
      expect(t.type).toBe('function');
      expect(t.function.description && t.function.description.length).toBeGreaterThan(0);
      const params = t.function.parameters as { required?: string[]; properties: Record<string, unknown> };
      expect(params.required).toContain('source');
      expect(params.properties.source).toBeTruthy();
    }
  });

  test('compile restricts target to the WASM-backed targets only', () => {
    const compile = koineTools().find((t) => t.function.name === 'koine_compile')!;
    const params = compile.function.parameters as { properties: { target: { enum: string[] } } };
    expect(params.properties.target.enum).toEqual(compileTargets());
    // glossary/docs are NOT valid EmitPreview targets — they must not be advertised.
    expect(params.properties.target.enum).not.toContain('glossary');
    expect(params.properties.target.enum).not.toContain('docs');
  });
});

describe('neutral tool defs + adapters', () => {
  test('koineToolDefs() advertises all six tools; the compiler tools are source-required', () => {
    const names = koineToolDefs().map((d) => d.name).sort();
    expect(names).toEqual(ALL_SIX);
    for (const def of koineToolDefs().filter((d) => isCompilerTool(d.name))) {
      expect(def.description.length).toBeGreaterThan(0);
      const schema = def.inputSchema as { required?: string[]; properties: Record<string, unknown> };
      expect(typeof def.inputSchema).toBe('object');
      expect(schema.required).toContain('source');
      expect(schema.properties.source).toBeTruthy();
    }
  });

  test('toOpenAiTool wraps a def as an OpenAI function tool; koineTools() is the derived view', () => {
    const def = koineToolDefs()[0];
    const tool = toOpenAiTool(def);
    expect(tool).toEqual({
      type: 'function',
      function: { name: def.name, description: def.description, parameters: def.inputSchema },
    });
    expect(koineTools()).toEqual(koineToolDefs().map(toOpenAiTool));
  });

  test('toAnthropicTool maps a def 1:1, sharing the neutral inputSchema reference', () => {
    const def = koineToolDefs()[0];
    const tool = toAnthropicTool(def);
    expect(tool).toEqual({ name: def.name, description: def.description, input_schema: def.inputSchema });
    expect(tool.input_schema).toBe(def.inputSchema); // referential, no schema rewrite
  });
});

describe('edit tool defs (list/read/write)', () => {
  const byName = (name: string) => koineToolDefs().find((d) => d.name === name)!;

  test('koineToolDefs() includes the three edit tools with additionalProperties:false', () => {
    for (const name of KOINE_EDIT_TOOL_NAMES) {
      const def = byName(name);
      expect(def).toBeTruthy();
      expect(def.description.length).toBeGreaterThan(0);
      const schema = def.inputSchema as { additionalProperties?: boolean };
      expect(schema.additionalProperties).toBe(false);
    }
  });

  test('koine_list_files takes no args (no required, empty properties)', () => {
    const schema = byName('koine_list_files').inputSchema as {
      required?: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toBeUndefined();
    expect(schema.properties).toEqual({});
  });

  test('koine_read_file requires relPath', () => {
    const schema = byName('koine_read_file').inputSchema as {
      required?: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(['relPath']);
    expect(schema.properties.relPath).toBeTruthy();
  });

  test('koine_write_file requires relPath and contents', () => {
    const schema = byName('koine_write_file').inputSchema as {
      required?: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(['relPath', 'contents']);
    expect(schema.properties.relPath).toBeTruthy();
    expect(schema.properties.contents).toBeTruthy();
  });

  test('koineTools() advertises the edit tools to OpenAI too', () => {
    const names = koineTools().map((t) => t.function.name);
    for (const name of KOINE_EDIT_TOOL_NAMES) expect(names).toContain(name);
  });

  test('edit defs round-trip through both provider adapters, sharing the schema reference', () => {
    for (const name of KOINE_EDIT_TOOL_NAMES) {
      const def = byName(name);
      // OpenAI: schema lands in function.parameters
      expect(toOpenAiTool(def).function.parameters).toBe(def.inputSchema);
      // Anthropic: schema lands in input_schema, by reference
      const anth = toAnthropicTool(def);
      expect(anth.input_schema).toBe(def.inputSchema);
    }
  });
});

describe('formatListFiles', () => {
  test('says there are no files when empty', () => {
    expect(formatListFiles([]).toLowerCase()).toContain('no .koi files');
  });

  test('lists each workspace-relative path with a count when non-empty', () => {
    const out = formatListFiles(['a.koi', 'b/c.koi']);
    expect(out).toContain('2 file');
    expect(out).toContain('a.koi');
    expect(out).toContain('b/c.koi');
  });
});

describe('formatReadFile', () => {
  test('renders a not-found line when contents is null', () => {
    const out = formatReadFile('x.koi', null);
    expect(out.toLowerCase()).toContain('not found');
    expect(out).toContain('x.koi');
  });

  test('includes the file body when present', () => {
    const out = formatReadFile('x.koi', 'context X {}');
    expect(out).toContain('x.koi');
    expect(out).toContain('context X {}');
  });
});

describe('formatWriteFile', () => {
  test('reads as a NEW staged file that is not yet on disk', () => {
    const out = formatWriteFile('x.koi', true);
    expect(out.toLowerCase()).toContain('new');
    expect(out).toContain('x.koi');
    expect(out.toLowerCase()).toContain('not yet written to disk');
  });

  test('reads as staged changes to an existing file, not yet on disk', () => {
    const out = formatWriteFile('x.koi', false);
    expect(out.toLowerCase()).toContain('staged');
    expect(out).toContain('x.koi');
    expect(out.toLowerCase()).toContain('not yet written to disk');
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
