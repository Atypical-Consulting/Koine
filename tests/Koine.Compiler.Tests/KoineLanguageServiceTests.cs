using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

public class KoineLanguageServiceTests
{
    private static readonly KoineLanguageService Svc = new();
    private const string U = "file:///t.koi";
    private static IReadOnlyDictionary<string, string> Doc(string src) =>
        new Dictionary<string, string> { [U] = src };

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
    public void Inside_service_offers_operation_and_usecase_keywords()
    {
        // serviceMember : operationDecl | usecaseDecl — both are legal at service scope.
        var src = "context C {\n  service S {\n    \n  }\n}\n";
        var items = Complete(src, line: 2, ch: 4);
        Assert.Contains(items, i => i.Label == "operation");
        Assert.Contains(items, i => i.Label == "usecase");
        Assert.DoesNotContain(items, i => i.Label == "value"); // not a service member
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
    public void Invariant_offers_enclosing_type_field_names()
    {
        // `invariant amount >= am` — after the '>=' operator, the in-scope fields of the
        // enclosing value (Money) are offered, filtered by the "am" prefix.
        var src =
            "context C {\n" +
            "  value Money {\n" +
            "    amount: Decimal\n" +
            "    invariant amount >= am\n" +
            "  }\n" +
            "}\n";
        var items = Complete(src, line: 3, ch: 26);
        var amount = Assert.Single(items, i => i.Label == "amount");
        Assert.Equal(CompletionItemKind.Field, amount.Kind);
        Assert.Equal("Decimal", amount.Detail);
    }

    [Fact]
    public void Field_completion_renders_generic_member_types()
    {
        var src =
            "context C {\n" +
            "  value OrderLine { qty: Int }\n" +
            "  value Basket {\n" +
            "    lines: List<OrderLine>\n" +
            "    invariant lines == li\n" +
            "  }\n" +
            "}\n";
        var items = Complete(src, line: 4, ch: 25); // after the "li" prefix
        var lines = Assert.Single(items, i => i.Label == "lines");
        Assert.Equal(CompletionItemKind.Field, lines.Kind);
        Assert.Equal("List<OrderLine>", lines.Detail);
    }

    [Fact]
    public void Expression_position_offers_specs_of_the_enclosing_type()
    {
        var src =
            "context C {\n" +
            "  value Basket {\n" +
            "    n: Int\n" +
            "    invariant n > 0 && I\n" +
            "  }\n" +
            "  spec IsBig on Basket = n > 5\n" +
            "}\n";
        var items = Complete(src, line: 3, ch: 24); // after "&& I"
        var spec = Assert.Single(items, i => i.Label == "IsBig");
        Assert.Equal(CompletionItemKind.Method, spec.Kind);
    }

    [Fact]
    public void Field_completion_does_not_fire_at_a_type_position()
    {
        // After ':' the type list — not field names — must be offered (no Field-kind noise).
        var src = "context C {\n  value Money {\n    amount: Decimal\n    other:  \n  }\n}\n";
        var items = Complete(src, line: 3, ch: 11); // after "other: "
        Assert.DoesNotContain(items, i => i.Kind == CompletionItemKind.Field);
        Assert.Contains(items, i => i.Label == "Decimal");
    }

    [Fact]
    public void Hover_surfaces_a_types_doc_comment()
    {
        var src =
            "context C {\n" +
            "  /// The amount owed, in the order's currency.\n" +
            "  value Money { amount: Decimal }\n" +
            "  value Line { price: Money }\n" +
            "}\n";
        var hover = Svc.HoverAt(Doc(src), U, line: 3, character: 23); // over "Money"
        Assert.NotNull(hover);
        Assert.Contains("The amount owed", hover!.Markdown);
    }

    [Fact]
    public void Hover_over_a_value_type_shows_kind_and_members()
    {
        var src =
            "context C {\n" +
            "  value Money { amount: Decimal }\n" +
            "  value Line { price: Money }\n" +
            "}\n";
        var hover = Svc.HoverAt(Doc(src), U, line: 2, character: 23); // over "Money" (col 22; cursor must land strictly after the token's start column)
        Assert.NotNull(hover);
        Assert.Contains("Money", hover!.Markdown);
        Assert.Contains("Value", hover.Markdown);     // the kind label
        Assert.Contains("amount", hover.Markdown);     // a member
    }

    [Fact]
    public void Hover_returns_null_on_a_broken_document()
    {
        var src = "context C {\n  value Money { amount: ";
        Assert.Null(Svc.HoverAt(Doc(src), U, line: 1, character: 9)); // over "Money", parse fails
    }

    [Fact]
    public void Hover_over_whitespace_returns_null()
    {
        var src = "context C {\n  value Money { amount: Decimal }\n}\n";
        Assert.Null(Svc.HoverAt(Doc(src), U, line: 0, character: 0));
    }

    [Fact]
    public void Hover_renders_generic_member_types_fully()
    {
        var src =
            "context C {\n" +
            "  value OrderLine { qty: Int }\n" +
            "  value Basket { lines: List<OrderLine> }\n" +
            "}\n";
        var hover = Svc.HoverAt(Doc(src), U, line: 2, character: 9); // over "Basket"
        Assert.NotNull(hover);
        Assert.Contains("List<OrderLine>", hover!.Markdown);
    }

    [Fact]
    public void Hover_over_enum_member_names_its_enum()
    {
        var src =
            "context C {\n" +
            "  enum Color { Red, Green }\n" +
            "  value Paint { c: Color = Red }\n" +
            "}\n";
        var hover = Svc.HoverAt(Doc(src), U, line: 2, character: 28); // over "Red"
        Assert.NotNull(hover);
        Assert.Contains("enum member of Color", hover!.Markdown);
    }

    [Fact]
    public void Hover_over_a_spec_names_its_target()
    {
        var src =
            "context C {\n" +
            "  value Money { amount: Decimal }\n" +
            "  spec Positive on Money = amount > 0\n" +
            "}\n";
        var hover = Svc.HoverAt(Doc(src), U, line: 2, character: 9); // over "Positive"
        Assert.NotNull(hover);
        Assert.Contains("spec on Money", hover!.Markdown);
    }

    [Fact]
    public void Definition_of_a_type_reference_points_at_its_declaration()
    {
        var src =
            "context C {\n" +
            "  value Money { amount: Decimal }\n" +
            "  value Line { price: Money }\n" +
            "}\n";
        var def = Svc.DefinitionAt(Doc(src), U, line: 2, character: 23); // over "Money"
        Assert.NotNull(def);
        Assert.Equal(2, def!.Target.Line);  // 1-based line of "value Money"
    }

    [Fact]
    public void Definition_of_an_enum_member_points_at_the_member()
    {
        var src =
            "context C {\n" +
            "  enum OrderStatus { Draft, Placed }\n" +
            "  entity E identified by EId { status: OrderStatus = Draft }\n" +
            "}\n";
        var def = Svc.DefinitionAt(Doc(src), U, line: 2, character: 54); // over "Draft" value
        Assert.NotNull(def);
        Assert.Equal(2, def!.Target.Line);
    }

    [Fact]
    public void Definition_of_a_primitive_is_null()
    {
        var src = "context C {\n  value V { x: Decimal }\n}\n";
        Assert.Null(Svc.DefinitionAt(Doc(src), U, line: 1, character: 18)); // over "Decimal"
    }

    [Fact]
    public void Definition_of_a_spec_points_at_its_declaration()
    {
        var src =
            "context C {\n" +
            "  value Money { amount: Decimal }\n" +
            "  spec Positive on Money = amount > 0\n" +
            "}\n";
        var def = Svc.DefinitionAt(Doc(src), U, line: 2, character: 9); // over "Positive"
        Assert.NotNull(def);
        Assert.Equal(3, def!.Target.Line); // 1-based line of the spec declaration
    }

    [Fact]
    public void Definition_of_an_ambiguous_enum_member_is_null()
    {
        // "Shared" is declared in two enums -> navigation cannot resolve unambiguously.
        var src =
            "context C {\n" +
            "  enum A { Shared, X }\n" +
            "  enum B { Shared, Y }\n" +
            "  value V { a: A = Shared }\n" +
            "}\n";
        var def = Svc.DefinitionAt(Doc(src), U, line: 3, character: 20); // over "Shared"
        Assert.Null(def);
    }

    [Fact]
    public void DefinitionAt_resolves_across_files()
    {
        var ordering = "context Ordering {\n  value Line { product: ProductId }\n}\n";
        var catalog = "context Catalog {\n  entity Product identified by ProductId { sku: String }\n}\n";
        var docs = new Dictionary<string, string>
        {
            ["file:///ordering.koi"] = ordering,
            ["file:///catalog.koi"] = catalog,
        };
        var def = Svc.DefinitionAt(docs, "file:///ordering.koi", line: 1, character: 25); // on "ProductId"
        Assert.NotNull(def);
        Assert.Equal("file:///catalog.koi", def!.Uri);
    }

    // ---- Completion: new keyword starters --------------------------------

    [Fact]
    public void Context_scope_offers_readmodel_query_module_import_keywords()
    {
        var src = "context C {\n  \n}\n";
        var items = Complete(src, line: 1, ch: 2);
        foreach (var kw in new[] { "module", "import", "readmodel", "query", "value", "service" })
        {
            Assert.Contains(items, i => i.Label == kw && i.Kind == CompletionItemKind.Keyword);
        }
    }

    [Fact]
    public void File_scope_offers_contextmap_keyword()
    {
        var items = Complete("\n", line: 0, ch: 0);
        Assert.Contains(items, i => i.Label == "contextmap");
        Assert.Contains(items, i => i.Label == "context");
    }

    [Fact]
    public void Module_scope_offers_type_keywords_not_services()
    {
        var src = "context C {\n  module M {\n    \n  }\n}\n";
        var items = Complete(src, line: 2, ch: 4);
        Assert.Contains(items, i => i.Label == "value");
        Assert.Contains(items, i => i.Label == "module");
        Assert.DoesNotContain(items, i => i.Label == "service"); // not a module member
    }

    // ---- Completion: member access after '.' -------------------------------

    [Fact]
    public void Member_access_offers_enum_members_after_enum_type_dot()
    {
        var src =
            "context C {\n" +
            "  enum Color { Red, Green }\n" +
            "  value Paint { c: Color = Color. }\n" +
            "}\n";
        var items = Complete(src, line: 2, ch: 33); // just past "Color."
        Assert.Contains(items, i => i.Label == "Red" && i.Kind == CompletionItemKind.EnumMember);
        Assert.Contains(items, i => i.Label == "Green");
    }

    [Fact]
    public void Member_access_offers_field_type_members_in_an_invariant()
    {
        // `total.` where `total : Money` -> Money's members (amount).
        var src =
            "context C {\n" +
            "  value Money { amount: Decimal }\n" +
            "  value Line {\n" +
            "    total: Money\n" +
            "    invariant total. \n" +
            "  }\n" +
            "}\n";
        var items = Complete(src, line: 4, ch: 20); // just past "total."
        var amount = Assert.Single(items, i => i.Label == "amount");
        Assert.Equal(CompletionItemKind.Property, amount.Kind);
        Assert.Equal("Decimal", amount.Detail);
    }

    [Fact]
    public void Member_access_on_broken_document_offers_nothing()
    {
        var src = "context C {\n  value Money { amount: Decimal }\n  value Line { total: Money. ";
        var items = Complete(src, line: 2, ch: 28);
        Assert.Empty(items);
    }

    // ---- Document symbols -------------------------------------------------

    [Fact]
    public void DocumentSymbols_are_hierarchical_context_type_members()
    {
        var src =
            "context Shop {\n" +
            "  value Money { amount: Decimal }\n" +
            "  enum Status { Open, Closed }\n" +
            "}\n";
        var symbols = Svc.DocumentSymbols(src);
        var shop = Assert.Single(symbols);
        Assert.Equal("Shop", shop.Name);
        Assert.Equal(SymbolKind.Namespace, shop.Kind);

        var money = Assert.Single(shop.Children, c => c.Name == "Money");
        Assert.Equal(SymbolKind.Class, money.Kind);
        Assert.Contains(money.Children, c => c.Name == "amount" && c.Kind == SymbolKind.Field);

        var status = Assert.Single(shop.Children, c => c.Name == "Status");
        Assert.Equal(SymbolKind.Enum, status.Kind);
        Assert.Contains(status.Children, c => c.Name == "Open" && c.Kind == SymbolKind.EnumMember);
    }

    [Fact]
    public void DocumentSymbols_on_broken_document_is_empty()
    {
        Assert.Empty(Svc.DocumentSymbols("context C {\n  value V { x: "));
    }

    // ---- Find references --------------------------------------------------

    [Fact]
    public void References_include_declaration_and_all_uses()
    {
        var src =
            "context C {\n" +
            "  value Money { amount: Decimal }\n" +
            "  value Line { price: Money }\n" +
            "  value Bill { fee: Money }\n" +
            "}\n";
        // Cursor on the "Money" use in Line.
        var refs = Svc.ReferencesAt(Doc(src), U, line: 2, character: 23);
        Assert.Equal(3, refs.Count); // declaration + two uses
        Assert.All(refs, r => Assert.Equal(U, r.Uri));
    }

    [Fact]
    public void References_resolve_across_files()
    {
        var ordering = "context Ordering {\n  value Line { product: ProductId }\n}\n";
        var catalog = "context Catalog {\n  entity Product identified by ProductId { sku: String }\n}\n";
        var docs = new Dictionary<string, string>
        {
            ["file:///ordering.koi"] = ordering,
            ["file:///catalog.koi"] = catalog,
        };
        var refs = Svc.ReferencesAt(docs, "file:///catalog.koi", line: 1, character: 32); // on "ProductId" decl
        Assert.Contains(refs, r => r.Uri == "file:///ordering.koi");
        Assert.Contains(refs, r => r.Uri == "file:///catalog.koi");
    }

    [Fact]
    public void References_for_a_non_declaration_name_are_empty()
    {
        var src = "context C {\n  value V { x: Decimal }\n}\n";
        Assert.Empty(Svc.ReferencesAt(Doc(src), U, line: 1, character: 18)); // on "Decimal" (primitive)
    }

    // ---- Rename -----------------------------------------------------------

    [Fact]
    public void Rename_returns_edits_for_every_reference()
    {
        var src =
            "context C {\n" +
            "  value Money { amount: Decimal }\n" +
            "  value Line { price: Money }\n" +
            "}\n";
        var edits = Svc.RenameAt(Doc(src), U, line: 1, character: 9, newName: "Cash"); // on "Money" decl
        Assert.NotNull(edits);
        Assert.Equal(2, edits!.Count); // declaration + one use
    }

    [Fact]
    public void Rename_rejects_an_invalid_identifier()
    {
        var src = "context C {\n  value Money { amount: Decimal }\n}\n";
        Assert.Null(Svc.RenameAt(Doc(src), U, line: 1, character: 9, newName: "1Bad"));
        Assert.Null(Svc.RenameAt(Doc(src), U, line: 1, character: 9, newName: "has space"));
    }

    [Fact]
    public void Rename_on_a_primitive_returns_null()
    {
        var src = "context C {\n  value V { x: Decimal }\n}\n";
        Assert.Null(Svc.RenameAt(Doc(src), U, line: 1, character: 18, newName: "Money"));
    }

    [Fact]
    public void HoverAt_resolves_across_files()
    {
        var ordering = "context Ordering {\n  value Line { product: ProductId }\n}\n";
        var catalog = "context Catalog {\n  entity Product identified by ProductId { sku: String }\n}\n";
        var docs = new Dictionary<string, string>
        {
            ["file:///ordering.koi"] = ordering,
            ["file:///catalog.koi"] = catalog,
        };
        var hover = Svc.HoverAt(docs, "file:///ordering.koi", line: 1, character: 25); // on "ProductId"
        Assert.NotNull(hover);
        Assert.Contains("Product", hover!.Markdown); // owning entity
    }
}
