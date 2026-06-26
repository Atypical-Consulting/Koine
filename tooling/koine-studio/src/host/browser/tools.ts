// In-browser execution of the Assistant's Koine compiler tools: dispatch a `{name, argsJson}` tool
// call to the already-resident Koine.Wasm runtime and format the result for the model. This is the
// browser half of Platform.runCompilerTool — the desktop half proxies to the `koine mcp --http`
// sidecar instead (src/host/tauri.ts). The tool DEFINITIONS + pure formatters live in assistantTools.
import { formatCompile, formatValidate, normalizeCompileTarget, runEditToolStaging } from '@/ai/assistantTools';
import type { EditSession } from '@/ai/editSession';
import { loadWasmApi } from '@/host/browser/wasm';

/** The single synthetic file URI the one-file tool `source` is wrapped into for the workspace APIs. */
const MODEL_URI = 'file:///model.koi';

/** The `[{uri,text}]` envelope DiagnoseWorkspace/EmitPreview expect, from a single source string. */
function filesJson(source: string): string {
  return JSON.stringify([{ uri: MODEL_URI, text: source }]);
}

/**
 * Execute a Koine tool (`koine_validate`/`koine_compile`/`koine_format`) against the in-process WASM
 * compiler, resolving a text result for the Assistant's tool loop. Never throws on bad input — a
 * malformed-args or unknown-tool case resolves to an error string the model can read and recover from.
 */
export async function runWasmTool(name: string, argsJson: string): Promise<string> {
  let args: { source?: unknown; target?: unknown };
  try {
    args = JSON.parse(argsJson || '{}');
  } catch {
    return 'Error: the tool arguments were not valid JSON.';
  }
  const source = typeof args.source === 'string' ? args.source : '';

  const api = await loadWasmApi();
  switch (name) {
    case 'koine_validate':
      return formatValidate(JSON.parse(await api.DiagnoseWorkspace(filesJson(source))));
    case 'koine_compile':
      return formatCompile(JSON.parse(await api.EmitPreview(filesJson(source), normalizeCompileTarget(args.target))));
    case 'koine_format': {
      // Format returns LSP TextEdits: either [] (already canonical) or a single whole-document edit
      // whose newText IS the formatted source.
      const edits = JSON.parse(await api.Format(source)) as { newText: string }[];
      return Array.isArray(edits) && edits.length ? edits[0].newText : source;
    }
    default:
      return `Error: unknown tool ${name}.`;
  }
}

/** The `[{uri,text}]` envelope for the WHOLE staged workspace (every relPath the session knows,
 *  reading through to staged-or-initial bodies). relPaths map to `file:///<relPath>` uris. */
function workspaceEnvelope(session: EditSession): string {
  return JSON.stringify(
    session.list().map((relPath) => ({ uri: `file:///${relPath}`, text: session.read(relPath) ?? '' })),
  );
}

/**
 * Execute a host-local edit tool (koine_list_files/koine_read_file/koine_write_file) against the
 * per-turn staging `session`. The list/read/write dispatch is host-independent
 * ({@link runEditToolStaging}); the browser host supplies the whole-staged-workspace validation by
 * running the resident WASM compiler's `DiagnoseWorkspace` over the staged set after a write.
 */
export function runEditTool(name: string, argsJson: string, session: EditSession): Promise<string> {
  return runEditToolStaging(name, argsJson, session, async () =>
    formatValidate(JSON.parse(await (await loadWasmApi()).DiagnoseWorkspace(workspaceEnvelope(session)))),
  );
}
