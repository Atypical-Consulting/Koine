using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text.Json;
using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit;
using Koine.Compiler.Emit.Docs;
using Koine.Compiler.Emit.Glossary;
using Koine.Compiler.Emit.Grammar;
using Koine.Compiler.Formatting;
using Koine.Compiler.Services;

// Both Ast and Services declare a SymbolKind; the document-outline kind is the Services one.
using SymbolKind = Koine.Compiler.Services.SymbolKind;

namespace Koine.Wasm;

// IntelliSense & navigation surface of the in-browser language service: hover, completion,
// signature help, go-to-definition, document/workspace symbols, folding & selection ranges,
// code lenses, references, document highlights, and inlay hints. See CompilerInterop.LanguageService.cs.
[SupportedOSPlatform("browser")]
public static partial class CompilerInterop
{
    /// <summary>
    /// Hover at a 0-based position in <paramref name="activeUri"/>, resolved against the whole
    /// workspace. Returns an LSP <c>Hover</c> (<c>{ contents: { kind, value } }</c>) or the JSON
    /// literal <c>null</c> when there is nothing to show.
    /// </summary>
    [JSExport]
    public static string Hover(string filesJson, string activeUri, int line, int character)
    {
        try
        {
            var hover = LanguageService.HoverAt(GetWarmCompilation(DeserializeFiles(filesJson)), activeUri, line, character);
            var dto = hover is null ? null : new WHoverResult(new WMarkupContent("markdown", hover.Markdown));
            return JsonSerializer.Serialize(dto, LangJson.Default.WHoverResult);
        }
        catch
        {
            return "null";
        }
    }

    /// <summary>
    /// IntelliSense completions at a 0-based position in <paramref name="activeUri"/>. Single-file
    /// and lexer-only (tolerant of broken documents), mirroring the desktop LSP's
    /// <c>textDocument/completion</c>; returns an LSP-style <c>{ isIncomplete, items[] }</c> list.
    /// </summary>
    [JSExport]
    public static string Completions(string filesJson, string activeUri, int line, int character)
    {
        try
        {
            var docs = DeserializeFiles(filesJson).ToDictionary(f => f.Uri, f => f.Text, StringComparer.Ordinal);
            if (!docs.TryGetValue(activeUri, out var text))
            {
                return SerializeCompletions(new WCompletionList(false, []));
            }

            var items = LanguageService.CompleteAt(text, line, character)
                .Select(i => new WCompletionItem(
                    i.Label, LspCompletionKind(i.Kind), i.Detail, i.Documentation,
                    i.InsertText, i.InsertTextFormat,
                    i.CommitCharacters?.ToArray(), i.SortText, i.Data))
                .ToArray();
            return SerializeCompletions(new WCompletionList(false, items));
        }
        catch
        {
            return SerializeCompletions(new WCompletionList(false, []));
        }
    }

    /// <summary>
    /// Signature help at a 0-based position in <paramref name="activeUri"/>. Mirrors the desktop LSP's
    /// <c>textDocument/signatureHelp</c>: returns an LSP <c>SignatureHelp</c>
    /// (<c>{ signatures, activeSignature, activeParameter }</c>) or the JSON literal <c>null</c>.
    /// </summary>
    [JSExport]
    public static string SignatureHelp(string filesJson, string activeUri, int line, int character)
    {
        try
        {
            var help = LanguageService.SignatureHelpAt(GetWarmCompilation(DeserializeFiles(filesJson)), activeUri, line, character);
            if (help is null)
            {
                return "null";
            }

            var signatures = help.Signatures
                .Select(s => new WSignatureInfo(
                    s.Label,
                    s.Parameters.Select(p => new WParameterInfo(p.Label)).ToArray()))
                .ToArray();
            var dto = new WSignatureHelp(signatures, help.ActiveSignature, help.ActiveParameter);
            return JsonSerializer.Serialize(dto, LangJson.Default.WSignatureHelp);
        }
        catch
        {
            return "null";
        }
    }

    /// <summary>
    /// Go-to-definition at a 0-based position in <paramref name="activeUri"/>. Returns an LSP
    /// <c>Location</c> (<c>{ uri, range }</c>) — possibly in another file — or the JSON literal
    /// <c>null</c>.
    /// </summary>
    [JSExport]
    public static string Definition(string filesJson, string activeUri, int line, int character)
    {
        try
        {
            var def = LanguageService.DefinitionAt(GetWarmCompilation(DeserializeFiles(filesJson)), activeUri, line, character);
            var dto = def is null ? null : new WLocation(def.Uri, SpanRange(def.Target));
            return JsonSerializer.Serialize(dto, LangJson.Default.WLocation);
        }
        catch
        {
            return "null";
        }
    }

    /// <summary>Document outline (a single-file <c>DocumentSymbol</c> tree) for <paramref name="source"/>.</summary>
    [JSExport]
    public static string DocumentSymbols(string source)
    {
        try
        {
            var symbols = LanguageService.DocumentSymbols(source).Select(ToLspSymbol).ToArray();
            return JsonSerializer.Serialize(symbols, LangJson.Default.WDocumentSymbolArray);
        }
        catch
        {
            return "[]";
        }
    }

    /// <summary>
    /// A flat, workspace-wide symbol search (LSP <c>workspace/symbol</c>): every declaration across the
    /// merged workspace whose name case-insensitively subsequence-matches <paramref name="query"/>
    /// (an empty query returns all). Returns a JSON <c>SymbolInformation[]</c>. Parity with the stdio LSP.
    /// </summary>
    [JSExport]
    public static string WorkspaceSymbols(string filesJson, string query)
    {
        try
        {
            // Warm path (issue #464): reuse the reconciled snapshot's Documents map — no re-parse.
            var symbols = LanguageService.WorkspaceSymbols(GetWarmCompilation(DeserializeFiles(filesJson)), query)
                .Select(s => new WWorkspaceSymbol(s.Name, LspSymbolKind(s.Kind), s.Uri, SpanRange(s.Range), s.ContainerName))
                .ToArray();
            return JsonSerializer.Serialize(symbols, LangJson.Default.WWorkspaceSymbolArray);
        }
        catch
        {
            return "[]";
        }
    }

    /// <summary>
    /// The collapsible regions of <paramref name="source"/> (LSP <c>textDocument/foldingRange</c>):
    /// one <c>{ startLine, endLine }</c> (0-based, both inclusive) per multi-line block declaration.
    /// Returns a JSON <c>FoldingRange[]</c>. Parity with the stdio LSP.
    /// </summary>
    [JSExport]
    public static string FoldingRanges(string source)
    {
        try
        {
            var folds = LanguageService.FoldingRanges(source)
                .Select(f => new WFoldingRange(
                    Math.Max(0, f.Range.Line - 1),
                    Math.Max(Math.Max(0, f.Range.Line - 1), f.Range.EndLine - 1)))
                .ToArray();
            return JsonSerializer.Serialize(folds, LangJson.Default.WFoldingRangeArray);
        }
        catch
        {
            return "[]";
        }
    }

    /// <summary>
    /// The selection-range chains for a set of positions (LSP <c>textDocument/selectionRange</c>):
    /// <paramref name="positionsJson"/> is a JSON array of <c>{ line, character }</c> (0-based), and
    /// the result is a parallel JSON array of nested <c>{ range, parent? }</c> chains. Parity with the
    /// stdio LSP.
    /// </summary>
    [JSExport]
    public static string SelectionRanges(string source, string positionsJson)
    {
        try
        {
            var positions = JsonSerializer.Deserialize(positionsJson, LangJson.Default.WInPositionArray) ?? [];
            var chains = positions
                .Select(p => ToLspSelectionRange(LanguageService.SelectionRangeAt(source, p.Line, p.Character)))
                .ToArray();
            return JsonSerializer.Serialize(chains, LangJson.Default.WSelectionRangeArray);
        }
        catch
        {
            return "[]";
        }
    }

    /// <summary>
    /// The code lenses of the active document (LSP <c>textDocument/codeLens</c>): one per top-level
    /// declaration, annotated with a <c>"N references"</c> reference-count title. <paramref name="filesJson"/>
    /// is the merged workspace (so cross-file references resolve) and <paramref name="activeUri"/> the
    /// document to lens. The title is computed eagerly. Returns a JSON <c>CodeLens[]</c>. Parity with
    /// the stdio LSP.
    /// </summary>
    [JSExport]
    public static string CodeLenses(string filesJson, string activeUri)
    {
        try
        {
            var lenses = LanguageService.CodeLenses(GetWarmCompilation(DeserializeFiles(filesJson)), activeUri)
                .Select(l => new WCodeLens(SpanRange(l.Range), l.Title))
                .ToArray();
            return JsonSerializer.Serialize(lenses, LangJson.Default.WCodeLensArray);
        }
        catch
        {
            return "[]";
        }
    }

    /// <summary>
    /// Every reference to the name at a 0-based position in <paramref name="activeUri"/>, across the
    /// merged workspace (declaration included). Returns a JSON <c>Location[]</c> — empty when the
    /// cursor is not on a renameable type/enum-member/spec name. Parity with the stdio LSP's
    /// <c>textDocument/references</c>.
    /// </summary>
    [JSExport]
    public static string References(string filesJson, string activeUri, int line, int character)
    {
        try
        {
            var refs = LanguageService.ReferencesAt(GetWarmCompilation(DeserializeFiles(filesJson)), activeUri, line, character)
                .Select(r => new WLocation(r.Uri, RangeOf(r)))
                .ToArray();
            return JsonSerializer.Serialize(refs, LangJson.Default.WLocationArray);
        }
        catch
        {
            return "[]";
        }
    }

    /// <summary>
    /// Same-file occurrence highlights for the name at a 0-based position in <paramref name="activeUri"/>
    /// (LSP <c>textDocument/documentHighlight</c>): a JSON array of <c>{ range, kind }</c>. Reuses the
    /// <c>ReferencesAt</c> binder filtered to the active document — <see cref="Reference"/> carries no
    /// read/write distinction, so every highlight is <c>DocumentHighlightKind.Text</c> (1). Parity with
    /// the stdio LSP's <c>DocumentHighlightResultJson</c>.
    /// </summary>
    [JSExport]
    public static string DocumentHighlightsAt(string filesJson, string activeUri, int line, int character)
    {
        try
        {
            var highlights = LanguageService.ReferencesAt(GetWarmCompilation(DeserializeFiles(filesJson)), activeUri, line, character)
                .Where(r => string.Equals(r.Uri, activeUri, StringComparison.Ordinal))
                .Select(r => new WDocumentHighlight(RangeOf(r), 1)) // LSP DocumentHighlightKind.Text
                .ToArray();
            return JsonSerializer.Serialize(highlights, LangJson.Default.WDocumentHighlightArray);
        }
        catch
        {
            return "[]";
        }
    }

    /// <summary>
    /// Inlay hints over the 0-based range in <paramref name="activeUri"/> (LSP <c>textDocument/inlayHint</c>):
    /// a JSON array of <c>{ position, label, kind }</c>, kind 1=Type/2=Parameter, positions 0-based.
    /// Parity with the stdio LSP's <c>InlayHintResultJson</c>.
    /// </summary>
    [JSExport]
    public static string InlayHints(
        string filesJson, string activeUri, int startLine, int startChar, int endLine, int endChar)
    {
        try
        {
            var comp = GetWarmCompilation(DeserializeFiles(filesJson));
            var hints = LanguageService.InlayHintsAt(comp, activeUri, startLine, startChar, endLine, endChar)
                .Select(h => new WInlayHint(
                    new WPosition(h.Line, h.Character),
                    h.Label,
                    h.Kind == InlayHintKind.Type ? 1 : 2)) // LSP InlayHintKind: Type=1, Parameter=2
                .ToArray();
            return JsonSerializer.Serialize(hints, LangJson.Default.WInlayHintArray);
        }
        catch
        {
            return "[]";
        }
    }

    private static string SerializeCompletions(WCompletionList r) =>
        JsonSerializer.Serialize(r, LangJson.Default.WCompletionList);

    /// <summary>Maps a Koine completion kind to the numeric LSP <c>CompletionItemKind</c> (mirrors LspServer).</summary>
    private static int LspCompletionKind(CompletionItemKind kind) => kind switch
    {
        CompletionItemKind.Keyword => 14,
        CompletionItemKind.Class => 7,
        CompletionItemKind.Enum => 13,
        CompletionItemKind.EnumMember => 20,
        CompletionItemKind.Field => 5,
        CompletionItemKind.Property => 10,
        CompletionItemKind.Method => 2,
        _ => 1,
    };

    private static WDocumentSymbol ToLspSymbol(DocumentSymbol s)
    {
        var selection = s.SelectionRange.IsNone ? s.Range : s.SelectionRange;
        return new WDocumentSymbol(
            s.Name,
            LspSymbolKind(s.Kind),
            SpanRange(s.Range),
            SpanRange(selection),
            s.Children.Select(ToLspSymbol).ToArray());
    }

    private static WSelectionRange ToLspSelectionRange(SelectionRange? chain)
    {
        // A null chain still yields a degenerate selection range (empty range at doc start) so the
        // result array stays parallel to the requested positions.
        if (chain is null)
        {
            return new WSelectionRange(SpanRange(SourceSpan.None), null);
        }

        return new WSelectionRange(
            SpanRange(chain.Range),
            chain.Parent is null ? null : ToLspSelectionRange(chain.Parent));
    }

    private static int LspSymbolKind(SymbolKind kind) => kind switch
    {
        SymbolKind.Namespace => 3,
        SymbolKind.Class => 5,
        SymbolKind.Enum => 10,
        SymbolKind.EnumMember => 22,
        SymbolKind.Field => 8,
        SymbolKind.Method => 6,
        SymbolKind.Constructor => 9,
        SymbolKind.Interface => 11,
        SymbolKind.Struct => 23,
        _ => 13, // Variable
    };

}
