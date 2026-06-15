using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

public class WorkspaceIndexTests
{
    private const string Catalog =
        "context Catalog {\n" +
        "  enum Currency { EUR, USD }\n" +
        "  entity Product identified by ProductId {\n" +
        "    sku: String\n" +
        "  }\n" +
        "}\n";

    private const string Ordering =
        "context Ordering {\n" +
        "  value Line { product: ProductId }\n" +
        "}\n";

    private static WorkspaceIndex Index(params (string Uri, string Text)[] docs) =>
        new(docs.ToDictionary(d => d.Uri, d => d.Text));

    [Fact]
    public void Cross_file_id_resolves_to_owning_entity()
    {
        var idx = Index(("file:///ordering.koi", Ordering), ("file:///catalog.koi", Catalog));
        var def = idx.ResolveDefinition("file:///ordering.koi", "ProductId");
        Assert.NotNull(def);
        Assert.Equal("file:///catalog.koi", def!.Uri);
        Assert.Equal(3, def.Span.Line); // line of `entity Product` in Catalog
    }

    [Fact]
    public void Cross_file_type_resolves_to_declaring_file()
    {
        var a = "context A { value Wrap { c: Currency } }\n";
        var idx = Index(("file:///a.koi", a), ("file:///catalog.koi", Catalog));
        var def = idx.ResolveDefinition("file:///a.koi", "Currency");
        Assert.NotNull(def);
        Assert.Equal("file:///catalog.koi", def!.Uri);
    }

    [Fact]
    public void Local_declaration_wins_over_other_files()
    {
        var local = "context L {\n  enum Currency { GBP }\n  value V { c: Currency }\n}\n";
        var idx = Index(("file:///local.koi", local), ("file:///catalog.koi", Catalog));
        var def = idx.ResolveDefinition("file:///local.koi", "Currency");
        Assert.NotNull(def);
        Assert.Equal("file:///local.koi", def!.Uri); // local wins
    }

    [Fact]
    public void Ambiguous_cross_file_type_resolves_to_null()
    {
        var b = "context B { value Widget { x: Int } }\n";
        var c = "context C { value Widget { y: Int } }\n";
        var active = "context A { value Uses { w: Widget } }\n";
        var idx = Index(("file:///a.koi", active), ("file:///b.koi", b), ("file:///c.koi", c));
        Assert.Null(idx.ResolveDefinition("file:///a.koi", "Widget")); // declared in 2 other files
    }

    [Fact]
    public void Broken_file_does_not_poison_other_files()
    {
        var broken = "context Broken { value {{{ ";
        var idx = Index(("file:///broken.koi", broken), ("file:///catalog.koi", Catalog));
        var def = idx.ResolveDefinition("file:///broken.koi", "Product");
        Assert.NotNull(def); // resolves into catalog despite broken active file
        Assert.Equal("file:///catalog.koi", def!.Uri);
    }
}
