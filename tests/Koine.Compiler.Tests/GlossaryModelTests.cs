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
        Assert.Contains(g.Entries, e => e.Kind == "context" && e.Name == "Ordering");
        Assert.Contains(g.Entries, e => e.Kind == "value" && e.Name == "Money");
        Assert.Contains(g.Entries, e => e.Kind == "enum" && e.Name == "Currency");
    }

    [Fact]
    public void Build_reports_doc_presence_for_coverage()
    {
        var g = Build(Sample);
        Assert.Equal("A monetary amount.", g.Entries.Single(e => e.Name == "Money").Doc?.Trim());
        Assert.Null(g.Entries.Single(e => e.Name == "Currency").Doc);   // undocumented => coverage gap
    }

    [Fact]
    public void Build_ids_are_unique_and_qualified_by_context()
    {
        var g = Build(Sample);
        Assert.Equal(g.Entries.Select(e => e.Id), g.Entries.Select(e => e.Id).Distinct());
        Assert.Equal("Ordering.Money", g.Entries.Single(e => e.Name == "Money").QualifiedName);
        Assert.Equal(g.Entries.Single(e => e.Name == "Money").QualifiedName,
                     g.Entries.Single(e => e.Name == "Money").Id);
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
        Assert.Contains(g.Entries, e => e.Kind == "aggregate" && e.QualifiedName == "Sales.Cart");
        Assert.Contains(g.Entries, e => e.Kind == "entity" && e.QualifiedName == "Sales.Cart.CartHead");
        Assert.Equal("A line.", g.Entries.Single(e => e.Name == "CartLine").Doc?.Trim());
        Assert.Equal("Sales.Cart.CartLine", g.Entries.Single(e => e.Name == "CartLine").QualifiedName);
    }
}
