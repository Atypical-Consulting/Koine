// The guarded LSP format shared by the palette command (commandWiring's `format` thunk). The format
// round-trip awaits; a file switch or fresh keystrokes while it is in flight would make the whole-file
// edits target a different/newer doc — and positions.ts clamps out-of-range edits instead of throwing,
// so applying a stale response silently garbles the document. The response is applied only when both
// the active uri and the doc text are unchanged from request time (same guard as workspaceController's
// save paths). Lives here, not in ide.tsx's init(), per the composition-root line budget
// (lineBudgets.test.ts).
import { type TextEdit } from '@/lsp/lsp';

export interface FormatActiveDeps {
  /** Request whole-file format edits from the language server (lsp.format). */
  format(): Promise<TextEdit[]>;
  /** The editor's current document text. */
  getDoc(): string;
  /** Apply LSP text edits to the editor document. */
  applyEdits(edits: TextEdit[]): void;
  /** The uri of the buffer the editor currently shows. */
  activeUri(): string;
}

/** Build the format-active-document action: format via the LSP and apply the edits, discarding a
 *  response that resolves after the active buffer or its text changed. Degrades silently on failure. */
export function createFormatActive(deps: FormatActiveDeps): () => Promise<void> {
  return async () => {
    const uri = deps.activeUri();
    const docAtRequest = deps.getDoc();
    try {
      const edits = await deps.format();
      if (deps.activeUri() === uri && deps.getDoc() === docAtRequest) deps.applyEdits(edits);
    } catch (e) {
      console.error('format failed:', e);
    }
  };
}
