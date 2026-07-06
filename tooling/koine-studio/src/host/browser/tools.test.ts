import { describe, expect, test, vi } from 'vitest';

// Mock the WASM loader so the dispatch is testable without booting the .NET runtime. Each export is
// a spy that returns canned JSON in the camelCase shapes CompilerInterop emits.
const api = vi.hoisted(() => ({
  DiagnoseWorkspace: vi.fn<(f: string) => string>(),
  EmitPreview: vi.fn<(f: string, t: string) => string>(),
  Format: vi.fn<(s: string) => string>(),
}));
vi.mock('@/host/browser/wasm', () => ({ loadWasmApi: () => Promise.resolve(api) }));

import { runEditTool, runWasmTool, validateStagedWorkspace } from '@/host/browser/tools';
import { createEditSession } from '@/ai/editSession';

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
    const out = await runWasmTool('koine_compile', JSON.stringify({ source: 'context X {}', target: 'cobol' }));

    expect(api.EmitPreview.mock.calls[0][1]).toBe('csharp'); // 'cobol' is not a supported target → csharp
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

describe('runEditTool', () => {
  test('koine_list_files returns the session relPaths', async () => {
    const session = createEditSession({ 'a.koi': 'context A {}', 'b.koi': 'context B {}' });
    const out = await runEditTool('koine_list_files', '{}', session);
    expect(out).toContain('a.koi');
    expect(out).toContain('b.koi');
  });

  test('koine_read_file returns the current body, then the staged body after a write', async () => {
    api.DiagnoseWorkspace.mockReturnValue(JSON.stringify([{ uri: 'file:///a.koi', diagnostics: [] }]));
    const session = createEditSession({ 'a.koi': 'context A {}' });

    // Reads through to the initial (current) body.
    expect(await runEditTool('koine_read_file', JSON.stringify({ relPath: 'a.koi' }), session)).toContain('context A {}');

    // After a write, read returns the STAGED body (proving the write staged it — there is no disk here).
    await runEditTool('koine_write_file', JSON.stringify({ relPath: 'a.koi', contents: 'context A2 {}' }), session);
    expect(await runEditTool('koine_read_file', JSON.stringify({ relPath: 'a.koi' }), session)).toContain('context A2 {}');
  });

  test('koine_write_file is STAGE-ONLY — it stages a body without validating (issue #474)', async () => {
    api.DiagnoseWorkspace.mockClear(); // the shared spy accumulates across tests — isolate this count
    const session = createEditSession({ 'a.koi': 'context A {}', 'b.koi': 'context B {}' });

    const out = await runEditTool('koine_write_file', JSON.stringify({ relPath: 'a.koi', contents: 'context A2 {}' }), session);

    // No per-write compile — DiagnoseWorkspace is NOT touched, and the result is ONLY the staged
    // confirmation (the whole-workspace validation now runs once per turn via validateStagedWorkspace).
    expect(api.DiagnoseWorkspace).not.toHaveBeenCalled();
    expect(out).toBe('staged changes to a.koi (not yet written to disk).');
    expect(out).not.toContain('ok:');
  });

  test('validateStagedWorkspace validates the WHOLE staged workspace once (turn-scoped, issue #474)', async () => {
    api.DiagnoseWorkspace.mockClear(); // the shared spy accumulates across tests — isolate this count
    api.DiagnoseWorkspace.mockReturnValue(JSON.stringify([{ uri: 'file:///a.koi', diagnostics: [] }]));
    const session = createEditSession({ 'a.koi': 'context A {}', 'b.koi': 'context B {}' });

    // Stage a write (stage-only), then run the once-per-turn validation explicitly.
    await runEditTool('koine_write_file', JSON.stringify({ relPath: 'a.koi', contents: 'context A2 {}' }), session);
    const out = await validateStagedWorkspace(session);

    // The validate call carried the FULL staged workspace: every relPath the session knows, with the
    // staged body for the written file (a.koi) and the initial body for the untouched one (b.koi).
    expect(api.DiagnoseWorkspace).toHaveBeenCalledTimes(1);
    const sentFiles = JSON.parse(api.DiagnoseWorkspace.mock.calls[0][0]);
    expect(sentFiles).toEqual([
      { uri: 'file:///a.koi', text: 'context A2 {}' },
      { uri: 'file:///b.koi', text: 'context B {}' },
    ]);
    expect(out).toContain('ok: true');
  });

  test('validateStagedWorkspace labels the envelope by relPath, not by opaque session key (#472)', async () => {
    api.DiagnoseWorkspace.mockClear();
    api.DiagnoseWorkspace.mockReturnValue(JSON.stringify([{ uri: 'file:///model.koi', diagnostics: [] }]));
    // A uri-keyed session (multi-root, #472) plus a brand-new file staged through the executor (which
    // mints a `new:`-prefixed key): the envelope must carry each file's RELPATH label, never the key.
    const session = createEditSession({ 'mem://a/model.koi': 'context A {}' }, { 'mem://a/model.koi': 'model.koi' });
    await runEditTool('koine_write_file', JSON.stringify({ relPath: 'events.koi', contents: 'context E {}' }), session);

    await validateStagedWorkspace(session);
    const sentFiles = JSON.parse(api.DiagnoseWorkspace.mock.calls[0][0]);
    expect(sentFiles).toEqual([
      { uri: 'file:///model.koi', text: 'context A {}' },
      { uri: 'file:///events.koi', text: 'context E {}' },
    ]);
  });

  test('validateStagedWorkspace disambiguates colliding relPaths — two DISTINCT envelope uris (#472)', async () => {
    api.DiagnoseWorkspace.mockClear();
    api.DiagnoseWorkspace.mockReturnValue(JSON.stringify([{ uri: 'file:///model.koi@1', diagnostics: [] }]));
    // Two roots hold the SAME relPath: labelling both entries `file:///model.koi` would send duplicate
    // uris, which Koine.Wasm's DiagnoseWorkspace rejects (files.ToDictionary(f => f.Uri) throws) — so
    // every multi-root staged validation would crash into a "(validation failed)" diagnostic. The
    // envelope must carry the tool layer's disambiguated display paths instead.
    const session = createEditSession(
      { 'file:///wsA/model.koi': 'context A {}', 'file:///wsB/model.koi': 'context B {}' },
      { 'file:///wsA/model.koi': 'model.koi', 'file:///wsB/model.koi': 'model.koi' },
    );
    await validateStagedWorkspace(session);
    const sentFiles = JSON.parse(api.DiagnoseWorkspace.mock.calls[0][0]);
    expect(sentFiles).toEqual([
      { uri: 'file:///model.koi@1', text: 'context A {}' },
      { uri: 'file:///model.koi@2', text: 'context B {}' },
    ]);
  });

  test('koine_write_file with a NEW relPath reports it as a new file', async () => {
    api.DiagnoseWorkspace.mockReturnValue(JSON.stringify([{ uri: 'file:///new.koi', diagnostics: [] }]));
    const session = createEditSession({ 'a.koi': 'context A {}' });

    const out = await runEditTool('koine_write_file', JSON.stringify({ relPath: 'new.koi', contents: 'context N {}' }), session);
    expect(out).toContain('staged new file new.koi');
  });

  test('an unsafe relPath resolves to an Error string (no throw)', async () => {
    const session = createEditSession({ 'a.koi': 'context A {}' });
    expect(await runEditTool('koine_read_file', JSON.stringify({ relPath: '../escape.koi' }), session)).toContain('Error');
    expect(await runEditTool('koine_write_file', JSON.stringify({ relPath: '/abs.koi', contents: 'x' }), session)).toContain('Error');
  });

  test('an unknown tool resolves to an Error string', async () => {
    const session = createEditSession({});
    expect(await runEditTool('koine_nope', '{}', session)).toContain('Error');
  });
});
