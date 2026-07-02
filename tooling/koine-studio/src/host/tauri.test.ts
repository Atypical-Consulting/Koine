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
});
