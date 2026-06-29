// The export / share / save-to-disk surface, extracted from ide.tsx's init() (#757). Owns the
// shareable-link copy, the .koi source-zip export, the live-diagram export (SVG/PNG/PlantUML) + Mermaid
// copy, the Save-to-disk project promotion, the Generate Project wizard, and the shared-workspace import
// from a share link. Pure structural lift: every closure keeps its exact logic; it just moves out of
// init() and reaches the host / workspace / editor / status pill through the injected `deps`.
import { createGenerateProject } from '@/export/generateProjectWizard';
import { sanitizeProjectName } from '@/export/generateProject';
import { buildSourceZip } from '@/export/sourceZip';
import { exportDiagram } from '@/export/diagramExport';
import { getActiveDomainExport } from '@/diagrams/diagrams';
import { workspaceShareUrlOrNull } from '@/export/share';
import { isSafeShareRelPath } from '@/shell/ideUtils';
import type { Platform } from '@/host';
import type { KoineLsp } from '@/lsp/lsp';
import type { WorkspaceController } from '@/shell/workspaceController';
import type { PromptDialog } from '@/shared/overlay';

export interface ExportShareDeps {
  platform: Platform;
  lsp: Pick<KoineLsp, 'emitPreview' | 'glossary'>;
  workspace: Pick<
    WorkspaceController,
    'buffers' | 'activeUri' | 'folderRootToken' | 'syncActiveBuffer' | 'openFolderPath' | 'activateFile'
  >;
  editor: { getDoc(): string };
  setStatus(text: string, kind: 'green' | 'error'): void;
  /** Re-derive the status pill from the CURRENT diagnostics after a transient flash (#271), so a fresh
   *  push isn't clobbered. Wraps editorSession.updateStatus(editorSession.diagnosticsFor(activeUri)). */
  refreshStatusFromDiagnostics(): void;
  promptDialog: Pick<PromptDialog, 'ask'>;
}

export interface ExportShare {
  copyShareLink(): Promise<void>;
  exportSourceZip(): Promise<void>;
  exportActiveDiagram(format: 'svg' | 'png' | 'plantuml'): Promise<void>;
  copyActiveDiagramMermaid(): Promise<void>;
  saveProjectToDisk(): Promise<void>;
  importSharedWorkspace(files: { relPath: string; text: string }[], active?: string): Promise<void>;
  /** The Generate Project wizard handle (the toolbar button + palette command open it). */
  readonly generateProject: { open(): void };
}

export function createExportShare(deps: ExportShareDeps): ExportShare {
  const { platform, workspace, editor, setStatus, promptDialog } = deps;

  // Re-derive the pill from the CURRENT diagnostics 1.5s after a transient flash (#271).
  const scheduleStatusRefresh = (): void => void setTimeout(() => deps.refreshStatusFromDiagnostics(), 1500);

  // Generate Project wizard: compiles the active model, then bundles the emitted files into a
  // downloadable archive. I/O is injected so the wizard stays decoupled from the LSP/host wiring.
  const generateProject = createGenerateProject({
    emitPreview: (target) => deps.lsp.emitPreview(target),
    glossary: () => deps.lsp.glossary(),
    saveZip: (name, data) => platform.saveZip(name, data),
  });

  // Copy a shareable playground link (the current model encoded in the URL hash) to the clipboard,
  // flashing a transient confirmation in the status pill. After the flash, re-derive the pill from
  // the CURRENT diagnostics rather than restoring a snapshot (which could clobber a fresh push).
  //
  // Shares the WHOLE workspace (every open buffer) under a versioned envelope, with the active file
  // flagged so the recipient lands on it. A workspace that overflows the URL-length cap is not
  // copied as a broken link — instead we steer the user to the `.koi` source zip export.
  async function copyShareLink(): Promise<void> {
    try {
      const files = Array.from(workspace.buffers.values()).map((b) => ({ relPath: b.relPath, text: b.text }));
      const activeRelPath = workspace.buffers.get(workspace.activeUri())?.relPath;
      const url = workspaceShareUrlOrNull(files, activeRelPath);
      if (url === null) {
        setStatus('Workspace too large to share as a link — export a .koi source zip instead', 'error');
        scheduleStatusRefresh();
        return;
      }
      await navigator.clipboard.writeText(url);
      setStatus('link copied ✓', 'green');
      scheduleStatusRefresh();
    } catch (e) {
      console.error('copy share link failed:', e);
    }
  }

  // Bundle every open `.koi` document into a zip and hand it to the host's saveZip seam (Blob
  // download in the browser, native picker on desktop). Names the archive after the opened folder.
  // The whole bundle is DOM-free in sourceZip.ts so it can be unit-tested in isolation.
  async function exportSourceZip(): Promise<void> {
    try {
      const files = Array.from(workspace.buffers.values()).map((b) => ({ relPath: b.relPath, text: b.text }));
      const root = sanitizeProjectName(platform.folderName(workspace.folderRootToken()));
      const bytes = await buildSourceZip(files, { root });
      const saved = await platform.saveZip(`${root}.zip`, bytes);
      if (saved === true) {
        setStatus('source exported ✓', 'green');
        scheduleStatusRefresh();
      }
    } catch (e) {
      setStatus('export failed', 'error');
      console.error('export source zip failed:', e);
    }
  }

  // Flash a transient confirmation in the status pill, then re-derive it from the CURRENT diagnostics (so a
  // fresh push isn't clobbered) — the shared idiom behind the diagram export/copy handlers (#271).
  function flashStatus(message: string, kind: 'green' | 'error'): void {
    setStatus(message, kind);
    scheduleStatusRefresh();
  }

  // Export the live Visual canvas in the chosen format (#271): SVG/PNG serialize the actual drawing, PlantUML
  // is mapped from the structured graph client-side. Routes the bytes through the host's saveZip seam (Blob
  // download in the browser, native save dialog on desktop) with a caption-derived filename. A no-op with a
  // hint when no diagram is on screen; a user-cancelled save is silent (saveZip resolves false).
  async function exportActiveDiagram(format: 'svg' | 'png' | 'plantuml'): Promise<void> {
    const active = getActiveDomainExport();
    if (!active) {
      flashStatus('open the Visual diagram to export', 'error');
      return;
    }
    try {
      const saved = await exportDiagram(format, active.diagram, active.handle, (name, bytes) => platform.saveZip(name, bytes));
      if (saved === true) flashStatus('diagram exported ✓', 'green');
    } catch (e) {
      setStatus('export failed', 'error');
      console.error('export diagram failed:', e);
    }
  }

  // Copy the current diagram's Mermaid to the clipboard (#271), mirroring copyShareLink's flash. The fused
  // canvas is emitted as one Mermaid document; an empty model has nothing to copy.
  async function copyActiveDiagramMermaid(): Promise<void> {
    const mermaid = getActiveDomainExport()?.diagram.mermaid?.trim();
    if (!mermaid) {
      flashStatus('no diagram to copy', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(mermaid);
      flashStatus('Mermaid copied ✓', 'green');
    } catch (e) {
      setStatus('copy failed', 'error');
      console.error('copy mermaid failed:', e);
    }
  }

  // Save the current workspace as a real, reopenable on-disk project (browser host only). Promotes an
  // ephemeral example/Untitled workspace into <root>/<name>/, registers it in Recent, and reopens it
  // from disk so the workspace now IS that folder (further ⌘S writes there).
  async function saveProjectToDisk(): Promise<void> {
    if (!platform.canSaveProjects) return;
    // Flush the active editor's debounced text into its buffer so the snapshot is current.
    workspace.syncActiveBuffer(editor.getDoc());
    const files = [...workspace.buffers.values()].map((b) => ({ relPath: b.relPath, contents: b.text }));
    if (files.length === 0) {
      setStatus('nothing to save', 'error');
      return;
    }
    let seedValue = workspace.folderRootToken() ? platform.folderName(workspace.folderRootToken()) : 'my-project';
    let seedError = ''; // a name clash from a prior attempt, shown inline on the re-prompt
    for (;;) {
      const name = await promptDialog.ask({
        title: 'Save project',
        message: 'Saved to your projects folder and added to Recent.',
        label: 'Project name',
        initialValue: seedValue,
        confirmLabel: 'Save',
        error: seedError,
      });
      if (!name) return; // cancelled / empty
      try {
        const token = await platform.saveProjectToRoot(name, files);
        if (!token) return; // root picker dismissed
        await workspace.openFolderPath(token, { recent: true });
        setStatus('Project saved ✓', 'green');
        return;
      } catch (e) {
        if (String(e instanceof Error ? e.message : e).includes('already exists')) {
          // Re-ask with the clash surfaced inline (no second alert) and the rejected name pre-filled.
          seedError = `A project named "${name}" already exists — choose another name.`;
          seedValue = name;
          continue;
        }
        setStatus('save to disk failed', 'error');
        console.error('saveProjectToDisk failed:', e);
        return;
      }
    }
  }

  // Import a multi-file workspace carried in a share link. Materializes a real workspace and opens
  // it in folder mode (mirrors openExample). Runs from the lsp.start callback so the server is up
  // and the resulting didOpens resolve cross-file refs.
  async function importSharedWorkspace(files: { relPath: string; text: string }[], active?: string): Promise<void> {
    // A share link is untrusted input. Drop any file whose relPath could escape the workspace root
    // before it reaches platform.materializeWorkspace (which writes to disk) — defense in depth
    // against a malicious `..`/absolute path in the payload.
    const safeFiles = files.filter((f) => isSafeShareRelPath(f.relPath));
    // Nothing (safe) to import — fall through to the default workspace that already booted.
    if (safeFiles.length === 0) return;

    // Materialize a real workspace and open it in folder mode (mirrors openExample).
    const token = await platform.materializeWorkspace(
      'shared-workspace',
      safeFiles.map((f) => ({ relPath: f.relPath, contents: f.text })),
    );
    if (!token) {
      setStatus('could not open shared workspace', 'error');
      return;
    }
    await workspace.openFolderPath(token, { recent: false });
    // openFolderPath activates the first file by relPath; honour the share's `active` when present.
    if (active) {
      const target = Array.from(workspace.buffers.values()).find((b) => b.relPath === active);
      if (target) workspace.activateFile(target.uri);
    }
  }

  return {
    copyShareLink,
    exportSourceZip,
    exportActiveDiagram,
    copyActiveDiagramMermaid,
    saveProjectToDisk,
    importSharedWorkspace,
    generateProject,
  };
}
