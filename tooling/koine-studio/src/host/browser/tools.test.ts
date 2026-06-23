import { describe, expect, test, vi } from 'vitest';

// Mock the WASM loader so the dispatch is testable without booting the .NET runtime. Each export is
// a spy that returns canned JSON in the camelCase shapes CompilerInterop emits.
const api = vi.hoisted(() => ({
  DiagnoseWorkspace: vi.fn<(f: string) => string>(),
  EmitPreview: vi.fn<(f: string, t: string) => string>(),
  Format: vi.fn<(s: string) => string>(),
}));
vi.mock('@/host/browser/wasm', () => ({ loadWasmApi: () => Promise.resolve(api) }));

import { runWasmTool } from '@/host/browser/tools';

describe('runWasmTool', () => {
  test('koine_validate wraps source into the workspace envelope and summarizes diagnostics', async () => {
    api.DiagnoseWorkspace.mockReturnValue(JSON.stringify([{ uri: 'file:///model.koi', diagnostics: [] }]));
    const out = await runWasmTool('koine_validate', JSON.stringify({ source: 'context X {}' }));

    const sentFiles = JSON.parse(api.DiagnoseWorkspace.mock.calls[0][0]);
    expect(sentFiles).toEqual([{ uri: 'file:///model.koi', text: 'context X {}' }]);
    expect(out).toContain('ok: true');
  });

  test('koine_compile defaults an invalid target to csharp and returns files', async () => {
    api.EmitPreview.mockReturnValue(JSON.stringify({ target: 'csharp', files: [{ path: 'X.cs', contents: 'class X{}' }], diagnostics: [], error: null }));
    const out = await runWasmTool('koine_compile', JSON.stringify({ source: 'context X {}', target: 'rust' }));

    expect(api.EmitPreview.mock.calls[0][1]).toBe('csharp'); // 'rust' is not WASM-backed → csharp
    expect(out).toContain('X.cs');
  });

  test('koine_compile passes a valid target through', async () => {
    api.EmitPreview.mockReturnValue(JSON.stringify({ target: 'typescript', files: [], diagnostics: [], error: null }));
    await runWasmTool('koine_compile', JSON.stringify({ source: 's', target: 'typescript' }));
    const calls = api.EmitPreview.mock.calls;
    expect(calls[calls.length - 1][1]).toBe('typescript');
  });

  test('koine_format returns the formatted newText, or the source when already canonical', async () => {
    api.Format.mockReturnValueOnce(JSON.stringify([{ range: {}, newText: 'context X {}\n' }]));
    expect(await runWasmTool('koine_format', JSON.stringify({ source: 'context X{}' }))).toBe('context X {}\n');

    api.Format.mockReturnValueOnce('[]');
    expect(await runWasmTool('koine_format', JSON.stringify({ source: 'already' }))).toBe('already');
  });

  test('malformed args resolve to an error string (no throw)', async () => {
    expect(await runWasmTool('koine_validate', 'not json')).toContain('Error');
  });

  test('an unknown tool resolves to an error string', async () => {
    expect(await runWasmTool('koine_nope', '{}')).toContain('unknown tool');
  });
});
