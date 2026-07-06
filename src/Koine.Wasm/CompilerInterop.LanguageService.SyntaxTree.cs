using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text.Json;
using Koine.Compiler.Ast;
using Koine.Compiler.Services;

namespace Koine.Wasm;

// The active-buffer syntax-tree projection (issue #890): the browser counterpart of the desktop
// koine/syntaxTree LSP request. Mirrors the CodeLenses/DocumentSymbols shape in Navigation.cs.
[SupportedOSPlatform("browser")]
public static partial class CompilerInterop
{
    /// <summary>
    /// The parse/syntax tree of the active buffer <paramref name="activeUri"/> across the merged
    /// <paramref name="filesJson"/> workspace: the warm compilation's per-file syntax root projected into
    /// a recursive <see cref="WSyntaxNode"/> (<c>{ kind, name, span, isMissing, isError, leaf, children }</c>),
    /// or the JSON literal <c>null</c> when the document is absent. Same wire shape as the stdio LSP's
    /// <c>koine/syntaxTree</c>, so Koine Studio's syntax-tree panel consumes both hosts unchanged.
    /// </summary>
    [JSExport]
    public static string SyntaxTree(string filesJson, string activeUri)
    {
        try
        {
            var node = LanguageService.SyntaxTree(GetWarmCompilation(DeserializeFiles(filesJson)), activeUri);
            var dto = node is null ? null : ToWSyntaxNode(node);
            return JsonSerializer.Serialize(dto, LangJson.Default.WSyntaxNode);
        }
        catch
        {
            return "null";
        }
    }

    /// <summary>Recursively projects a <see cref="SyntaxTreeNode"/> into its flat wire <see cref="WSyntaxNode"/>.</summary>
    private static WSyntaxNode ToWSyntaxNode(SyntaxTreeNode node) => new(
        node.Kind,
        node.Name,
        ToWSyntaxSpan(node.Span),
        node.IsMissing,
        node.IsError,
        node.Leaf,
        node.Children.Select(ToWSyntaxNode).ToArray());

    /// <summary>
    /// Converts a raw (1-based, end-EXCLUSIVE) <see cref="SourceSpan"/> to the shared flat
    /// <see cref="WSourceSpan"/> — source coordinates, NOT a 0-based LSP range. Reuses the diagram
    /// graph's span DTO (#290) so the syntax tree carries no duplicate span shape (#1099); the
    /// all-zero root span stays a non-null value (unlike the diagram's nullable <c>MapSourceSpan</c>).
    /// </summary>
    private static WSourceSpan ToWSyntaxSpan(SourceSpan span) => new(
        span.File, span.Line, span.Column, span.EndLine, span.EndColumn, span.Offset, span.Length);
}
