// workspaceMutations: the explorer-driven file mutations (create / rename / delete / duplicate / move)
// split out of workspaceController (Task 5 of the ide.ts decomposition, issue #982). These handlers do
// the host fs op, then keep `buffers` / `activeUri` / the LSP workspace coherent and refresh the tree —
// reaching the store, the injected deps, and the facade-owned flows through the shared WorkspaceModuleCtx.
// The PURE, store-independent token<->path helpers (isUnder / nameOf / parentTokenOf / isAlreadyExists /
// copyName) live here too, EXPORTED so the buffers module + the facade can reuse them.
import { basename } from '@/shared/path';
import type { FsEntry } from '@/host';
import type { WorkspaceModuleCtx } from './workspaceController';

/** True if `path` is the token itself or lives under the `ancestor` directory token (any separator). */
export function isUnder(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(ancestor + '/') || path.startsWith(ancestor + '\\');
}

export function nameOf(token: string): string {
  return basename(token);
}

export function parentTokenOf(token: string): string | null {
  const slash = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'));
  return slash >= 0 ? token.slice(0, slash) : null;
}

/**
 * True when a host fs op failed because the destination name is taken. The desktop (Tauri) host
 * rejects with a plain string and the browser with an Error, so match the message text (not the
 * type) — shared by handleDuplicate (retry next name) and handleMove (surface the clash).
 */
export function isAlreadyExists(e: unknown): boolean {
  return String(e instanceof Error ? e.message : e).includes('already exists');
}

/** "order.koi" → "order copy.koi" (i=1) / "order copy 2.koi" (i=2); dirs get no extension split. */
export function copyName(name: string, i: number, isFile: boolean): string {
  const suffix = i === 1 ? ' copy' : ` copy ${i}`;
  const dot = isFile ? name.lastIndexOf('.') : -1;
  if (dot > 0) return `${name.slice(0, dot)}${suffix}${name.slice(dot)}`;
  return `${name}${suffix}`;
}

export function createWorkspaceMutations(ctx: WorkspaceModuleCtx) {
  const { st, deps, rootOfToken, relOfToken, refreshEntries, openFileToken, syncOpenKoi, activateFallback, rekeyBuffers } = ctx;
  const { platform, lsp } = deps;

  // --- workspace mutations (create / rename / delete / move) -----------------
  // The explorer surfaces user intent as opaque tokens; these handlers do the host fs op, then keep
  // `buffers` / `activeUri` / the LSP workspace coherent and refresh the tree. relPaths handed to the
  // host are relative to the OWNING root of the operated token (rootOfToken), so multi-root ops target
  // the right folder; for the single-root case the owning root is always the primary root, identical
  // to the old `folderRoot`.

  async function handleNewFile(parentDirToken: string, name: string): Promise<void> {
    if (st().roots.length === 0) return;
    const owningRoot = rootOfToken(parentDirToken) ?? st().roots[0];
    const parentRel = relOfToken(parentDirToken);
    // The explorer only surfaces directories and .koi files, so default an extensionless name to
    // `.koi` — otherwise the created file would be invisible (listEntries filters it out) and the
    // user would think New File silently failed.
    const fileName = name.includes('.') ? name : `${name}.koi`;
    const relPath = parentRel ? `${parentRel}/${fileName}` : fileName;
    try {
      const token = await platform.createFile(owningRoot, relPath, '');
      await refreshEntries();
      if (token.toLowerCase().endsWith('.koi')) await openFileToken(token);
    } catch (e) {
      deps.setStatus('could not create file', 'error');
      console.error('createFile failed:', e);
    }
  }

  async function handleNewFolder(parentDirToken: string, name: string): Promise<void> {
    if (st().roots.length === 0) return;
    const owningRoot = rootOfToken(parentDirToken) ?? st().roots[0];
    const parentRel = relOfToken(parentDirToken);
    const relPath = parentRel ? `${parentRel}/${name}` : name;
    try {
      await platform.createFolder(owningRoot, relPath);
      await refreshEntries();
    } catch (e) {
      deps.setStatus('could not create folder', 'error');
      console.error('createFolder failed:', e);
    }
  }

  async function handleDelete(entry: FsEntry): Promise<void> {
    try {
      await platform.deleteEntry(entry.token);
    } catch (e) {
      deps.setStatus('could not delete', 'error');
      console.error('deleteEntry failed:', e);
      return;
    }
    // Close every open buffer at or under the deleted token; re-point active if it was one of them.
    let activeRemoved = false;
    for (const buf of [...st().buffers.values()]) {
      if (isUnder(buf.path, entry.token)) {
        if (buf.uri === st().activeUri) activeRemoved = true;
        lsp.closeDoc(buf.uri);
        st().removeBuffer(buf.uri);
        deps.dropDiagnostics(buf.uri);
      }
    }
    if (activeRemoved) activateFallback();
    await refreshEntries();
  }

  async function handleRename(entry: FsEntry, newName: string): Promise<void> {
    let newToken: string;
    try {
      newToken = await platform.renameEntry(entry.token, newName);
    } catch (e) {
      deps.setStatus('could not rename', 'error');
      console.error('renameEntry failed:', e);
      return;
    }
    rekeyBuffers(entry.token, newToken);
    await refreshEntries();
  }

  async function handleDuplicate(entry: FsEntry): Promise<void> {
    if (st().roots.length === 0) return;
    const owningRoot = rootOfToken(entry.token) ?? st().roots[0];
    const parentRel = relOfToken(parentTokenOf(entry.token) ?? owningRoot);
    // Try "<base> copy", then "<base> copy 2", … until the host accepts a non-colliding name.
    for (let i = 1; i <= 50; i++) {
      const dupName = copyName(entry.name, i, entry.kind === 'file');
      const relPath = parentRel ? `${parentRel}/${dupName}` : dupName;
      try {
        const token = await platform.moveEntry(entry.token, owningRoot, relPath, true);
        await refreshEntries();
        if (entry.kind === 'file' && token.toLowerCase().endsWith('.koi')) await openFileToken(token);
        else await syncOpenKoi(); // a duplicated folder may contain new .koi files
        return;
      } catch (e) {
        // A collision means "try the next candidate name".
        if (isAlreadyExists(e)) continue;
        deps.setStatus('could not duplicate', 'error');
        console.error('duplicate failed:', e);
        return;
      }
    }
    // Every candidate name collided — don't fail silently.
    deps.setStatus('could not duplicate (too many copies)', 'error');
  }

  // Drag-and-drop move: reparent `entry` into `destDirToken` (the opened folder for root), keeping its
  // name. The explorer already rejects no-op and into-own-subtree drops, so this just performs the host
  // move and re-keys the open buffers / LSP workspace, mirroring rename.
  async function handleMove(entry: FsEntry, destDirToken: string): Promise<void> {
    if (st().roots.length === 0) return;
    // The move targets the destination's owning root (a cross-root drag reparents into that root).
    const owningRoot = rootOfToken(destDirToken) ?? st().roots[0];
    const destRel = relOfToken(destDirToken);
    const newRelPath = destRel ? `${destRel}/${entry.name}` : entry.name;
    let newToken: string;
    try {
      newToken = await platform.moveEntry(entry.token, owningRoot, newRelPath, false);
    } catch (e) {
      // A name clash at the destination is the common, recoverable case — surface it, don't overwrite.
      if (isAlreadyExists(e)) {
        deps.setStatus(`“${entry.name}” already exists there`, 'error');
      } else {
        deps.setStatus('could not move', 'error');
        console.error('moveEntry failed:', e);
      }
      return;
    }
    rekeyBuffers(entry.token, newToken);
    await refreshEntries();
    if (entry.kind === 'dir') await syncOpenKoi(); // moved folder may carry .koi files to re-key
  }

  return { handleNewFile, handleNewFolder, handleDelete, handleRename, handleDuplicate, handleMove };
}
