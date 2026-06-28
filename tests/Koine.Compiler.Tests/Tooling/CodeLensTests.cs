using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

public class CodeLensTests
{
    private static readonly KoineLanguageService Svc = new();
    private const string U = "file:///t.koi";

    private static IReadOnlyDictionary<string, string> Doc(string src) =>
        new Dictionary<string, string> { [U] = src };

    [Fact]
    public void Referenced_type_reports_its_reference_count()
    {
        // Money is used as a field type in two other value objects (Line, Bill).
        // The lens reports references-from-elsewhere = total references minus the declaration = 2.
        var src =
            "context C {\n" +
            "  value Money { amount: Decimal }\n" +
            "  value Line { price: Money }\n" +
            "  value Bill { fee: Money }\n" +
            "}\n";

        var lenses = Svc.CodeLenses(Doc(src), U);
        var money = lenses.Single(l => l.Name == "Money");
        money.Title.ShouldBe("2 references");
    }

    [Fact]
    public void Unreferenced_type_reports_zero_references()
    {
        var src =
            "context C {\n" +
            "  value Money { amount: Decimal }\n" +
            "  value Line { price: Money }\n" +
            "  value Bill { fee: Money }\n" +
            "}\n";

        var lenses = Svc.CodeLenses(Doc(src), U);

        // Line and Bill are declared but never used as a field type, so they have no
        // references beyond their own declaration.
        var line = lenses.Single(l => l.Name == "Line");
        line.Title.ShouldBe("0 references");
    }

    [Fact]
    public void Single_reference_is_singular()
    {
        var src =
            "context C {\n" +
            "  value Money { amount: Decimal }\n" +
            "  value Line { price: Money }\n" +
            "}\n";

        var lenses = Svc.CodeLenses(Doc(src), U);
        var money = lenses.Single(l => l.Name == "Money");
        money.Title.ShouldBe("1 reference");
    }

    [Fact]
    public void Lens_range_is_the_declaration_name_span()
    {
        var src =
            "context C {\n" +
            "  value Money { amount: Decimal }\n" +
            "  value Line { price: Money }\n" +
            "  value Bill { fee: Money }\n" +
            "}\n";

        var lenses = Svc.CodeLenses(Doc(src), U);
        var outline = Svc.DocumentSymbols(src);
        var moneySymbol = outline
            .SelectMany(c => c.Children)
            .Single(s => s.Name == "Money");

        // The lens range is the declaration's name span. Compare by position; the lens is computed
        // from the warm snapshot's per-file model (which carries the source File on its spans) while
        // the raw DocumentSymbols(src) parse does not, so the incidental File field is ignored here.
        var money = lenses.Single(l => l.Name == "Money");
        money.Range.Line.ShouldBe(moneySymbol.SelectionRange.Line);
        money.Range.Column.ShouldBe(moneySymbol.SelectionRange.Column);
        money.Range.EndLine.ShouldBe(moneySymbol.SelectionRange.EndLine);
        money.Range.EndColumn.ShouldBe(moneySymbol.SelectionRange.EndColumn);
    }
}
