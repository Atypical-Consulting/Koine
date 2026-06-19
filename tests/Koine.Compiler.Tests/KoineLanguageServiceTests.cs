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
        items.ShouldContain(i => i.Label == "Decimal");
        items.ShouldContain(i => i.Label == "List");
        items.ShouldContain(i => i.Label == "V");
    }

    [Fact]
    public void Type_position_filters_by_partial_prefix()
    {
        var src = "context C {\n  value V { x: Stri }\n}\n";
        var items = Complete(src, line: 1, ch: 18);
        items.ShouldContain(i => i.Label == "String");
        items.ShouldNotContain(i => i.Label == "Decimal");
    }

    [Fact]
    public void Type_position_on_broken_doc_still_offers_primitives()
    {
        var src = "context C {\n  value V { x: ";
        var items = Complete(src, line: 1, ch: 15);
        items.ShouldContain(i => i.Label == "String");
        items.ShouldContain(i => i.Label == "List");
    }

    [Fact]
    public void Top_level_declaration_start_offers_context_keyword()
    {
        var items = Complete("\n", line: 0, ch: 0);
        items.ShouldContain(i => i.Label == "context" && i.Kind == CompletionItemKind.Keyword);
    }

    [Fact]
    public void Inside_service_offers_operation_and_usecase_keywords()
    {
        // serviceMember : operationDecl | usecaseDecl — both are legal at service scope.
        var src = "context C {\n  service S {\n    \n  }\n}\n";
        var items = Complete(src, line: 2, ch: 4);
        items.ShouldContain(i => i.Label == "operation");
        items.ShouldContain(i => i.Label == "usecase");
        items.ShouldNotContain(i => i.Label == "value"); // not a service member
    }

    [Fact]
    public void No_completion_inside_a_regex_literal()
    {
        var src = "context C {\n  value V { invariant raw matches /ab\n}\n";
        var items = Complete(src, line: 1, ch: 36);
        items.ShouldBeEmpty();
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
        items.ShouldContain(i => i.Label == "Draft" && i.Kind == CompletionItemKind.EnumMember);
        items.ShouldNotContain(i => i.Label == "Placed");
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
        items.ShouldBeEmpty();
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
        var amount = items.Where(i => i.Label == "amount").ShouldHaveSingleItem();
        amount.Kind.ShouldBe(CompletionItemKind.Field);
        amount.Detail.ShouldBe("Decimal");
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
        var lines = items.Where(i => i.Label == "lines").ShouldHaveSingleItem();
        lines.Kind.ShouldBe(CompletionItemKind.Field);
        lines.Detail.ShouldBe("List<OrderLine>");
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
        var spec = items.Where(i => i.Label == "IsBig").ShouldHaveSingleItem();
        spec.Kind.ShouldBe(CompletionItemKind.Method);
    }

    [Fact]
    public void Field_completion_does_not_fire_at_a_type_position()
    {
        // After ':' the type list — not field names — must be offered (no Field-kind noise).
        var src = "context C {\n  value Money {\n    amount: Decimal\n    other:  \n  }\n}\n";
        var items = Complete(src, line: 3, ch: 11); // after "other: "
        items.ShouldNotContain(i => i.Kind == CompletionItemKind.Field);
        items.ShouldContain(i => i.Label == "Decimal");
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
        hover.ShouldNotBeNull();
        hover.Markdown.ShouldContain("The amount owed");
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
        hover.ShouldNotBeNull();
        hover.Markdown.ShouldContain("Money");
        hover.Markdown.ShouldContain("Value");     // the kind label
        hover.Markdown.ShouldContain("amount");     // a member
    }

    [Fact]
    public void Hover_returns_null_on_a_broken_document()
    {
        var src = "context C {\n  value Money { amount: ";
        Svc.HoverAt(Doc(src), U, line: 1, character: 9).ShouldBeNull(); // over "Money", parse fails
    }

    [Fact]
    public void Hover_over_whitespace_returns_null()
    {
        var src = "context C {\n  value Money { amount: Decimal }\n}\n";
        Svc.HoverAt(Doc(src), U, line: 0, character: 0).ShouldBeNull();
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
        hover.ShouldNotBeNull();
        hover.Markdown.ShouldContain("List<OrderLine>");
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
        hover.ShouldNotBeNull();
        hover.Markdown.ShouldContain("enum member of Color");
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
        hover.ShouldNotBeNull();
        hover.Markdown.ShouldContain("spec on Money");
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
        def.ShouldNotBeNull();
        def.Target.Line.ShouldBe(2);  // 1-based line of "value Money"
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
        def.ShouldNotBeNull();
        def.Target.Line.ShouldBe(2);
    }

    [Fact]
    public void Definition_of_a_primitive_is_null()
    {
        var src = "context C {\n  value V { x: Decimal }\n}\n";
        Svc.DefinitionAt(Doc(src), U, line: 1, character: 18).ShouldBeNull(); // over "Decimal"
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
        def.ShouldNotBeNull();
        def.Target.Line.ShouldBe(3); // 1-based line of the spec declaration
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
        def.ShouldBeNull();
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
        def.ShouldNotBeNull();
        def.Uri.ShouldBe("file:///catalog.koi");
    }

    // ---- Completion: new keyword starters --------------------------------

    [Fact]
    public void Context_scope_offers_readmodel_query_module_import_keywords()
    {
        var src = "context C {\n  \n}\n";
        var items = Complete(src, line: 1, ch: 2);
        foreach (var kw in new[] { "module", "import", "readmodel", "query", "value", "service" })
        {
            items.ShouldContain(i => i.Label == kw && i.Kind == CompletionItemKind.Keyword);
        }
    }

    [Fact]
    public void File_scope_offers_contextmap_keyword()
    {
        var items = Complete("\n", line: 0, ch: 0);
        items.ShouldContain(i => i.Label == "contextmap");
        items.ShouldContain(i => i.Label == "context");
    }

    [Fact]
    public void Module_scope_offers_type_keywords_not_services()
    {
        var src = "context C {\n  module M {\n    \n  }\n}\n";
        var items = Complete(src, line: 2, ch: 4);
        items.ShouldContain(i => i.Label == "value");
        items.ShouldContain(i => i.Label == "module");
        items.ShouldNotContain(i => i.Label == "service"); // not a module member
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
        items.ShouldContain(i => i.Label == "Red" && i.Kind == CompletionItemKind.EnumMember);
        items.ShouldContain(i => i.Label == "Green");
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
        var amount = items.Where(i => i.Label == "amount").ShouldHaveSingleItem();
        amount.Kind.ShouldBe(CompletionItemKind.Property);
        amount.Detail.ShouldBe("Decimal");
    }

    [Fact]
    public void Member_access_on_broken_document_offers_nothing()
    {
        var src = "context C {\n  value Money { amount: Decimal }\n  value Line { total: Money. ";
        var items = Complete(src, line: 2, ch: 28);
        items.ShouldBeEmpty();
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
        var shop = symbols.ShouldHaveSingleItem();
        shop.Name.ShouldBe("Shop");
        shop.Kind.ShouldBe(SymbolKind.Namespace);

        var money = shop.Children.Where(c => c.Name == "Money").ShouldHaveSingleItem();
        money.Kind.ShouldBe(SymbolKind.Class);
        money.Children.ShouldContain(c => c.Name == "amount" && c.Kind == SymbolKind.Field);

        var status = shop.Children.Where(c => c.Name == "Status").ShouldHaveSingleItem();
        status.Kind.ShouldBe(SymbolKind.Enum);
        status.Children.ShouldContain(c => c.Name == "Open" && c.Kind == SymbolKind.EnumMember);
    }

    [Fact]
    public void DocumentSymbols_on_broken_document_is_empty()
    {
        Svc.DocumentSymbols("context C {\n  value V { x: ").ShouldBeEmpty();
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
        refs.Count.ShouldBe(3); // declaration + two uses
        refs.ShouldAllBe(r => r.Uri == U);
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
        refs.ShouldContain(r => r.Uri == "file:///ordering.koi");
        refs.ShouldContain(r => r.Uri == "file:///catalog.koi");
    }

    [Fact]
    public void References_for_a_non_declaration_name_are_empty()
    {
        var src = "context C {\n  value V { x: Decimal }\n}\n";
        Svc.ReferencesAt(Doc(src), U, line: 1, character: 18).ShouldBeEmpty(); // on "Decimal" (primitive)
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
        edits.ShouldNotBeNull();
        edits.Count.ShouldBe(2); // declaration + one use
    }

    [Fact]
    public void Rename_rejects_an_invalid_identifier()
    {
        var src = "context C {\n  value Money { amount: Decimal }\n}\n";
        Svc.RenameAt(Doc(src), U, line: 1, character: 9, newName: "1Bad").ShouldBeNull();
        Svc.RenameAt(Doc(src), U, line: 1, character: 9, newName: "has space").ShouldBeNull();
    }

    [Fact]
    public void Rename_on_a_primitive_returns_null()
    {
        var src = "context C {\n  value V { x: Decimal }\n}\n";
        Svc.RenameAt(Doc(src), U, line: 1, character: 18, newName: "Money").ShouldBeNull();
    }

    [Fact]
    public void Rename_of_a_field_is_scoped_to_its_owning_type()
    {
        // Two types each declare a field named "amount". Renaming Money.amount must NOT
        // touch Order.amount — the field is type-scoped.
        var src =
            "context C {\n" +
            "  value Money { amount: Decimal\n" +
            "    invariant amount >= 0 }\n" +
            "  value Order { amount: Decimal }\n" +
            "}\n";
        // Cursor on the "amount" declaration in Money (line index 1 = "value Money …").
        var edits = Svc.RenameAt(Doc(src), U, line: 1, character: 18, newName: "total");
        edits.ShouldNotBeNull();
        // Money's declaration (line 2, 1-based) + its use in the invariant (line 3); Order.amount excluded.
        edits.Count.ShouldBe(2);
        edits.ShouldContain(r => r.Line == 2); // the declaration
        edits.ShouldContain(r => r.Line == 3); // the invariant reference
        // Crucially: no edit lands on Order's "amount" (line 4, 1-based).
        edits.ShouldNotContain(r => r.Line == 4);
    }

    [Fact]
    public void Rename_of_an_enum_member_is_scoped_to_its_owning_enum()
    {
        // Two enums each declare a member "Active". Renaming Phase.Active must NOT touch State.Active.
        var src =
            "context C {\n" +
            "  enum Phase { Active, Done }\n" +
            "  enum State { Active, Closed }\n" +
            "}\n";
        // Cursor inside the "Active" declaration in Phase (line index 1).
        var edits = Svc.RenameAt(Doc(src), U, line: 1, character: 16, newName: "Running");
        edits.ShouldNotBeNull();
        edits.ShouldHaveSingleItem();                            // only Phase.Active's declaration
        edits.ShouldContain(r => r.Line == 2);        // Phase line (1-based)
        edits.ShouldNotContain(r => r.Line == 3);  // State.Active untouched
    }

    [Fact]
    public void Rename_of_a_type_still_updates_all_references_across_files()
    {
        var ordering = "context Ordering {\n  value Line { product: ProductId }\n}\n";
        var catalog = "context Catalog {\n  entity Product identified by ProductId { sku: String }\n}\n";
        var docs = new Dictionary<string, string>
        {
            ["file:///ordering.koi"] = ordering,
            ["file:///catalog.koi"] = catalog,
        };
        // Rename the ProductId ID type from its declaration in catalog.koi.
        var edits = Svc.RenameAt(docs, "file:///catalog.koi", line: 1, character: 32, newName: "ProdId");
        edits.ShouldNotBeNull();
        edits.ShouldContain(r => r.Uri == "file:///ordering.koi");
        edits.ShouldContain(r => r.Uri == "file:///catalog.koi");
    }

    [Fact]
    public void Rename_of_a_type_does_not_touch_a_same_named_enum_member_or_field()
    {
        // The corruption repro: a TYPE Status, an enum member Status, and a field typed Status all
        // share the name. Renaming the TYPE must rewrite only the type declaration and its TypeRef
        // uses — never the Phase enum member named Status, nor a field name.
        var src =
            "context C {\n" +
            "  enum Phase { Status, Done }\n" +
            "  value Status { x: Decimal }\n" +
            "  value Line { p: Status }\n" +
            "}\n";
        // Cursor on the "Status" TYPE declaration (line index 2 = "value Status …", col 8).
        var edits = Svc.RenameAt(Doc(src), U, line: 2, character: 9, newName: "Phase2");
        edits.ShouldNotBeNull();
        // The type decl (line 3, 1-based) + its TypeRef use in Line (line 4). The enum member on
        // line 2 must NOT be rewritten.
        edits.Count.ShouldBe(2);
        edits.ShouldContain(r => r.Line == 3); // the type declaration
        edits.ShouldContain(r => r.Line == 4); // the TypeRef use
        edits.ShouldNotContain(r => r.Line == 2); // the Phase enum member named Status
    }

    [Fact]
    public void Rename_of_an_enum_member_does_not_touch_a_same_named_type()
    {
        var src =
            "context C {\n" +
            "  enum Phase { Status, Done }\n" +
            "  value Status { x: Decimal }\n" +
            "  value Line { p: Status }\n" +
            "}\n";
        // Cursor on the "Status" ENUM MEMBER (line index 1, "enum Phase { Status, Done }", col ~15).
        var enumMemberCol = src.Split('\n')[1].IndexOf("Status", StringComparison.Ordinal) + 1;
        var edits = Svc.RenameAt(Doc(src), U, line: 1, character: enumMemberCol, newName: "Active");
        edits.ShouldNotBeNull();
        // Only the enum member declaration (line 2). The TYPE Status (line 3) and its use (line 4)
        // must be untouched.
        edits.ShouldContain(r => r.Line == 2);
        edits.ShouldNotContain(r => r.Line == 3); // the type declaration
        edits.ShouldNotContain(r => r.Line == 4); // the TypeRef use
    }

    [Fact]
    public void Rename_of_a_field_on_an_event_returns_edits()
    {
        // Finding B: a field on an `event` resolves enclosingType via TokenLocator; without `event`
        // in the fielded-type set this was a silent no-op (RenameAt returned null). The event body
        // is members-only (no expression context), so the only reference is the declaration itself.
        var src =
            "context C {\n" +
            "  event Placed { total: Decimal }\n" +
            "}\n";
        // Cursor on the "total" field declaration (line index 1).
        var col = src.Split('\n')[1].IndexOf("total", StringComparison.Ordinal) + 1;
        var edits = Svc.RenameAt(Doc(src), U, line: 1, character: col, newName: "amount");
        edits.ShouldNotBeNull();
        edits.ShouldHaveSingleItem();
        edits.ShouldContain(r => r.Line == 2); // the declaration
    }

    [Fact]
    public void Rename_of_a_field_on_an_integration_event_returns_edits()
    {
        var src =
            "context C {\n" +
            "  integration event Placed { total: Decimal }\n" +
            "}\n";
        var col = src.Split('\n')[1].IndexOf("total", StringComparison.Ordinal) + 1;
        var edits = Svc.RenameAt(Doc(src), U, line: 1, character: col, newName: "amount");
        edits.ShouldNotBeNull();
        edits.ShouldHaveSingleItem();
        edits.ShouldContain(r => r.Line == 2);
    }

    // ---- Prepare rename ---------------------------------------------------

    [Fact]
    public void PrepareRename_returns_the_identifier_range_and_placeholder()
    {
        var src =
            "context C {\n" +
            "  value Money { amount: Decimal }\n" +
            "  value Line { price: Money }\n" +
            "}\n";
        var range = Svc.PrepareRenameAt(Doc(src), U, line: 1, character: 9); // on "Money" decl
        range.ShouldNotBeNull();
        range.Line.ShouldBe(2);          // 1-based line of the "Money" token
        range.StartColumn.ShouldBe(8);   // 0-based column where "Money" starts
        range.EndColumn.ShouldBe(13);    // half-open end (8 + len("Money"))

        // The placeholder is the current name.
        var name = Svc.NameAt(Doc(src), U, line: 1, character: 9);
        name.ShouldBe("Money");
    }

    [Fact]
    public void PrepareRename_inside_a_string_literal_returns_null()
    {
        // A doc comment / string context: cursor inside the quoted text.
        var src = "context C {\n  value V { x: String = \"Money\" }\n}\n";
        // Column 26 is inside the "Money" string literal.
        Svc.PrepareRenameAt(Doc(src), U, line: 1, character: 26).ShouldBeNull();
    }

    [Fact]
    public void PrepareRename_on_a_primitive_returns_null()
    {
        var src = "context C {\n  value V { x: Decimal }\n}\n";
        Svc.PrepareRenameAt(Doc(src), U, line: 1, character: 18).ShouldBeNull(); // on "Decimal"
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
        hover.ShouldNotBeNull();
        hover.Markdown.ShouldContain("Product"); // owning entity
    }
}
