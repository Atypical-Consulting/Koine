using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Task 5: binder-driven completion + snippet starters + subsequence filtering.
/// These pin the wins beyond the flat-<see cref="Koine.Compiler.Ast.ModelIndex"/> path:
/// (a) member access survives a syntax error ELSEWHERE in the document,
/// (b) a multi-hop receiver (<c>order.line.</c>) types through to the second hop's members,
/// (c) declaration-start snippet items carry <c>InsertTextFormat == 2</c>,
/// (d) the partial filter is a subsequence match, not a prefix match.
/// </summary>
public class BinderCompletionTests
{
    private static readonly KoineLanguageService Svc = new();

    private static IReadOnlyList<CompletionItem> Complete(string src, int line, int ch) =>
        Svc.CompleteAt(src, line, ch);

    // (a) Broken-doc member access: `order.` offers Order's members even though there is a
    // syntax error on an UNRELATED line. The well-formed Order/OrderLine declarations are
    // recovered by error-tolerant parsing (or the placeholder repair), so member access still binds.
    [Fact]
    public void Member_access_resolves_through_a_syntax_error_elsewhere()
    {
        var src =
            "context C {\n" +
            "  value OrderLine { qty: Int }\n" +
            "  entity Order identified by OrderId {\n" +
            "    line: OrderLine\n" +
            "    invariant line.\n" +     // line index 4 — the receiver we complete
            "  }\n" +
            "  value Broken { x: \n" +    // line index 6 — a DELIBERATE syntax error elsewhere
            "}\n";
        // Cursor one past the '.' on the invariant line (line index 4).
        var items = Complete(src, line: 4, ch: 19);
        items.ShouldContain(i => i.Label == "qty");
    }

    // (b) Multi-hop receiver: `order.line.` types `order.line` to OrderLine and offers ITS members.
    [Fact]
    public void Multi_hop_receiver_offers_the_second_hops_members()
    {
        var src =
            "context C {\n" +
            "  value OrderLine { qty: Int }\n" +
            "  value Order { line: OrderLine }\n" +
            "  value Cart {\n" +
            "    order: Order\n" +
            "    invariant order.line.\n" +   // multi-hop receiver `order.line`
            "  }\n" +
            "}\n";
        // Cursor one past the second '.' on line index 5.
        var items = Complete(src, line: 5, ch: 25);
        items.ShouldContain(i => i.Label == "qty");
    }

    // (c) Declaration-start snippet: a starter keyword is offered as a snippet (InsertTextFormat == 2).
    [Fact]
    public void Declaration_start_offers_a_snippet_starter()
    {
        var src = "context C {\n  \n}\n";
        var items = Complete(src, line: 1, ch: 2);
        var entity = items.Where(i => i.Label == "entity").ToList();
        entity.ShouldContain(i => i.InsertTextFormat == 2 && !string.IsNullOrEmpty(i.InsertText));
    }

    // (d) Subsequence filter: the non-contiguous query "oa" matches "OrderAggregate".
    [Fact]
    public void Subsequence_query_matches_a_non_contiguous_label()
    {
        var src =
            "context C {\n" +
            "  value OrderAggregate { id: Int }\n" +
            "  value V { x: oa }\n" +
            "}\n";
        // Cursor right after the "oa" partial on line index 2 (type position after ':').
        var items = Complete(src, line: 2, ch: 17);
        items.ShouldContain(i => i.Label == "OrderAggregate");
    }

    // (d') Prefix matches sort before non-prefix subsequence matches (SortText "0" vs "1").
    [Fact]
    public void Prefix_matches_sort_before_subsequence_matches()
    {
        var src =
            "context C {\n" +
            "  value Order { x: Int }\n" +
            "  value Reorder { y: Int }\n" +
            "  value V { z: Or }\n" +
            "}\n";
        var items = Complete(src, line: 3, ch: 17); // right after "Or"
        var order = items.First(i => i.Label == "Order");
        var reorder = items.First(i => i.Label == "Reorder");
        // Order is a prefix match (sort "0…"), Reorder only a subsequence (sort "1…").
        string.CompareOrdinal(order.SortText, reorder.SortText).ShouldBeLessThan(0);
    }
}
