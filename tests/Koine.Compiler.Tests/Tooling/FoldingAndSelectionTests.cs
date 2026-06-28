using Koine.Compiler.Ast;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

public class FoldingAndSelectionTests
{
    private static readonly KoineLanguageService Svc = new();

    // A context with a nested entity (with a multi-line member block) plus an aggregate.
    // Line numbers (0-based) for reference:
    //  0: context Shop {
    //  1:   entity Order {
    //  2:     total: Decimal
    //  3:   }
    //  4: }
    private const string Source =
        "context Shop {\n" +
        "  entity Order {\n" +
        "    total: Decimal\n" +
        "  }\n" +
        "}\n";

    [Fact]
    public void FoldingRanges_yields_a_fold_for_the_context_and_the_entity()
    {
        var folds = Svc.FoldingRanges(Source);

        // The context block starts on 1-based line 1 and spans more than one line.
        folds.ShouldContain(f => f.Range.Line == 1 && f.Range.EndLine > f.Range.Line);

        // The nested entity block starts on 1-based line 2 and spans more than one line.
        folds.ShouldContain(f => f.Range.Line == 2 && f.Range.EndLine > f.Range.Line);
    }

    [Fact]
    public void FoldingRanges_skips_single_line_nodes()
    {
        // The member `total: Decimal` sits on one line — never a fold.
        var folds = Svc.FoldingRanges(Source);
        folds.ShouldAllBe(f => f.Range.EndLine > f.Range.Line);
    }

    [Fact]
    public void SelectionRangeAt_nests_member_inside_entity_inside_context()
    {
        // Cursor on the member name `total` (0-based line 2, character 4).
        var chain = Svc.SelectionRangeAt(Source, line: 2, character: 4);
        chain.ShouldNotBeNull();

        // Walk the chain innermost → outermost and collect the spans.
        var spans = new List<SourceSpan>();
        for (SelectionRange? cur = chain; cur is not null; cur = cur.Parent)
        {
            spans.Add(cur.Range);
        }

        // At least three levels: member ⊂ entity ⊂ context.
        spans.Count.ShouldBeGreaterThanOrEqualTo(3);

        // Each parent strictly contains its child.
        for (var i = 0; i < spans.Count - 1; i++)
        {
            var child = spans[i];
            var parent = spans[i + 1];
            parent.Line.ShouldBeLessThanOrEqualTo(child.Line);
            parent.EndLine.ShouldBeGreaterThanOrEqualTo(child.EndLine);
            // Strictly larger on at least one bound.
            var stricter = parent.Line < child.Line
                || parent.EndLine > child.EndLine
                || parent.Column < child.Column
                || parent.EndColumn > child.EndColumn;
            stricter.ShouldBeTrue();
        }
    }
}
