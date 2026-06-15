using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

public class KoineLanguageServiceTests
{
    private static readonly KoineLanguageService Svc = new();

    private static IReadOnlyList<CompletionItem> Complete(string src, int line, int ch) =>
        Svc.CompleteAt(src, line, ch);

    [Fact]
    public void Type_position_offers_declared_and_primitive_types()
    {
        // Cursor at col 14 = space between ':' and 'S'; partial is empty so all types are offered.
        var src = "context C {\n  value V { x: S }\n}\n";
        var items = Complete(src, line: 1, ch: 14);
        Assert.Contains(items, i => i.Label == "Decimal");
        Assert.Contains(items, i => i.Label == "List");
        Assert.Contains(items, i => i.Label == "V");
    }

    [Fact]
    public void Type_position_filters_by_partial_prefix()
    {
        var src = "context C {\n  value V { x: Stri }\n}\n";
        var items = Complete(src, line: 1, ch: 18);
        Assert.Contains(items, i => i.Label == "String");
        Assert.DoesNotContain(items, i => i.Label == "Decimal");
    }

    [Fact]
    public void Type_position_on_broken_doc_still_offers_primitives()
    {
        var src = "context C {\n  value V { x: ";
        var items = Complete(src, line: 1, ch: 15);
        Assert.Contains(items, i => i.Label == "String");
        Assert.Contains(items, i => i.Label == "List");
    }

    [Fact]
    public void Top_level_declaration_start_offers_context_keyword()
    {
        var items = Complete("\n", line: 0, ch: 0);
        Assert.Contains(items, i => i.Label == "context" && i.Kind == CompletionItemKind.Keyword);
    }

    [Fact]
    public void Inside_service_offers_operation_keyword()
    {
        var src = "context C {\n  service S {\n    \n  }\n}\n";
        var items = Complete(src, line: 2, ch: 4);
        Assert.Contains(items, i => i.Label == "operation");
        Assert.DoesNotContain(items, i => i.Label == "usecase");
    }

    [Fact]
    public void No_completion_inside_a_regex_literal()
    {
        var src = "context C {\n  value V { invariant raw matches /ab\n}\n";
        var items = Complete(src, line: 1, ch: 36);
        Assert.Empty(items);
    }

    [Fact]
    public void Enum_value_position_offers_members_filtered_by_partial()
    {
        // status: OrderStatus = Dr   -> members of OrderStatus starting with "Dr"
        var src =
            "context C {\n" +
            "  enum OrderStatus { Draft, Placed, Shipped }\n" +
            "  entity E identified by EId { status: OrderStatus = Dr }\n" +
            "}\n";
        var items = Complete(src, 2, 55);
        Assert.Contains(items, i => i.Label == "Draft" && i.Kind == CompletionItemKind.EnumMember);
        Assert.DoesNotContain(items, i => i.Label == "Placed");
    }

    [Fact]
    public void Member_access_emits_no_property_noise()
    {
        // Cursor immediately after '.', before a member name. The DOT trigger
        // must return nothing rather than guess members (the no-noise contract).
        var src =
            "context C {\n" +
            "  value V { a: Int }\n" +
            "  spec S on V = v.\n" +
            "}\n";
        var items = Complete(src, 2, 18); // one past the '.' on line 2
        Assert.Empty(items);
    }

    [Fact]
    public void Hover_over_a_value_type_shows_kind_and_members()
    {
        var src =
            "context C {\n" +
            "  value Money { amount: Decimal }\n" +
            "  value Line { price: Money }\n" +
            "}\n";
        var hover = Svc.HoverAt(src, line: 2, character: 23); // over "Money" (col 22, Contains uses exclusive start)
        Assert.NotNull(hover);
        Assert.Contains("Money", hover!.Markdown);
        Assert.Contains("Value", hover.Markdown);     // the kind label
        Assert.Contains("amount", hover.Markdown);     // a member
    }

    [Fact]
    public void Hover_returns_null_on_a_broken_document()
    {
        var src = "context C {\n  value Money { amount: ";
        Assert.Null(Svc.HoverAt(src, line: 1, character: 9)); // over "Money", parse fails
    }

    [Fact]
    public void Hover_over_whitespace_returns_null()
    {
        var src = "context C {\n  value Money { amount: Decimal }\n}\n";
        Assert.Null(Svc.HoverAt(src, line: 0, character: 0));
    }
}
