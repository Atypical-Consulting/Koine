import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the heavy export/diagram collaborators so each path is asserted in isolation (no real zipping,
// SVG serialization, URL encoding, or wizard DOM). isSafeShareRelPath + sanitizeProjectName are pure, so
// they run for real.
vi.mock('@/export/share', () => ({ workspaceShareUrlOrNull: vi.fn() }));
vi.mock('@/export/sourceZip', () => ({ buildSourceZip: vi.fn(async () => new Uint8Array([1, 2, 3])) }));
vi.mock('@/export/diagramExport', () => ({ exportDiagram: vi.fn(async () => true) }));
vi.mock('@/diagrams/diagrams', () => ({ getActiveDomainExport: vi.fn() }));
vi.mock('@/export/generateProjectWizard', () => ({ createGenerateProject: vi.fn(() => ({ open: vi.fn() })) }));

import { createExportShare, type ExportShareDeps } from '@/shell/exportShare';
import { workspaceShareUrlOrNull } from '@/export/share';
import { getActiveDomainExport } from '@/diagrams/diagrams';

type Buf = { uri: string; relPath: string; text: string; name?: string };

function makeDeps(over: { buffers?: Buf[]; platform?: Record<string, unknown> } = {}): {
  deps: ExportShareDeps;
  setStatus: ReturnType<typeof vi.fn>;
  platform: Record<string, ReturnType<typeof vi.fn> | boolean>;
  workspace: Record<string, ReturnType<typeof vi.fn>>;
  buffers: Map<string, Buf>;
} {
  const buffers = new Map<string, Buf>((over.buffers ?? []).map((b) => [b.uri, b]));
  const setStatus = vi.fn();
  const platform = {
    saveZip: vi.fn(async () => true),
    folderName: vi.fn(() => 'myproj'),
    saveProjectToRoot: vi.fn(async () => 'tok'),
    materializeWorkspace: vi.fn(async () => 'tok'),
    canSaveProjects: true,
    ...over.platform,
  };
  const workspace = {
    activeUri: vi.fn(() => 'file:///a.koi'),
    folderRootToken: vi.fn(() => 'root'),
    syncActiveBuffer: vi.fn(),
    openFolderPath: vi.fn(async () => ({ ok: true })),
    activateFile: vi.fn(),
  };
  const deps = {
    platform: platform as unknown as ExportShareDeps['platform'],
    lsp: { emitPreview: vi.fn(), glossary: vi.fn() } as unknown as ExportShareDeps['lsp'],
    workspace: { buffers, ...workspace } as unknown as ExportShareDeps['workspace'],
    editor: { getDoc: vi.fn(() => 'source') },
    setStatus,
    refreshStatusFromDiagnostics: vi.fn(),
    promptDialog: { ask: vi.fn() },
  };
  return { deps, setStatus, platform, workspace, buffers };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => undefined) } });
});

describe('exportShare', () => {
  describe('copyShareLink', () => {
    it('writes the share url to the clipboard and confirms', async () => {
      vi.mocked(workspaceShareUrlOrNull).mockReturnValue('https://koi/#model');
      const { deps, setStatus } = makeDeps({ buffers: [{ uri: 'file:///a.koi', relPath: 'a.koi', text: 'x' }] });
      await createExportShare(deps).copyShareLink();
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://koi/#model');
      expect(setStatus).toHaveBeenCalledWith('link copied ✓', 'green');
    });

    it('steers to the zip export and never touches the clipboard when the link overflows', async () => {
      vi.mocked(workspaceShareUrlOrNull).mockReturnValue(null);
      const { deps, setStatus } = makeDeps({ buffers: [{ uri: 'file:///a.koi', relPath: 'a.koi', text: 'x' }] });
      await createExportShare(deps).copyShareLink();
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
      expect(setStatus).toHaveBeenCalledWith(expect.stringContaining('too large'), 'error');
    });
  });

  it('exportSourceZip bundles the buffers and saves the archive', async () => {
    const { deps, setStatus, platform } = makeDeps({ buffers: [{ uri: 'file:///a.koi', relPath: 'a.koi', text: 'x' }] });
    await createExportShare(deps).exportSourceZip();
    expect(platform.saveZip).toHaveBeenCalledWith('myproj.zip', expect.any(Uint8Array));
    expect(setStatus).toHaveBeenCalledWith('source exported ✓', 'green');
  });

  describe('exportActiveDiagram', () => {
    it('hints (no save) when there is no live diagram', async () => {
      vi.mocked(getActiveDomainExport).mockReturnValue(null);
      const { deps, setStatus, platform } = makeDeps();
      await createExportShare(deps).exportActiveDiagram('svg');
      expect(platform.saveZip).not.toHaveBeenCalled();
      expect(setStatus).toHaveBeenCalledWith('open the Visual diagram to export', 'error');
    });

    it('exports and confirms when a diagram is on screen', async () => {
      vi.mocked(getActiveDomainExport).mockReturnValue({ diagram: {}, handle: {} } as never);
      const { deps, setStatus } = makeDeps();
      await createExportShare(deps).exportActiveDiagram('png');
      expect(setStatus).toHaveBeenCalledWith('diagram exported ✓', 'green');
    });
  });

  it('importSharedWorkspace drops path-escaping files and opens the safe ones in folder mode', async () => {
    const { deps, platform, workspace } = makeDeps();
    const opened = await createExportShare(deps).importSharedWorkspace([
      { relPath: 'model.koi', text: 'a' },
      { relPath: '../escape.koi', text: 'b' },
    ]);
    const materializeArg = (platform.materializeWorkspace as ReturnType<typeof vi.fn>).mock.calls[0][1] as Array<{ relPath: string }>;
    expect(materializeArg.map((f) => f.relPath)).toEqual(['model.koi']); // the `..` file was filtered out
    expect(workspace.openFolderPath).toHaveBeenCalledWith('tok', { recent: false });
    expect(opened).toBe(true); // a workspace is open — the boot ladder must NOT fall back to the default
  });

  // importSharedWorkspace reports whether it actually opened a workspace, so the boot ladder can fall
  // back to the default instead of stranding the editor with zero buffers (every save a silent no-op).
  it('importSharedWorkspace returns false when every relPath is filtered as unsafe', async () => {
    const { deps, platform } = makeDeps();
    const opened = await createExportShare(deps).importSharedWorkspace([{ relPath: '../escape.koi', text: 'b' }]);
    expect(platform.materializeWorkspace).not.toHaveBeenCalled();
    expect(opened).toBe(false);
  });

  it('importSharedWorkspace returns false when the host cannot materialize a workspace', async () => {
    const { deps, setStatus } = makeDeps({ platform: { materializeWorkspace: vi.fn(async () => null) } });
    const opened = await createExportShare(deps).importSharedWorkspace([{ relPath: 'model.koi', text: 'a' }]);
    expect(setStatus).toHaveBeenCalledWith('could not open shared workspace', 'error');
    expect(opened).toBe(false);
  });
});
