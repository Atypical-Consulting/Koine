// The Koine compiler tools the Assistant advertises to an OpenAI-compatible model (LM Studio, …) so
// it can validate/compile/format `.koi` source mid-conversation. The DEFINITIONS live here (the loop
// in ai.ts advertises them; the host in src/host executes them in-process); the result FORMATTERS are
// pure functions over the Koine.Wasm JSON shapes so they can be unit-tested and reused across hosts.
//
// Mirrors src/Koine.Mcp/Tools/{Validate,Compile,Format}Tool.cs — the same capabilities the external
// MCP server exposes, but executed by the IDE itself. `reference`/`examples` are intentionally NOT
// here: their content is already injected into the system prompt (KOINE_PRIMER + live source).
import type { ChatCompletionFunctionTool } from 'openai/resources/chat/completions';

/** The compile targets the in-WASM EmitPreview accepts (glossary/docs go through other exports). */
export const COMPILE_TARGETS = ['csharp', 'typescript', 'python', 'php', 'rust'] as const;
export type CompileTarget = (typeof COMPILE_TARGETS)[number];

/** Coerce an arbitrary `target` arg to a supported compile target, defaulting to csharp. */
export function normalizeCompileTarget(target: unknown): CompileTarget {
  return COMPILE_TARGETS.includes(target as CompileTarget) ? (target as CompileTarget) : 'csharp';
}

/** The tool names advertised to the model — identical to the MCP server's, so a future desktop
 *  MCP-backed executor can dispatch by the same name. */
export const KOINE_TOOL_NAMES = ['koine_validate', 'koine_compile', 'koine_format'] as const;
export type KoineToolName = (typeof KOINE_TOOL_NAMES)[number];

const SOURCE_PROP = {
  type: 'string',
  description: 'The complete Koine (.koi) model source.',
} as const;

/** A provider-neutral tool definition. `inputSchema` is a JSON Schema object; the adapters below
 *  re-shape it into the OpenAI (`parameters`) / Anthropic (`input_schema`) envelopes verbatim. */
export interface NeutralTool {
  name: string;
  description: string;
  inputSchema: object;
}

/** The koine tools, target- and provider-agnostic. Single-file `source` arg (the host wraps it into
 *  the compiler's multi-file envelope). Descriptions mirror the MCP tool `[Description]` strings. */
export const KOINE_TOOL_DEFS: NeutralTool[] = [
  {
    name: 'koine_validate',
    description:
      'Validate Koine (.koi) source and return diagnostics (errors and warnings with line:column). ' +
      'Use this to check a model you are drafting; keep fixing the source and re-validating until it reports ok.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { source: SOURCE_PROP },
      required: ['source'],
    },
  },
  {
    name: 'koine_compile',
    description:
      'Compile Koine (.koi) source to a target language and return the generated files (or compile errors). ' +
      'Use this to inspect the emitted code for a model.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        source: SOURCE_PROP,
        target: {
          type: 'string',
          enum: [...COMPILE_TARGETS],
          description: 'The target language to emit. Defaults to csharp.',
        },
      },
      required: ['source'],
    },
  },
  {
    name: 'koine_format',
    description: 'Return the canonically-formatted version of Koine (.koi) source.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { source: SOURCE_PROP },
      required: ['source'],
    },
  },
];

/** Adapt a neutral def to an OpenAI function tool (`parameters` carries the JSON Schema). The cast
 *  bridges the neutral `object` schema to OpenAI's `FunctionParameters` (an indexed record). */
export function toOpenAiTool(t: NeutralTool): ChatCompletionFunctionTool {
  return {
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Record<string, unknown>,
    },
  };
}

/** Adapt a neutral def to an Anthropic tool (`input_schema` carries the JSON Schema). The schema is
 *  passed through by reference — Anthropic's `input_schema` is the same JSON Schema, no rewrite. */
export function toAnthropicTool(t: NeutralTool): { name: string; description: string; input_schema: object } {
  return { name: t.name, description: t.description, input_schema: t.inputSchema };
}

/** The OpenAI `tools` array, derived from the neutral defs. */
export const KOINE_TOOLS: ChatCompletionFunctionTool[] = KOINE_TOOL_DEFS.map(toOpenAiTool);

// --- Koine.Wasm JSON shapes (camelCase, see src/Koine.Wasm/CompilerInterop.LanguageService.cs) -----

interface WPosition {
  line: number;
  character: number;
}
interface WRange {
  start: WPosition;
  end: WPosition;
}
/** LSP diagnostic: severity 1=Error 2=Warning 3=Info 4=Hint; lines are 0-based. */
export interface WDiagnostic {
  range: WRange;
  severity: number;
  code?: string | null;
  message: string;
}
/** One `{uri, diagnostics}` bucket as returned by DiagnoseWorkspace. */
export interface WFileDiagnostics {
  uri: string;
  diagnostics: WDiagnostic[];
}
/** One emitted file as returned by EmitPreview. */
export interface WEmitFile {
  path: string;
  contents: string;
}
/** The EmitPreview result. */
export interface WEmitPreviewResult {
  target: string;
  files: WEmitFile[];
  diagnostics: WDiagnostic[];
  error?: string | null;
}

const SEVERITY = ['', 'error', 'warning', 'info', 'hint'] as const;

/** One diagnostic as a `- [error] line:col message` line (1-based, like the editor gutter). */
function diagLine(d: WDiagnostic): string {
  const sev = SEVERITY[d.severity] ?? 'info';
  const line = d.range.start.line + 1;
  const col = d.range.start.character + 1;
  return `- [${sev}] ${line}:${col} ${d.message}`;
}

/** Summarize a DiagnoseWorkspace result for the model: an ok flag plus the diagnostic list. */
export function formatValidate(buckets: WFileDiagnostics[]): string {
  const all = buckets.flatMap((b) => b.diagnostics ?? []);
  if (!all.length) return 'ok: true — no diagnostics. The model compiles.';
  const errors = all.filter((d) => d.severity === 1).length;
  const warnings = all.filter((d) => d.severity === 2).length;
  return `ok: false — ${errors} error(s), ${warnings} warning(s):\n${all.map(diagLine).join('\n')}`;
}

/** Summarize an EmitPreview result for the model: the emitted files, or the error/diagnostics. */
export function formatCompile(res: WEmitPreviewResult): string {
  if (res.error) return `compile failed: ${res.error}`;
  const errors = (res.diagnostics ?? []).filter((d) => d.severity === 1);
  if (errors.length) {
    return `compile failed — ${errors.length} error(s):\n${errors.map(diagLine).join('\n')}`;
  }
  const files = res.files ?? [];
  if (!files.length) return `compiled to ${res.target}: no files emitted.`;
  return (
    `compiled to ${res.target} — ${files.length} file(s):\n\n` +
    files.map((f) => `// ${f.path}\n${f.contents}`).join('\n\n')
  );
}

/** A short, single-line status for the inline tool-call line in the transcript. */
export function summarizeForChip(_name: string, result: string): string {
  const firstLine = result.split('\n').find((l) => l.trim().length) ?? '';
  return firstLine.length > 88 ? firstLine.slice(0, 87) + '…' : firstLine;
}
