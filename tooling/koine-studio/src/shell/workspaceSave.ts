// workspaceSave: the format-on-save + disk-write paths (saveActive / saveAllDirty) and the idle
// auto-save debounce (#268) — split out of workspaceController (Task 5 of the ide.ts decomposition,
// issue #982). It owns the re-entrancy guards + the auto-save timer state, reaching the store, the
// injected deps, and the facade's tree render through the shared WorkspaceModuleCtx. `clearAutoSaveTimer`
// is RETURNED so the facade's open/reset paths can cancel a pending auto-save before tearing down.
import type { WorkspaceModuleCtx } from './workspaceController';

export function createWorkspaceSave(ctx: WorkspaceModuleCtx) {
  const { st, deps, renderTree } = ctx;
  const { platform, lsp, editor } = deps;

  // --- save (format + write to disk) ----------------------------------------

  let saveQueued = false;
  async function saveActive(): Promise<void> {
    if (saveQueued) return;
    saveQueued = true;
    clearAutoSaveTimer(); // an explicit save subsumes any pending idle auto-save
    try {
      // Capture the save target up front: the format round-trip awaits, and the user can switch buffers
      // (or keep typing) while it is in flight — the response and the write must target the buffer that
      // was active at REQUEST time, never whatever the editor shows when the response lands.
      const uri = st().activeUri;
      // Format first (mirrors the editor's Mod-S) when format-on-save is enabled, then persist.
      if (deps.getFormatOnSave()) {
        const docAtRequest = editor.getDoc();
        try {
          const edits = await lsp.format();
          // Stale response: the active buffer or the doc changed while the format was in flight —
          // applying the edits now would silently garble the other/newer doc (positions.ts clamps
          // out-of-range edits instead of throwing).
          if (st().activeUri === uri && editor.getDoc() === docAtRequest) editor.applyEdits(edits);
        } catch (e) {
          console.error('format on save failed:', e);
        }
      }
      const buf = st().buffers.get(uri);
      if (!buf) return;
      let written = buf.text;
      if (st().activeUri === uri) {
        written = editor.getDoc();
        st().upsertBuffer({ ...buf, text: written });
        lsp.changeDoc(uri, written);
      }
      try {
        await platform.writeTextFile(buf.path, written);
        // Keystrokes landing while the write is in flight replace the buffer (via syncBufferText) — only
        // mark clean when it still holds exactly what hit disk.
        const after = st().buffers.get(uri);
        const stillFresh = !!after && after.text === written;
        if (stillFresh) st().markSaved([uri]);
        // didSave() targets the ACTIVE doc — only valid when it's still the one just written AND that
        // write is still reflected (mirrors applyFileEdit's guard); neither a switch nor a keystroke
        // landing mid-write may tell the server the wrong (or stale) doc saved.
        if (stillFresh && st().activeUri === uri) lsp.didSave();
        renderTree();
        st().bumpSaved(); // #470: the on-disk git status changed — the saveSeq subscriber refreshes the SC panel
      } catch (e) {
        deps.setStatus('save failed', 'error');
        console.error('writeTextFile failed:', e);
      }
    } finally {
      saveQueued = false;
    }
  }

  // Save EVERY dirty buffer (Mod+Alt+S / "Save all"), so editing several files and then closing
  // can't silently drop the ones you didn't individually Mod-S. Mirrors saveActive's format+write
  // but across the whole workspace: the active buffer is formatted + synced from the editor first
  // (the others already hold their edited text in memory), then each dirty buffer is written. A
  // per-file write failure leaves that buffer dirty and reports it; the rest still save. The
  // single-file Mod-S path (saveActive) is unchanged.
  let saveAllQueued = false;
  async function saveAllDirty(): Promise<void> {
    if (saveAllQueued) return;
    saveAllQueued = true;
    clearAutoSaveTimer(); // a manual Save all subsumes any pending idle auto-save (no-op when auto-save fired this)
    try {
      if (deps.getFormatOnSave()) {
        // Same stale-response guard as saveActive: a buffer switch or fresh keystrokes during the
        // format round-trip make the edits target the wrong/an older doc — discard them.
        const uri = st().activeUri;
        const docAtRequest = editor.getDoc();
        try {
          const edits = await lsp.format();
          if (st().activeUri === uri && editor.getDoc() === docAtRequest) editor.applyEdits(edits);
        } catch (e) {
          console.error('format on save failed:', e);
        }
      }
      const activeUri = st().activeUri;
      const active = st().buffers.get(activeUri);
      if (active) {
        const text = editor.getDoc();
        st().upsertBuffer({ ...active, text });
        lsp.changeDoc(activeUri, text);
      }

      if (st().dirtyCount() === 0) {
        return;
      }

      // Write every dirty buffer (mirrors dirty.ts's saveAllDirtyBuffers, but through slice actions so
      // the cleared dirty flags publish to the UI): a failed write leaves that buffer dirty and is
      // reported; a keystroke landing mid-write keeps its buffer dirty (markSaved only when the buffer
      // still holds exactly what hit disk). Snapshot the SET of dirty uris, then re-read each buffer's
      // LIVE text at write time — a keystroke on a not-yet-written buffer during an earlier buffer's write
      // replaces its object in the store, so reading from a frozen buffer snapshot would persist stale
      // text (the old in-place saveAllDirtyBuffers read the latest text at write time).
      const dirtyUris = [...st().buffers.values()].filter((b) => b.dirty).map((b) => b.uri);
      let failures = 0;
      let writes = 0;
      // Uris CONFIRMED clean after their write (still hold exactly what hit disk) — a keystroke landing
      // mid-write (or mid-loop, on a not-yet-written buffer) leaves a uri dirty again despite its write
      // having succeeded, and the didSave() guard below must not treat it as confirmed saved even though
      // the disk write itself (tracked by `writes`, below) genuinely happened.
      const savedUris = new Set<string>();
      for (const uri of dirtyUris) {
        const buf = st().buffers.get(uri);
        if (!buf || !buf.dirty) continue; // saved or removed since the snapshot
        const written = buf.text;
        try {
          await platform.writeTextFile(buf.path, written);
          writes++;
          const after = st().buffers.get(uri);
          if (after && after.text === written) {
            st().markSaved([uri]);
            savedUris.add(uri);
          }
        } catch (e) {
          failures++;
          console.error('writeTextFile failed for', buf.path, e);
        }
      }
      if (writes > 0) {
        // didSave() targets the ACTIVE doc. Fire it when either nothing switched during the write loop
        // (the pre-existing behavior — the active doc may not itself have been dirty, e.g. auto-save
        // persisting a background buffer) or the buffer switched TO is one CONFIRMED saved this pass;
        // a switch to an unrelated, unsaved, or re-dirtied buffer must not tell the server it saved.
        const current = st().activeUri;
        if (current === activeUri || savedUris.has(current)) lsp.didSave();
        renderTree();
        st().bumpSaved(); // #470: at least one buffer hit disk — the saveSeq subscriber refreshes the SC panel
      }
      if (failures > 0) {
        deps.setStatus(`Save failed for ${failures} file${failures === 1 ? '' : 's'}`, 'error');
      }
    } finally {
      saveAllQueued = false;
    }
  }

  // --- idle auto-save (#268) ------------------------------------------------
  // Opt-in: when enabled, every edit (re)arms a ~1000ms timer; on fire it persists through the exact
  // saveAllDirty path (format-on-save, didSave, tree refresh, the saveAllQueued guard against an
  // in-flight manual save). Disabling cancels any pending timer so a stale edit can't write after the
  // user turns it off.
  const AUTO_SAVE_DEBOUNCE_MS = 1000;
  let autoSaveOn = false;
  let autoSaveTimer: ReturnType<typeof setTimeout> | undefined;

  function clearAutoSaveTimer(): void {
    if (autoSaveTimer !== undefined) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = undefined;
    }
  }

  function setAutoSave(on: boolean): void {
    autoSaveOn = on;
    if (!on) clearAutoSaveTimer();
  }

  function scheduleAutoSave(): void {
    // Arm only when auto-save is on AND there is actually unsaved work. The editor's onChange fires on
    // every programmatic setDoc too (a file switch, a history restore, the first folder open), which
    // dirties nothing — without this guard each such swap would arm a timer that 1s later runs a no-op
    // saveAllDirty and clobbers the status line with "No unsaved changes".
    if (!autoSaveOn || st().dirtyCount() === 0) return;
    clearAutoSaveTimer();
    autoSaveTimer = setTimeout(() => {
      autoSaveTimer = undefined;
      // Yield to an in-flight manual save (Mod-S saveActive / Save all) rather than racing format +
      // write on the same buffer; the next edit re-arms the debounce.
      if (saveQueued || saveAllQueued) return;
      void saveAllDirty();
    }, AUTO_SAVE_DEBOUNCE_MS);
  }

  return { saveActive, saveAllDirty, setAutoSave, scheduleAutoSave, clearAutoSaveTimer };
}
