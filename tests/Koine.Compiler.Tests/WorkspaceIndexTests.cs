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
    public void Cross_file_enum_member_resolves_to_member_span()
    {
        var active = "context A {\n  enum Local { X }\n}\n"; // does not declare Currency
        var idx = Index(("file:///a.koi", active), ("file:///catalog.koi", Catalog));
        var def = idx.ResolveDefinition("file:///a.koi", "EUR"); // a Currency member in Catalog
        Assert.NotNull(def);
        Assert.Equal("file:///catalog.koi", def!.Uri);
        Assert.Equal(2, def.Span.Line); // line of `enum Currency { EUR, USD }`
    }

    [Fact]
    public void Empty_workspace_resolves_to_null()
    {
        var idx = new WorkspaceIndex(new Dictionary<string, string>());
        Assert.Null(idx.ResolveDefinition("file:///x.koi", "Anything"));
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

    [Fact]
    public void Cross_file_type_hover_renders_card_from_other_file()
    {
        var a = "context A { value Wrap { c: Currency } }\n";
        var idx = Index(("file:///a.koi", a), ("file:///catalog.koi", Catalog));
        var md = idx.ResolveHover("file:///a.koi", "Currency");
        Assert.NotNull(md);
        Assert.Contains("Currency", md!);
        Assert.Contains("Enum", md);
    }

    [Fact]
    public void Cross_file_id_hover_shows_owning_entity()
    {
        var idx = Index(("file:///ordering.koi", Ordering), ("file:///catalog.koi", Catalog));
        var md = idx.ResolveHover("file:///ordering.koi", "ProductId");
        Assert.NotNull(md);
        Assert.Contains("Product", md!); // names the owning entity
    }

    [Fact]
    public void Primitive_hover_uses_weak_fallback()
    {
        var idx = Index(("file:///a.koi", "context A { value V { x: Int } }\n"));
        var md = idx.ResolveHover("file:///a.koi", "Decimal");
        Assert.NotNull(md);
        Assert.Contains("Primitive", md!);
    }

    [Fact]
    public void Unknown_name_hover_is_null()
    {
        var idx = Index(("file:///a.koi", "context A { value V { x: Int } }\n"));
        Assert.Null(idx.ResolveHover("file:///a.koi", "Nonexistent"));
    }

    [Fact]
    public void Ambiguous_cross_file_hover_is_null()
    {
        var b = "context B { value Widget { x: Int } }\n";
        var c = "context C { value Widget { y: Int } }\n";
        var active = "context A { value Uses { w: Widget } }\n";
        var idx = Index(("file:///a.koi", active), ("file:///b.koi", b), ("file:///c.koi", c));
        Assert.Null(idx.ResolveHover("file:///a.koi", "Widget"));
    }

    [Fact]
    public void Cross_file_spec_hover_names_target()
    {
        var specFile = "context S {\n  value Money { amount: Decimal }\n  spec Positive on Money = amount > 0\n}\n";
        var active = "context A { value V { x: Int } }\n";
        var idx = Index(("file:///a.koi", active), ("file:///s.koi", specFile));
        var md = idx.ResolveHover("file:///a.koi", "Positive");
        Assert.NotNull(md);
        Assert.Contains("spec on Money", md!);
    }
}
