using Koine.Compiler.Ast;
using Koine.Compiler.Emit.Glossary;

namespace Koine.Compiler.Services;

/// <summary>One text edit with a 1-based, end-exclusive <see cref="SourceSpan"/> range and its replacement text.</summary>
public sealed record DocTextEdit(SourceSpan Range, string NewText);

/// <summary>
/// The outcome of a set-doc request: the <see cref="Uri"/> (file) the edits apply to, and the
/// <see cref="Edits"/> (empty when the id is unknown, or when clearing an already-undocumented node).
/// </summary>
public sealed record DocEditResult(string? Uri, IReadOnlyList<DocTextEdit> Edits);

/// <summary>
/// Produces the localized text edit that sets a glossary declaration's <c>///</c> doc comment (#67),
/// addressed by the same qualified id <see cref="GlossaryModelBuilder"/> assigns. Three cases:
/// <list type="bullet">
///   <item>no existing doc + prose → <b>insert</b> a <c>///</c> block immediately above the declaration;</item>
///   <item>existing doc + prose → <b>replace</b> the whole <c>///</c> block;</item>
///   <item>existing doc + empty prose → <b>clear</b> the block.</item>
/// </list>
/// Touches LEADING TRIVIA only (never code), so it is the low-risk write path that needs no full
/// model→.koi round-trip. The new comment is indented to match the declaration, one <c>///</c> line
/// per prose line.
/// </summary>
public static class SetDocEditor
{
    public static DocEditResult Build(
        KoineModel model, IReadOnlyList<SourceFile> files, string id, string description)
    {
        KoineNode? node = GlossaryModelBuilder.Walk(model).FirstOrDefault(w => w.QualifiedName == id).Node;
        if (node is null)
        {
            return new DocEditResult(null, Array.Empty<DocTextEdit>());
        }

        // Resolve the source text + path the declaration lives in (fall back to the first file for
        // the single-document case, where the parser may not have stamped a span File).
        string? usedPath = null;
        string? source = null;
        var file = node.Span.File;
        if (file is not null)
        {
            foreach (var f in files)
            {
                if (f.Path == file)
                {
                    source = f.Source;
                    usedPath = f.Path;
                    break;
                }
            }
        }

        if (source is null && files.Count > 0)
        {
            source = files[0].Source;
            usedPath = files[0].Path;
        }

        if (source is null)
        {
            return new DocEditResult(usedPath, Array.Empty<DocTextEdit>());
        }

        // Match the file's existing newline convention so a CRLF source never gets bare-LF doc
        // lines (which would leave the .koi with mixed endings on the LSP/Windows path).
        var lineEnding = source.Contains("\r\n") ? "\r\n" : "\n";
        var indent = LeadingWhitespace(source, node.Span.Line);
        var proseLines = NormalizeProse(description);
        var docPieces = node.LeadingTrivia.Where(t => t.Kind == SyntaxTriviaKind.Doc).ToList();

        // Where to write: replace the existing doc-comment line range, or insert above the declaration.
        SourceSpan range;
        if (docPieces.Count > 0)
        {
            int firstLine = docPieces.Min(p => p.Span.Line);
            int lastLine = docPieces.Max(p => p.Span.Line);
            range = new SourceSpan(firstLine, 1, lastLine + 1, 1, 0, 0, usedPath);
        }
        else if (proseLines.Count == 0)
        {
            // Nothing to clear and nothing to add.
            return new DocEditResult(usedPath, Array.Empty<DocTextEdit>());
        }
        else
        {
            range = new SourceSpan(node.Span.Line, 1, node.Span.Line, 1, 0, 0, usedPath);
        }

        var newText = string.Concat(proseLines.Select(line => $"{indent}/// {line}{lineEnding}"));
        return new DocEditResult(usedPath, new[] { new DocTextEdit(range, newText) });
    }

    /// <summary>The leading spaces/tabs of the (1-based) <paramref name="line"/> in <paramref name="source"/>.</summary>
    private static string LeadingWhitespace(string source, int line)
    {
        var lines = source.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
        if (line - 1 < 0 || line - 1 >= lines.Length)
        {
            return string.Empty;
        }

        var text = lines[line - 1];
        int i = 0;
        while (i < text.Length && (text[i] == ' ' || text[i] == '\t'))
        {
            i++;
        }

        return text[..i];
    }

    /// <summary>Splits prose into trimmed, non-blank-edged lines (empty when the prose is blank — a clear).</summary>
    private static List<string> NormalizeProse(string? description)
    {
        var lines = (description ?? string.Empty)
            .Replace("\r\n", "\n").Replace('\r', '\n')
            .Split('\n')
            .Select(l => l.Trim())
            .ToList();

        while (lines.Count > 0 && lines[0].Length == 0)
        {
            lines.RemoveAt(0);
        }

        while (lines.Count > 0 && lines[^1].Length == 0)
        {
            lines.RemoveAt(lines.Count - 1);
        }

        return lines;
    }
}
