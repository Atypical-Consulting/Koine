using Koine.Compiler.Ast;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Full source ranges (#4): every node's <see cref="SourceSpan.Span"/> now covers the whole
/// construct (keyword → end) with a 0-based <see cref="SourceSpan.Offset"/> + char
/// <see cref="SourceSpan.Length"/>, and every named declaration carries a
/// <see cref="KoineNode.NameSpan"/> over just its identifier. Multi-line constructs report a
/// correct end line/column.
/// </summary>
public class SourceRangeTests
{
    private static KoineModel Parse(string src)
    {
        var (model, diagnostics) = new KoineCompiler().Parse(src);
        Assert.Empty(diagnostics);
        Assert.NotNull(model);
        return model!;
    }

    [Fact]
    public void Declaration_span_covers_the_whole_node()
    {
        //          0         1         2
        //          0123456789012345678901234567890
        // line 1:  context C {
        // line 2:    value Money { amount: Decimal }
        const string src = "context C {\n  value Money { amount: Decimal }\n}\n";
        var model = Parse(src);
        var money = model.Contexts[0].Types[0];

        // Span starts at the `value` keyword (line 2, column 3, 1-based).
        Assert.Equal(2, money.Span.Line);
        Assert.Equal(3, money.Span.Column);

        // Span ends just past the closing brace (end-EXCLUSIVE) on the same line.
        Assert.Equal(2, money.Span.EndLine);
        var line2 = "  value Money { amount: Decimal }";
        Assert.Equal(line2.Length + 1, money.Span.EndColumn); // 1-based exclusive

        // Offset + length identify the exact substring in the raw source.
        var sub = src.Substring(money.Span.Offset, money.Span.Length);
        Assert.Equal("value Money { amount: Decimal }", sub);
    }

    [Fact]
    public void NameSpan_covers_exactly_the_identifier()
    {
        const string src = "context C {\n  value Money { amount: Decimal }\n}\n";
        var model = Parse(src);
        var money = model.Contexts[0].Types[0];

        Assert.False(money.NameSpan.IsNone);
        var name = src.Substring(money.NameSpan.Offset, money.NameSpan.Length);
        Assert.Equal("Money", name);

        // The name span sits inside the full span and is exactly the identifier width.
        Assert.Equal(money.NameSpan.EndColumn - money.NameSpan.Column, "Money".Length);
    }

    [Fact]
    public void Member_name_span_covers_the_field_name()
    {
        const string src = "context C {\n  value Money { amount: Decimal }\n}\n";
        var model = Parse(src);
        var amount = ((ValueObjectDecl)model.Contexts[0].Types[0]).Members[0];

        var name = src.Substring(amount.NameSpan.Offset, amount.NameSpan.Length);
        Assert.Equal("amount", name);
    }

    [Fact]
    public void Multi_line_block_comment_at_the_end_yields_correct_end_line()
    {
        // A trailing block comment is the stop token of the value declaration body's last
        // token region; the construct spans two lines.
        const string src =
            "context C {\n" +
            "  value Money {\n" +
            "    amount: Decimal /* a\n" +
            "       multi-line comment */\n" +
            "  }\n" +
            "}\n";
        var model = Parse(src);
        var money = model.Contexts[0].Types[0];

        // The closing brace of `value Money { ... }` is on line 5 (1-based).
        Assert.Equal(5, money.Span.EndLine);
    }

    [Fact]
    public void Multi_line_string_literal_reports_correct_end_geometry()
    {
        // An invariant whose message is a multi-line string: the stop token (the string)
        // spans two source lines, so the node end line is the literal's last line.
        const string src =
            "context C {\n" +
            "  value V {\n" +
            "    x: Int\n" +
            "    invariant x > 0 \"line one\nline two\"\n" +
            "  }\n" +
            "}\n";
        var model = Parse(src);
        var inv = ((ValueObjectDecl)model.Contexts[0].Types[0]).Invariants[0];

        // The invariant starts on line 4 and ends on line 5 (the string's second line).
        Assert.Equal(4, inv.Span.Line);
        Assert.Equal(5, inv.Span.EndLine);
        Assert.Equal("line two\"".Length + 1, inv.Span.EndColumn); // 1-based exclusive end col
    }
}
