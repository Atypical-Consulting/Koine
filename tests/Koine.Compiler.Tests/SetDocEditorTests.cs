using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// The doc-comment edit producer (#67): given a glossary id and prose, it returns the localized
/// text edit that inserts/replaces/clears the declaration's <c>///</c> block — touching leading
/// trivia only. Tests assert by APPLYING the returned edits to the source and checking the result.
/// </summary>
public class SetDocEditorTests
{
    private static (Ast.KoineModel Model, SourceFile[] Files) Parse(string src)
    {
        var files = new[] { new SourceFile("t.koi", src) };
        return (new KoineCompiler().Parse(files).Model!, files);
    }

    private static string Apply(string src, IReadOnlyList<DocTextEdit> edits)
    {
        foreach (var e in edits.OrderByDescending(e => (e.Range.Line, e.Range.Column)))
        {
            int start = Offset(src, e.Range.Line, e.Range.Column);
            int end = Offset(src, e.Range.EndLine, e.Range.EndColumn);
            src = src[..start] + e.NewText + src[end..];
        }

        return src;
    }

    private static int Offset(string src, int line, int col)
    {
        int offset = 0;
        for (int cur = 1; cur < line; cur++)
        {
            offset = src.IndexOf('\n', offset) + 1;
        }

        return offset + (col - 1);
    }

    [Fact]
    public void Inserts_doc_above_declaration_when_absent()
    {
        var (model, files) = Parse("context C {\n  value Money { amount: Decimal }\n}\n");
        var result = SetDocEditor.Build(model, files, "C.Money", "A monetary amount.");

        Assert.Equal("t.koi", result.Uri);
        Assert.Contains("  /// A monetary amount.\n  value Money", Apply(files[0].Source, result.Edits));
    }

    [Fact]
    public void Replaces_existing_doc_block()
    {
        var (model, files) = Parse("context C {\n  /// old\n  value Money { amount: Decimal }\n}\n");
        var applied = Apply(files[0].Source, SetDocEditor.Build(model, files, "C.Money", "new desc").Edits);

        Assert.Contains("/// new desc", applied);
        Assert.DoesNotContain("/// old", applied);
    }

    [Fact]
    public void Multiline_prose_becomes_multiple_slash_lines()
    {
        var (model, files) = Parse("context C {\n  value Money { amount: Decimal }\n}\n");
        var applied = Apply(files[0].Source, SetDocEditor.Build(model, files, "C.Money", "line one\nline two").Edits);

        Assert.Contains("  /// line one\n  /// line two\n", applied);
    }

    [Fact]
    public void Can_document_the_context_itself()
    {
        var (model, files) = Parse("context C {\n  value Money { amount: Decimal }\n}\n");
        var applied = Apply(files[0].Source, SetDocEditor.Build(model, files, "C", "The C context.").Edits);

        Assert.Contains("/// The C context.\ncontext C {", applied);
    }

    [Fact]
    public void Unknown_id_returns_no_edits()
    {
        var (model, files) = Parse("context C {\n  value Money { amount: Decimal }\n}\n");
        Assert.Empty(SetDocEditor.Build(model, files, "C.Nope", "x").Edits);
    }

    [Fact]
    public void Uses_the_source_line_ending_for_crlf_files()
    {
        // A CRLF source must get a CRLF-terminated doc comment, not a bare-LF line that would
        // leave the file with mixed endings (the LSP/Rider path syncs verbatim Windows text).
        var (model, files) = Parse("context C {\r\n  value Money { amount: Decimal }\r\n}\r\n");
        var newText = SetDocEditor.Build(model, files, "C.Money", "A monetary amount.").Edits[0].NewText;

        Assert.Equal("  /// A monetary amount.\r\n", newText);
    }

    [Fact]
    public void Empty_description_clears_an_existing_doc()
    {
        var (model, files) = Parse("context C {\n  /// old\n  value Money { amount: Decimal }\n}\n");
        var applied = Apply(files[0].Source, SetDocEditor.Build(model, files, "C.Money", "   ").Edits);

        Assert.DoesNotContain("/// old", applied);
        Assert.Contains("  value Money", applied);
    }
}
