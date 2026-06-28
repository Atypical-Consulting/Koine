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

        result.Uri.ShouldBe("t.koi");
        Apply(files[0].Source, result.Edits).ShouldContain("  /// A monetary amount.\n  value Money");
    }

    [Fact]
    public void Replaces_existing_doc_block()
    {
        var (model, files) = Parse("context C {\n  /// old\n  value Money { amount: Decimal }\n}\n");
        var applied = Apply(files[0].Source, SetDocEditor.Build(model, files, "C.Money", "new desc").Edits);

        applied.ShouldContain("/// new desc");
        applied.ShouldNotContain("/// old");
    }

    [Fact]
    public void Multiline_prose_becomes_multiple_slash_lines()
    {
        var (model, files) = Parse("context C {\n  value Money { amount: Decimal }\n}\n");
        var applied = Apply(files[0].Source, SetDocEditor.Build(model, files, "C.Money", "line one\nline two").Edits);

        applied.ShouldContain("  /// line one\n  /// line two\n");
    }

    [Fact]
    public void Can_document_the_context_itself()
    {
        var (model, files) = Parse("context C {\n  value Money { amount: Decimal }\n}\n");
        var applied = Apply(files[0].Source, SetDocEditor.Build(model, files, "C", "The C context.").Edits);

        applied.ShouldContain("/// The C context.\ncontext C {");
    }

    [Fact]
    public void Targets_the_declarations_own_file_in_a_multi_file_workspace()
    {
        var files = new[]
        {
            new SourceFile("a.koi", "context A {\n  value Alpha { x: Decimal }\n}\n"),
            new SourceFile("b.koi", "context B {\n  value Beta { y: Decimal }\n}\n"),
        };
        var model = new KoineCompiler().Parse(files).Model!;

        var result = SetDocEditor.Build(model, files, "B.Beta", "The beta value.");

        result.Uri.ShouldBe("b.koi");                 // not a.koi (files[0]) — the declaration's own file
        result.Edits[0].Range.Line.ShouldBe(2);       // the `value Beta` line within b.koi
    }

    [Fact]
    public void Unknown_id_returns_no_edits()
    {
        var (model, files) = Parse("context C {\n  value Money { amount: Decimal }\n}\n");
        SetDocEditor.Build(model, files, "C.Nope", "x").Edits.ShouldBeEmpty();
    }

    [Fact]
    public void Uses_the_source_line_ending_for_crlf_files()
    {
        // A CRLF source must get a CRLF-terminated doc comment, not a bare-LF line that would
        // leave the file with mixed endings (the LSP/Rider path syncs verbatim Windows text).
        var (model, files) = Parse("context C {\r\n  value Money { amount: Decimal }\r\n}\r\n");
        var newText = SetDocEditor.Build(model, files, "C.Money", "A monetary amount.").Edits[0].NewText;

        newText.ShouldBe("  /// A monetary amount.\r\n");
    }

    [Fact]
    public void Empty_description_clears_an_existing_doc()
    {
        var (model, files) = Parse("context C {\n  /// old\n  value Money { amount: Decimal }\n}\n");
        var applied = Apply(files[0].Source, SetDocEditor.Build(model, files, "C.Money", "   ").Edits);

        applied.ShouldNotContain("/// old");
        applied.ShouldContain("  value Money");
    }
}
