using System.Runtime.Versioning;
using System.Text.Json;
using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Wasm;

/// <summary>
/// The browser language-service surface of the Koine compiler — the in-browser counterpart of
/// the stdio LSP server (<c>src/Koine.Cli/LspServer.cs</c>). Each method is stateless: the caller
/// (Koine Studio's browser backend) passes the full open-document snapshot as JSON on every call,
/// and the method returns a JSON payload shaped exactly like the corresponding LSP response so the
/// TypeScript client (<c>tooling/koine-studio/src/lsp.ts</c>) can consume it unchanged.
///
/// <para>This mirrors a subset of <c>Koine.Cli</c>'s <c>LspServer</c> handlers — the nine
/// requests Koine Studio actually uses — reusing the same <see cref="KoineCompiler"/>,
/// <see cref="KoineLanguageService"/>, <see cref="KoineFormatter"/>, emitters and
/// <see cref="CompatibilityChecker"/>. The LSP <c>koine.config</c>-driven per-target options are
/// not applied here (no filesystem in the browser), matching the docs-site Playground.</para>
///
/// <para>All DTOs are source-generated (trim-safe under <c>TrimMode=full</c>) and camelCased to
/// match the protocol shapes declared in <c>lsp.ts</c>.</para>
/// </summary>
/// <remarks>Browser-only, like the rest of this assembly — see the partial in
/// <c>CompilerInterop.cs</c> for why <see cref="SupportedOSPlatformAttribute"/> is applied.</remarks>
[SupportedOSPlatform("browser")]
public static partial class CompilerInterop
{
    private static readonly KoineLanguageService LanguageService = new();

    // Held statically like LanguageService — the classifier reuses its own KoineCompiler across calls.
    private static readonly SemanticTokenProvider SemanticProvider = new();

    private static IReadOnlyList<WSourceFileDto> DeserializeFiles(string filesJson) =>
        JsonSerializer.Deserialize(filesJson, LangJson.Default.WSourceFileDtoArray) ?? [];

    private static IReadOnlyList<WSourceFileDto> TryDeserializeFiles(string filesJson)
    {
        try
        { return DeserializeFiles(filesJson); }
        catch { return []; }
    }

    // ---- warm/incremental compilation (issue #334) --------------------------------------------------
    // Every LSP-shaped export is stateless by contract: the browser backend passes the full
    // open-document snapshot as JSON on each call. Re-building the model cold on every keystroke costs
    // O(files) re-parses even for a one-character edit on a multi-file domain. So we retain the LAST
    // KoineCompilation (issue #70's immutable, per-file content-hashed snapshot) and reconcile it to
    // each incoming snapshot: an unchanged file keeps its already-parsed unit by reference and only the
    // edited file re-parses.
    //
    // Correctness: this is pure CONTENT-keyed memoization, never a mutable "session". The reconcile
    // engine (KoineCompilation.Reconcile) re-parses on any text difference and reproduces a cold build's
    // first-seen order, so the warm snapshot is byte-identical to KoineCompilation.Create(files) of the
    // same inputs — every handler returns exactly what the stateless path would (WasmWarmCompilationTests
    // proves it). The browser runtime is single-threaded (WasmEnableThreads=false) and no two [JSExport]
    // calls run concurrently, so a plain static field needs no locking.

    /// <summary>The retained warm snapshot — an LRU of size 1 (the most recently reconciled snapshot).</summary>
    private static KoineCompilation? _warm;

    /// <summary>
    /// Upper bounds on what is RETAINED between calls, so a pathological workspace can't pin unbounded
    /// heap in the single-threaded browser. A snapshot past either cap is still served for the current
    /// call but not kept warm (the next call rebuilds cold). Generous for real domains — the six-context
    /// pizzeria template is ~6 files / a few KB.
    /// </summary>
    private const int MaxWarmDocuments = 256;
    private const int MaxWarmChars = 8 * 1024 * 1024;

    /// <summary>
    /// Resolves the warm <see cref="KoineCompilation"/> for the open-document set <paramref name="files"/>:
    /// reconciles the held snapshot to it (re-parsing only changed/new files, dropping removed ones) and
    /// retains the result when it is within bound. The returned snapshot is byte-identical to a cold
    /// <see cref="KoineCompilation.Create(System.Collections.Generic.IReadOnlyList{SourceFile})"/>, so
    /// substituting it at the stateless call sites cannot change any handler's result.
    /// </summary>
    private static KoineCompilation GetWarmCompilation(IReadOnlyList<WSourceFileDto> files)
    {
        // One pass: materialize the SourceFiles and measure the retained size for the bound.
        var sources = new List<SourceFile>(files.Count);
        long totalChars = 0;
        foreach (var f in files)
        {
            sources.Add(new SourceFile(f.Uri, f.Text));
            totalChars += f.Text.Length;
        }

        var comp = KoineCompilation.Reconcile(_warm, sources);

        // Retain as the warm snapshot only when small enough to keep on the single-threaded browser
        // heap; a workspace past either cap is still served for this call but rebuilt cold next time.
        _warm = files.Count <= MaxWarmDocuments && totalChars <= MaxWarmChars ? comp : null;
        return comp;
    }

    /// <summary>Converts a 1-based, end-EXCLUSIVE <see cref="SourceSpan"/> to a 0-based LSP range.</summary>
    private static WRange SpanRange(SourceSpan span) => new(
        new WPosition(Math.Max(0, span.Line - 1), Math.Max(0, span.Column - 1)),
        new WPosition(Math.Max(0, span.EndLine - 1), Math.Max(0, span.EndColumn - 1)));

    /// <summary>Converts a <see cref="Reference"/> (1-based line, 0-based columns) to a 0-based LSP range.</summary>
    private static WRange RangeOf(Reference r)
    {
        var line = Math.Max(0, r.Line - 1);
        return new WRange(new WPosition(line, r.StartColumn), new WPosition(line, r.EndColumn));
    }

    private static string[] SplitLines(string text) =>
        text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');

}
