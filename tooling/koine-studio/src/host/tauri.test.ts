import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_SETTINGS, saveSettings } from '@/settings/persistence';

// Drive TauriPlatform's MCP surface against a mocked Tauri IPC (mirroring tauriGit/tauriTerminal.test.ts):
// `mcpEndpoint()` is a thin `invoke('mcp_endpoint', { port })` wrapper whose port comes from the persisted
// `mcpPort` setting, and it maps the Rust `McpEndpointInfo` ({ url, requestedPort, fallback }) down to the
// host-facing `McpEndpoint` ({ url, fallback }). `mcpCall` is mocked too so runCompilerTool's POST target
// (the resolved `.url`) can be asserted without a real HTTP server. Only these two seams are mocked;
// tauri.ts's other imports load normally under happy-dom.
const { invokeMock, mcpCallMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  mcpCallMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@/mcp/mcp', () => ({ mcpCall: mcpCallMock }));

import { TauriPlatform } from '@/host/tauri';
import { createEditSession } from '@/ai/editSession';

beforeEach(() => {
  localStorage.clear();
  saveSettings({ ...DEFAULT_SETTINGS });
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(null);
  mcpCallMock.mockReset();
  mcpCallMock.mockResolvedValue('');
});

describe('TauriPlatform MCP surface', () => {
  it('reports canHostMcp = true (the desktop host serves a koine mcp --http sidecar)', () => {
    expect(new TauriPlatform().canHostMcp).toBe(true);
  });

  it('(a) mcpEndpoint invokes mcp_endpoint with { port: 56463 } when settings hold the default', async () => {
    invokeMock.mockResolvedValue({ url: 'http://127.0.0.1:56463/mcp', requestedPort: 56463, fallback: false });

    await new TauriPlatform().mcpEndpoint();

    expect(invokeMock).toHaveBeenCalledWith('mcp_endpoint', { port: 56463 });
  });

  it('(b) mcpEndpoint invokes mcp_endpoint with the configured port after saveSettings({ mcpPort: 9100 })', async () => {
    saveSettings({ ...DEFAULT_SETTINGS, mcpPort: 9100 });
    invokeMock.mockResolvedValue({ url: 'http://127.0.0.1:9100/mcp', requestedPort: 9100, fallback: false });

    await new TauriPlatform().mcpEndpoint();

    expect(invokeMock).toHaveBeenCalledWith('mcp_endpoint', { port: 9100 });
  });

  it('(c) mcpEndpoint maps the McpEndpointInfo payload down to { url, fallback }', async () => {
    invokeMock.mockResolvedValue({ url: 'http://127.0.0.1:50001/mcp', requestedPort: 56463, fallback: true });

    const result = await new TauriPlatform().mcpEndpoint();

    expect(result).toEqual({ url: 'http://127.0.0.1:50001/mcp', fallback: true });
  });

  it('(c) mcpEndpoint resolves null when the host reports no endpoint', async () => {
    invokeMock.mockResolvedValue(null);
    expect(await new TauriPlatform().mcpEndpoint()).toBeNull();
  });

  it('(d) runCompilerTool POSTs to the resolved endpoint url', async () => {
    invokeMock.mockResolvedValue({ url: 'http://127.0.0.1:56463/mcp', requestedPort: 56463, fallback: false });
    mcpCallMock.mockResolvedValue('formatted');

    const out = await new TauriPlatform().runCompilerTool('koine_format', JSON.stringify({ source: 'context X {}' }));

    expect(mcpCallMock).toHaveBeenCalledWith('http://127.0.0.1:56463/mcp', 'koine_format', { source: 'context X {}' });
    expect(out).toBe('formatted');
  });

  it('(e) validateStagedWorkspace labels each file by relPath (single-root: bare labels)', async () => {
    invokeMock.mockResolvedValue({ url: 'http://127.0.0.1:56463/mcp', requestedPort: 56463, fallback: false });
    mcpCallMock.mockResolvedValue('{"ok":true,"errorCount":0,"warningCount":0,"diagnostics":[]}');
    const session = createEditSession({ 'a.koi': 'context A {}', 'b.koi': 'context B {}' });
    session.stage('a.koi', 'context A2 {}');

    await new TauriPlatform().validateStagedWorkspace(session);

    expect(mcpCallMock).toHaveBeenCalledWith('http://127.0.0.1:56463/mcp', 'koine_validate', {
      files: [
        { path: 'a.koi', source: 'context A2 {}' },
        { path: 'b.koi', source: 'context B {}' },
      ],
    });
  });

  it('(e) validateStagedWorkspace disambiguates colliding relPaths — two DISTINCT paths (#472)', async () => {
    invokeMock.mockResolvedValue({ url: 'http://127.0.0.1:56463/mcp', requestedPort: 56463, fallback: false });
    mcpCallMock.mockResolvedValue('{"ok":true,"errorCount":0,"warningCount":0,"diagnostics":[]}');
    // Two roots hold the SAME relPath: labelling both `model.koi` would send duplicate paths, which the
    // sidecar's validate rejects the same way the browser WASM's DiagnoseWorkspace does (a Uri-keyed
    // ToDictionary). The envelope must carry the tool layer's disambiguated display paths.
    const session = createEditSession(
      { 'file:///wsA/model.koi': 'context A {}', 'file:///wsB/model.koi': 'context B {}' },
      { 'file:///wsA/model.koi': 'model.koi', 'file:///wsB/model.koi': 'model.koi' },
    );

    await new TauriPlatform().validateStagedWorkspace(session);

    expect(mcpCallMock).toHaveBeenCalledWith('http://127.0.0.1:56463/mcp', 'koine_validate', {
      files: [
        { path: 'model.koi@1', source: 'context A {}' },
        { path: 'model.koi@2', source: 'context B {}' },
      ],
    });
  });
});
