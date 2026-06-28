using Koine.Compiler.Emit.Glossary;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// The structured glossary model (#67) — the data behind Studio's ubiquitous-language editor:
/// one entry per context and type, carrying doc presence (for coverage) and a stable qualified id.
/// </summary>
public class GlossaryModelTests
{
    private const string Sample = """
        /// The ordering context.
        context Ordering {
          /// A monetary amount.
          value Money { amount: Decimal }
          enum Currency { EUR, USD }
        }
        """;

    private static GlossaryModel Build(string src) =>
        GlossaryModelBuilder.Build(new KoineCompiler().Parse(new[] { new SourceFile("t.koi", src) }).Model!);

    [Fact]
    public void Build_includes_the_context_and_its_types_with_kinds()
    {
        var g = Build(Sample);
        g.Entries.ShouldContain(e => e.Kind == "context" && e.Name == "Ordering");
        g.Entries.ShouldContain(e => e.Kind == "value" && e.Name == "Money");
        g.Entries.ShouldContain(e => e.Kind == "enum" && e.Name == "Currency");
    }

    [Fact]
    public void Build_reports_doc_presence_for_coverage()
    {
        var g = Build(Sample);
        (g.Entries.Single(e => e.Name == "Money").Doc?.Trim()).ShouldBe("A monetary amount.");
        g.Entries.Single(e => e.Name == "Currency").Doc.ShouldBeNull();   // undocumented => coverage gap
    }

    [Fact]
    public void Build_ids_are_unique_and_qualified_by_context()
    {
        var g = Build(Sample);
        g.Entries.Select(e => e.Id).Distinct().ShouldBe(g.Entries.Select(e => e.Id));
        g.Entries.Single(e => e.Name == "Money").QualifiedName.ShouldBe("Ordering.Money");
        g.Entries.Single(e => e.Name == "Money").Id.ShouldBe(g.Entries.Single(e => e.Name == "Money").QualifiedName);
    }

    [Fact]
    public void Build_qualifies_nested_aggregate_types_under_the_aggregate()
    {
        const string src = """
            context Sales {
              aggregate Cart root CartHead {
                entity CartHead identified by CartId { total: Decimal }
                /// A line.
                value CartLine { qty: Int }
              }
            }
            """;
        var g = Build(src);
        g.Entries.ShouldContain(e => e.Kind == "aggregate" && e.QualifiedName == "Sales.Cart");
        g.Entries.ShouldContain(e => e.Kind == "entity" && e.QualifiedName == "Sales.Cart.CartHead");
        (g.Entries.Single(e => e.Name == "CartLine").Doc?.Trim()).ShouldBe("A line.");
        g.Entries.Single(e => e.Name == "CartLine").QualifiedName.ShouldBe("Sales.Cart.CartLine");
    }
}
