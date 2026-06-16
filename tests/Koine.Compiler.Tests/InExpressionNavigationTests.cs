using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// In-expression navigation (P3): go-to-definition and hover on a field reference INSIDE an
/// expression (an invariant body) resolve to the field's declaration, using the enclosing type as
/// the lexical scope. Before the Symbol/SemanticModel binding pass these were string-matched and a
/// member reference inside an expression had no navigation target.
/// </summary>
public class InExpressionNavigationTests
{
    private static readonly KoineLanguageService Svc = new();
    private const string U = "file:///t.koi";

    private static IReadOnlyDictionary<string, string> Doc(string src) =>
        new Dictionary<string, string> { [U] = src };

    // line 0: context Shop {
    // line 1:   value Money {
    // line 2:     amount: Decimal      <- declaration (1-based line 3)
    // line 3:     invariant amount > 0 <- reference, "amount" at chars 14..19
    // line 4:   }
    // line 5: }
    private const string Src =
        "context Shop {\n" +
        "  value Money {\n" +
        "    amount: Decimal\n" +
        "    invariant amount > 0\n" +
        "  }\n" +
        "}\n";

    [Fact]
    public void Definition_of_a_field_referenced_in_an_invariant_points_at_the_field()
    {
        var def = Svc.DefinitionAt(Doc(Src), U, line: 3, character: 16); // over "amount" in the invariant
        Assert.NotNull(def);
        Assert.Equal(3, def!.Target.Line); // 1-based line of "amount: Decimal"
    }

    [Fact]
    public void Hover_over_a_field_referenced_in_an_invariant_shows_a_field_card()
    {
        var hover = Svc.HoverAt(Doc(Src), U, line: 3, character: 16); // over "amount" in the invariant
        Assert.NotNull(hover);
        Assert.Contains("field of Money", hover!.Markdown);
        Assert.Contains("Decimal", hover.Markdown);
    }
}
