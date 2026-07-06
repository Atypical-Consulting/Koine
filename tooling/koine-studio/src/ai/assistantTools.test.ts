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
  formatMcpValidate,
  normalizeMcpValidate,
  formatCompile,
  formatListFiles,
  formatReadFile,
  formatWriteFile,
  runEditToolStaging,
  summarizeForChip,
} from '@/ai/assistantTools';
import { createEditSession } from '@/ai/editSession';

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

describe('formatMcpValidate', () => {
  test('a clean MCP payload maps byte-for-byte to the browser ok:true string', () => {
    // The desktop koine_validate (MCP ValidateTool) payload must normalize to EXACTLY what the browser
    // formatValidate emits, so a single parseValidationOutcome reads either host (issue #445).
    const out = formatMcpValidate({ ok: true, errorCount: 0, warningCount: 0, diagnostics: [] });
    expect(out).toBe(formatValidate([{ uri: 'file:///model.koi', diagnostics: [] }]));
    expect(out).toBe('ok: true — no diagnostics. The model compiles.');
  });

  test('an error payload maps to the ok:false header with already-1-based line:col lines', () => {
    const out = formatMcpValidate({
      ok: false,
      errorCount: 1,
      warningCount: 1,
      // MCP DiagnosticInfo: string severity, 1-based line/column (NOT remapped, unlike the browser path).
      diagnostics: [
        { severity: 'error', code: 'KOI0201', message: 'unknown type Mony', line: 3, column: 5, endLine: 3, endColumn: 9, file: 'model.koi' },
        { severity: 'warning', code: 'KOI0500', message: 'unused value', line: 6, column: 1, endLine: 6, endColumn: 4, file: 'model.koi' },
      ],
    });
    expect(out).toBe(
      'ok: false — 1 error(s), 1 warning(s):\n- [error] 3:5 unknown type Mony\n- [warning] 6:1 unused value',
    );
  });

  test('a warnings-only payload keeps an ok:false header but reports 0 errors (so it stays applicable)', () => {
    const out = formatMcpValidate({
      ok: true,
      errorCount: 0,
      warningCount: 1,
      diagnostics: [{ severity: 'warning', code: 'KOI0500', message: 'unused value', line: 6, column: 1, endLine: 6, endColumn: 4, file: 'model.koi' }],
    });
    expect(out).toBe('ok: false — 0 error(s), 1 warning(s):\n- [warning] 6:1 unused value');
  });
});

describe('normalizeMcpValidate', () => {
  test('parses the raw MCP JSON into the browser ok: string', () => {
    const raw = JSON.stringify({ ok: true, errorCount: 0, warningCount: 0, diagnostics: [] });
    expect(normalizeMcpValidate(raw)).toBe('ok: true — no diagnostics. The model compiles.');
  });

  test('fails closed on non-JSON text (returns it unchanged → not-parsing)', () => {
    const err = 'Error: the Koine MCP server is not available.';
    expect(normalizeMcpValidate(err)).toBe(err);
  });

  test('fails closed on a JSON value of an unexpected shape', () => {
    expect(normalizeMcpValidate('{"unexpected":true}')).toBe('{"unexpected":true}');
    expect(normalizeMcpValidate('42')).toBe('42');
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

describe('runEditToolStaging — stage-only dispatch (issue #474)', () => {
  test('koine_write_file stages the file and returns ONLY the staged confirmation (no per-write validation)', async () => {
    const session = createEditSession({});
    const result = await runEditToolStaging(
      'koine_write_file',
      JSON.stringify({ relPath: 'orders.koi', contents: 'context Orders {}' }),
      session,
    );
    // The body is staged...
    expect(session.staged()).toEqual([
      { key: 'orders.koi', relPath: 'orders.koi', body: 'context Orders {}', isNew: true },
    ]);
    // ...and the result is EXACTLY the formatWriteFile confirmation — no appended `ok:` diagnostics. The
    // whole-staged-workspace validation moved to a single end-of-turn pass (no O(M×N) per-write compile).
    expect(result).toBe(formatWriteFile('orders.koi', true));
    expect(result).not.toContain('ok:');
  });

  test('two consecutive koine_write_file calls stage both files, neither validates', async () => {
    const session = createEditSession({ 'a.koi': 'context A {}' });
    const r1 = await runEditToolStaging(
      'koine_write_file',
      JSON.stringify({ relPath: 'a.koi', contents: 'context A { /* v2 */ }' }),
      session,
    );
    const r2 = await runEditToolStaging(
      'koine_write_file',
      JSON.stringify({ relPath: 'b.koi', contents: 'context B {}' }),
      session,
    );
    expect(session.staged()).toEqual([
      { key: 'a.koi', relPath: 'a.koi', body: 'context A { /* v2 */ }', isNew: false },
      { key: 'b.koi', relPath: 'b.koi', body: 'context B {}', isNew: true },
    ]);
    expect(r1).toBe(formatWriteFile('a.koi', false));
    expect(r2).toBe(formatWriteFile('b.koi', true));
    expect(r1).not.toContain('ok:');
    expect(r2).not.toContain('ok:');
  });

  test('list / read / unknown / bad-JSON / unsafe-relPath dispatch is preserved by the stage-only refactor', async () => {
    const session = createEditSession({ 'a.koi': 'context A {}' });
    expect(await runEditToolStaging('koine_list_files', '{}', session)).toContain('a.koi');
    expect(await runEditToolStaging('koine_read_file', JSON.stringify({ relPath: 'a.koi' }), session)).toContain(
      'context A {}',
    );
    expect(
      await runEditToolStaging('koine_read_file', JSON.stringify({ relPath: 'missing.koi' }), session),
    ).toContain('not found');
    expect(await runEditToolStaging('frobnicate', '{}', session)).toContain('unknown tool');
    expect(await runEditToolStaging('koine_write_file', 'not json', session)).toContain('not valid JSON');
    // The session's stage guard rejects an out-of-workspace path; the dispatcher surfaces it as an Error.
    expect(
      await runEditToolStaging('koine_write_file', JSON.stringify({ relPath: '../escape.koi', contents: 'x' }), session),
    ).toContain('Unsafe');
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
