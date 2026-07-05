// workspaceBuffers: the open-buffer/dirty sync, buffer re-keying on a rename/move, and the cross-buffer
// WorkspaceEdit + assistant multi-file apply — split out of workspaceController (Task 5 of the ide.ts
// decomposition, issue #982). It reads/writes the store-owned buffer set through the shared
// WorkspaceModuleCtx and reuses the PURE path helpers (isUnder / nameOf) from workspaceMutations.
import { pathToFileUri } from '@/shell/ideUtils';
import { isUnder, nameOf } from './workspaceMutations';
import type { TextEdit, WorkspaceEdit } from '@/lsp/lsp';
import type { Buffer } from '@/store/slices/workspace';
import type { WorkspaceModuleCtx } from './workspaceController';

export function createWorkspaceBuffers(ctx: WorkspaceModuleCtx) {
  const { st, deps, rootOfToken, relOfToken, renderTree, refreshEntries, ensureBuffer } = ctx;
  const { platform, lsp, editor } = deps;

  // --- buffer / dirty sync --------------------------------------------------

  // The buffer/dirty half of the editor's onChange. ide.ts keeps welcome.hide + controller.onDocEdited
  // around this and re-renders the tree on the returned becameDirty (preserving the original order).
  // Uri-keyed so the second editor group (group B) can sync its OWN file's buffer without touching the
  // active (group-A) buffer (#265): a no-op when `uri` is not an open buffer. Delegates to the slice's
  // syncBufferText action (which returns becameDirty and no-ops on an unchanged/unknown buffer).
  function syncBuffer(uri: string, doc: string): boolean {
    return st().syncBufferText(uri, doc);
  }

  // The active-buffer convenience wrapper used by group A's onChange: identical behavior to the
  // pre-#265 syncActiveBuffer, now expressed as syncBuffer(activeUri, doc).
  function syncActiveBuffer(doc: string): boolean {
    return syncBuffer(st().activeUri, doc);
  }

  function anyDirty(): boolean {
    return st().anyDirty();
  }

  // Re-key every buffer at/under `oldToken` to its path under `newToken` (a file or folder rename/
  // move), preserving each buffer's unsaved text + dirty flag and keeping the LSP workspace in sync.
  // Each re-key is one atomic slice transition (rekeyBuffer), so a subscriber never sees a buffer under
  // both the old and the new uri, and the active buffer is re-pointed in the same set.
  function rekeyBuffers(oldToken: string, newToken: string): void {
    for (const buf of [...st().buffers.values()]) {
      if (!isUnder(buf.path, oldToken)) continue;
      const newPath = newToken + buf.path.slice(oldToken.length);
      const newUri = pathToFileUri(newPath);
      const wasActive = buf.uri === st().activeUri;
      lsp.closeDoc(buf.uri);
      // Move the cached diagnostics with the buffer (no repaint — the gutter re-renders when the
      // active file's diagnostics are next shown / pushed), preserving the old re-key behavior.
      deps.renameDiagnostics(buf.uri, newUri);
      const nextBuf: Buffer = {
        ...buf,
        uri: newUri,
        path: newPath,
        relPath: relOfToken(newPath),
        name: nameOf(newPath),
        // Re-derive the owning root: a cross-root move changes it; an in-root rename keeps it. Fall back
        // to the existing rootToken when no root owns the new path (mirrors ensureBuffer's resolution).
        rootToken: rootOfToken(newPath) ?? buf.rootToken,
      };
      // rekeyBuffer re-points activeUri atomically when buf.uri was active; pair the LSP side effect.
      st().rekeyBuffer(buf.uri, nextBuf);
      lsp.openDoc(newUri, nextBuf.text);
      if (wasActive) lsp.setActive(newUri);
    }
  }

  // --- workspace edits ------------------------------------------------------

  // Apply LSP TextEdits to a plain string (for non-active buffers in a cross-file rename). Edits
  // are applied from the end backward so earlier edits don't shift the offsets of later ones.
  function applyTextEditsToString(text: string, edits: TextEdit[]): string {
    const lines = text.split('\n');
    const offsetOf = (line: number, character: number): number => {
      const ln = Math.min(Math.max(line, 0), lines.length - 1);
      let offset = 0;
      for (let i = 0; i < ln; i++) offset += lines[i].length + 1; // + the '\n'
      return offset + Math.min(Math.max(character, 0), lines[ln].length);
    };
    const sorted = edits
      .map((e) => ({
        from: offsetOf(e.range.start.line, e.range.start.character),
        to: offsetOf(e.range.end.line, e.range.end.character),
        insert: e.newText,
      }))
      .sort((a, b) => b.from - a.from);
    let result = text;
    for (const edit of sorted) result = result.slice(0, edit.from) + edit.insert + result.slice(edit.to);
    return result;
  }

  // Apply a rename/code-action WorkspaceEdit across open buffers. The active file is edited through
  // the editor (so undo history + the onChange sync path fire); other OPEN files are patched in
  // their stored text and pushed to the server immediately. Edits to non-open files are ignored.
  function applyWorkspaceEdit(edit: WorkspaceEdit): void {
    if (!edit?.changes) return;
    let treeChanged = false;
    for (const [uri, edits] of Object.entries(edit.changes)) {
      if (!edits.length) continue;
      if (uri === st().activeUri) {
        editor.applyEdits(edits); // dispatch → onChange updates the buffer + lsp + doc views
      } else {
        const buf = st().buffers.get(uri);
        if (!buf) continue;
        const newText = applyTextEditsToString(buf.text, edits);
        st().upsertBuffer({ ...buf, text: newText, dirty: true });
        lsp.syncDoc(uri, newText);
        treeChanged = true;
      }
    }
    if (treeChanged) renderTree();
    st().bumpWorkspaceEdit(); // the onBuffersChanged seam: ide.ts subscribes to workspaceEditSeq
  }

  // Write one full-file body to `relPath` for the assistant's multi-file apply. An EXISTING open buffer
  // (matched by relPath) is updated in place — reflected in the editor when it's the active one (so the
  // change shows + fires onChange), synced to the LSP, persisted, and left CLEAN. A relPath with no open
  // buffer is CREATED under the primary root and opened. Returns the file uri, or null on failure.
  async function applyFileEdit(relPath: string, body: string): Promise<string | null> {
    const existing = [...st().buffers.values()].find((b) => b.relPath === relPath);
    if (existing) {
      const uri = existing.uri;
      const path = existing.path;
      if (uri === st().activeUri) editor.setDoc(body); // reflect in the open editor (fires onChange → dirty)
      // Ensure the buffer holds `body` whether or not onChange ran (tests don't wire the editor↔sync).
      const cur = st().buffers.get(uri);
      if (cur && cur.text !== body) st().upsertBuffer({ ...cur, text: body });
      lsp.changeDoc(uri, body);
      try {
        await platform.writeTextFile(path, body);
      } catch (e) {
        console.error('applyFileEdit write failed:', e);
        return null;
      }
      // Keystrokes landing while the write is in flight replace the buffer (via syncBufferText) — only
      // mark clean when it still holds exactly what hit disk (mirrors saveActive / saveAllDirty).
      const after = st().buffers.get(uri);
      if (after && after.text === body) st().markSaved([uri]);
      if (uri === st().activeUri) lsp.didSave(); // didSave() targets the ACTIVE doc — only valid then
      renderTree(); // setDoc's onChange repainted the explorer dirty dot; repaint it clean now
      st().bumpSaved(); // #470: this buffer hit disk — the saveSeq subscriber refreshes the SC panel
      return uri;
    }
    const owningRoot = st().roots[0];
    if (!owningRoot) return null;
    try {
      const token = await platform.createFile(owningRoot, relPath, body); // new file under the folder root
      await refreshEntries();
      st().bumpSaved(); // #470: a new (untracked) file hit disk — the saveSeq subscriber refreshes the SC panel
      return await ensureBuffer(token);
    } catch (e) {
      console.error('applyFileEdit create failed:', e);
      return null;
    }
  }

  return { syncBuffer, syncActiveBuffer, anyDirty, rekeyBuffers, applyWorkspaceEdit, applyFileEdit };
}
