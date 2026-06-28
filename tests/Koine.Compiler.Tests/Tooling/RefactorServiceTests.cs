using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Semantics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// The selection-driven refactor service (<see cref="KoineLanguageService.RefactorsAt"/>). Tests are
/// robust: each applies the computed edits back to the source and re-parses, asserting the resulting
/// model's semantics rather than exact byte strings.
/// </summary>
public class RefactorServiceTests
{
    private static readonly KoineLanguageService Svc = new();
    private const string U = "file:///t.koi";

    private static IReadOnlyList<CodeActionEdit> RefactorsAt(string src, int sl, int sc, int el, int ec) =>
        Svc.RefactorsAt(new Dictionary<string, string> { [U] = src }, U, sl, sc, el, ec);

    /// <summary>The "Extract value object" refactor at this selection (distinguished by Title from the
    /// sibling "Extract entity" refactor, which shares the <c>refactor.extract</c> Kind).</summary>
    private static CodeActionEdit ExtractValueObjectAt(string src, int sl, int sc, int el, int ec) =>
        RefactorsAt(src, sl, sc, el, ec)
            .Where(a => a.Kind == "refactor.extract" && a.Title.StartsWith("Extract value object", StringComparison.Ordinal))
            .ShouldHaveSingleItem();

    /// <summary>Applies a refactor's edits to the original source (offset-based, last-edit-first).</summary>
    private static string Apply(string src, CodeActionEdit action)
    {
        // Apply edits from the highest offset down so earlier offsets stay valid.
        foreach (var edit in action.Edits.OrderByDescending(e => e.Range.Offset))
        {
            var span = edit.Range;
            src = src[..span.Offset] + edit.NewText + src[(span.Offset + span.Length)..];
        }

        return src;
    }

    private static KoineModel Parse(string src)
    {
        var (model, diagnostics) = new KoineCompiler().Parse(src);
        diagnostics.ShouldBeEmpty();
        model.ShouldNotBeNull();
        return model;
    }

    [Fact]
    public void Extracting_a_single_field_produces_a_parseable_value_object_and_rewires_the_origin()
    {
        // Line 1 (0-based): "  value Address { street: String }". "street" spans cols 18..24.
        var src = "context C {\n  value Address { street: String }\n}\n";
        var extract = ExtractValueObjectAt(src, 1, 18, 1, 24);
        extract.Edits.Count.ShouldBe(2);

        var applied = Apply(src, extract);
        var model = Parse(applied); // re-parses cleanly

        var types = model.Contexts[0].Types;
        // A new ExtractedValue value object now exists, carrying the moved field.
        var extracted = types.Single(t => t.Name == "ExtractedValue").ShouldBeOfType<ValueObjectDecl>();
        extracted.Members.ShouldContain(m => m.Name == "street");

        // The original Address now references the extracted value via the placeholder field.
        var address = types.Single(t => t.Name == "Address").ShouldBeOfType<ValueObjectDecl>();
        var field = address.Members.ShouldHaveSingleItem();
        field.Name.ShouldBe("extracted");
        field.Type.Name.ShouldBe("ExtractedValue");
        address.Members.ShouldNotContain(m => m.Name == "street");
    }

    [Fact]
    public void A_same_line_trailing_comment_moves_with_the_extracted_field()
    {
        // The trailing comment parses as the NEXT field's leading trivia; the extract must absorb it
        // so it travels into the new value object rather than orphaning onto the placeholder field.
        var src =
            "context C {\n" +
            "  value Address { street: String  // the street name\n" +
            "  city: String }\n" +
            "}\n";
        // Select "street" on line 1 (cols 18..24).
        var extract = ExtractValueObjectAt(src, 1, 18, 1, 24);

        var applied = Apply(src, extract);
        Parse(applied); // re-parses cleanly

        var commentIdx = applied.IndexOf("// the street name", StringComparison.Ordinal);
        var voIdx = applied.IndexOf("ExtractedValue {", StringComparison.Ordinal);
        var placeholderIdx = applied.IndexOf("extracted: ExtractedValue", StringComparison.Ordinal);
        (commentIdx >= 0).ShouldBeTrue("the comment must survive");
        // The comment sits inside the extracted value object (after its header, before the placeholder
        // field that replaced the origin), i.e. it moved WITH the field rather than being left behind.
        (commentIdx > voIdx && commentIdx < placeholderIdx).ShouldBeTrue();
    }

    [Fact]
    public void Extracting_contiguous_fields_moves_all_of_them()
    {
        // Members are newline-separated. Lines 2/3/4 (0-based) carry street/city/zip.
        var src =
            "context C {\n" +
            "  value Address {\n" +
            "    street: String\n" +
            "    city: String\n" +
            "    zip: String\n" +
            "  }\n" +
            "}\n";
        // Select from the start of "street" (line 2, col 4) through the end of "city" (line 3, col 16).
        var extract = ExtractValueObjectAt(src, 2, 4, 3, 16);
        var model = Parse(Apply(src, extract));

        var types = model.Contexts[0].Types;
        var extracted = types.Single(t => t.Name == "ExtractedValue").ShouldBeOfType<ValueObjectDecl>();
        extracted.Members.ShouldContain(m => m.Name == "street");
        extracted.Members.ShouldContain(m => m.Name == "city");
        extracted.Members.ShouldNotContain(m => m.Name == "zip");

        var address = types.Single(t => t.Name == "Address").ShouldBeOfType<ValueObjectDecl>();
        address.Members.ShouldContain(m => m.Name == "extracted");
        address.Members.ShouldContain(m => m.Name == "zip");
        address.Members.ShouldNotContain(m => m.Name == "street");
    }

    [Fact]
    public void No_action_when_the_cursor_is_on_the_type_keyword()
    {
        var src = "context C {\n  value Address { street: String }\n}\n";
        // Cursor on the "value" keyword (cols 2..7), not on a field.
        var actions = RefactorsAt(src, 1, 2, 1, 7);
        actions.ShouldNotContain(a => a.Kind == "refactor.extract");
    }

    [Fact]
    public void No_action_when_the_selection_is_in_a_spec_body()
    {
        // A spec sits in the context body, not in a fielded type — no extractable fields there.
        var src =
            "context C {\n" +
            "  value Money { amount: Decimal }\n" +
            "  spec Positive on Money = amount > 0\n" +
            "}\n";
        // Line 2 = the spec line; place the cursor on "amount" inside the spec expression.
        var col = src.Split('\n')[2].IndexOf("amount", StringComparison.Ordinal);
        var actions = RefactorsAt(src, 2, col, 2, col + 6);
        actions.ShouldNotContain(a => a.Kind == "refactor.extract");
    }

    [Fact]
    public void Extracting_a_field_from_an_entity_is_offered()
    {
        var src =
            "context C {\n" +
            "  entity Order identified by OrderId {\n" +
            "    note: String\n" +
            "  }\n" +
            "}\n";
        // Line 2 = "    note: String"; "note" begins at col 4.
        var extract = ExtractValueObjectAt(src, 2, 4, 2, 8);

        var model = Parse(Apply(src, extract));
        var types = model.Contexts[0].Types;
        types.Any(t => t is ValueObjectDecl { Name: "ExtractedValue" }).ShouldBeTrue();
        var order = types.Single(t => t.Name == "Order").ShouldBeOfType<EntityDecl>();
        order.Members.Any(m => m is { Name: "extracted" } && m.Type.Name == "ExtractedValue").ShouldBeTrue();
    }

    [Fact]
    public void Extracting_a_field_with_a_doc_comment_moves_the_doc_and_keeps_the_origin_types_doc()
    {
        var src =
            "context C {\n" +
            "  /// An address value.\n" +
            "  value Address {\n" +
            "    /// The street name.\n" +
            "    street: String\n" +
            "    city: String\n" +
            "  }\n" +
            "}\n";
        // Line 4 (0-based) = "    street: String"; "street" begins at col 4.
        var extract = ExtractValueObjectAt(src, 4, 4, 4, 10);

        var applied = Apply(src, extract);
        var model = Parse(applied);
        var types = model.Contexts[0].Types;

        // The field's own doc travels with it into the new value object.
        var extracted = types.Single(t => t.Name == "ExtractedValue").ShouldBeOfType<ValueObjectDecl>();
        var moved = extracted.Members.Where(m => m.Name == "street").ShouldHaveSingleItem();
        moved.Doc.ShouldNotBeNull().ShouldContain("The street name.");

        // The origin type keeps its own doc (it was NOT consumed by the inserted value object).
        var address = types.Single(t => t.Name == "Address").ShouldBeOfType<ValueObjectDecl>();
        address.Doc.ShouldNotBeNull().ShouldContain("An address value.");
        address.Members.ShouldNotContain(m => m.Name == "street");
    }

    [Fact]
    public void A_comment_between_two_selected_fields_survives_in_the_new_value_object()
    {
        var src =
            "context C {\n" +
            "  value Address {\n" +
            "    street: String\n" +
            "    // the city it sits in\n" +
            "    city: String\n" +
            "    zip: String\n" +
            "  }\n" +
            "}\n";
        // Select from the start of "street" (line 2, col 4) through the end of "city" (line 4, col 16).
        var extract = ExtractValueObjectAt(src, 2, 4, 4, 16);

        var applied = Apply(src, extract);
        var model = Parse(applied);

        // The between-field comment is preserved in the moved range (it landed in the new VO text).
        applied.ShouldContain("// the city it sits in");

        var types = model.Contexts[0].Types;
        var extracted = types.Single(t => t.Name == "ExtractedValue").ShouldBeOfType<ValueObjectDecl>();
        extracted.Members.ShouldContain(m => m.Name == "street");
        extracted.Members.ShouldContain(m => m.Name == "city");
        // The comment is leading trivia of the `city` member it precedes.
        var city = extracted.Members.Single(m => m.Name == "city");
        city.LeadingTrivia.ShouldContain(t => t.Text.Contains("the city it sits in"));
    }

    [Fact]
    public void A_derived_field_yields_no_action()
    {
        var src =
            "context C {\n" +
            "  value Line {\n" +
            "    unitPrice: Decimal\n" +
            "    quantity: Int\n" +
            "    subtotal: Decimal = unitPrice * quantity\n" +
            "  }\n" +
            "}\n";
        // Select the derived `subtotal` field on line 4; "subtotal" begins at col 4.
        var actions = RefactorsAt(src, 4, 4, 4, 12);
        actions.ShouldNotContain(a => a.Kind == "refactor.extract");
    }

    [Fact]
    public void Extracting_an_entity_produces_a_parseable_entity_with_an_identity_and_rewires_the_origin()
    {
        // Line 1 (0-based): "  value Address { street: String }". "street" spans cols 18..24.
        var src = "context C {\n  value Address { street: String }\n}\n";
        var actions = RefactorsAt(src, 1, 18, 1, 24);

        // The "Extract entity" action is distinguished from "Extract value object" by its Title.
        var extract = actions
            .Where(a => a.Kind == "refactor.extract" && a.Title.StartsWith("Extract entity", StringComparison.Ordinal))
            .ShouldHaveSingleItem();
        extract.Edits.Count.ShouldBe(2);

        var applied = Apply(src, extract);
        var model = Parse(applied); // re-parses cleanly

        var types = model.Contexts[0].Types;
        // A new entity (with a non-empty identity) now exists, carrying the moved field.
        var extracted = types.Single(t => t.Name == "ExtractedEntity").ShouldBeOfType<EntityDecl>();
        extracted.IdentityName.ShouldNotBeNullOrEmpty();
        extracted.Members.ShouldContain(m => m.Name == "street");

        // The original Address now references the extracted entity via the placeholder field.
        var address = types.Single(t => t.Name == "Address").ShouldBeOfType<ValueObjectDecl>();
        var field = address.Members.ShouldHaveSingleItem();
        field.Name.ShouldBe("extracted");
        field.Type.Name.ShouldBe("ExtractedEntity");
        address.Members.ShouldNotContain(m => m.Name == "street");
    }

    [Fact]
    public void Extracting_when_a_type_named_ExtractedValue_already_exists_produces_a_unique_name()
    {
        var src =
            "context C {\n" +
            "  value ExtractedValue { tag: String }\n" +
            "  value Address {\n" +
            "    street: String\n" +
            "  }\n" +
            "}\n";
        // Line 3 (0-based) = "    street: String"; "street" begins at col 4.
        var extract = ExtractValueObjectAt(src, 3, 4, 3, 10);

        var model = Parse(Apply(src, extract));
        var types = model.Contexts[0].Types;

        // The pre-existing ExtractedValue is untouched; the new VO took a disambiguated name.
        types.Where(t => t is ValueObjectDecl { Name: "ExtractedValue" }).ShouldHaveSingleItem();
        var generated = types.Single(t => t.Name == "ExtractedValue2").ShouldBeOfType<ValueObjectDecl>();
        generated.Members.ShouldContain(m => m.Name == "street");

        var address = types.Single(t => t.Name == "Address").ShouldBeOfType<ValueObjectDecl>();
        address.Members.ShouldContain(m => m.Type.Name == "ExtractedValue2");
    }

    /// <summary>The "Extract aggregate" refactor at this selection (distinguished by Title from the
    /// sibling extract refactors, which share the <c>refactor.extract</c> Kind).</summary>
    private static CodeActionEdit ExtractAggregateAt(string src, int sl, int sc, int el, int ec) =>
        RefactorsAt(src, sl, sc, el, ec)
            .Where(a => a.Kind == "refactor.extract" && a.Title.StartsWith("Extract aggregate", StringComparison.Ordinal))
            .ShouldHaveSingleItem();

    [Fact]
    public void Extracting_an_aggregate_wraps_a_top_level_entity_as_the_root()
    {
        var src =
            "context C {\n" +
            "  entity Order identified by OrderId {\n" +
            "    note: String\n" +
            "  }\n" +
            "}\n";
        // Select the whole top-level entity: from the start of "entity" (line 1, col 2) through just
        // past its closing brace (line 3, col 3).
        var extract = ExtractAggregateAt(src, 1, 2, 3, 3);

        var applied = Apply(src, extract);
        var model = Parse(applied); // re-parses cleanly

        var types = model.Contexts[0].Types;
        // A new aggregate now wraps the entity, naming it as the root.
        var aggregate = types.OfType<AggregateDecl>().ShouldHaveSingleItem();
        aggregate.RootName.ShouldBe("Order");
        aggregate.Name.ShouldNotBe("Order");
        aggregate.Types.OfType<EntityDecl>().ShouldContain(e => e.Name == "Order");
    }

    [Fact]
    public void No_aggregate_action_when_the_selection_is_only_on_member_fields()
    {
        var src =
            "context C {\n" +
            "  entity Order identified by OrderId {\n" +
            "    note: String\n" +
            "  }\n" +
            "}\n";
        // Select just the "note" field on line 2 (cols 4..8) — not the whole entity.
        var actions = RefactorsAt(src, 2, 4, 2, 8);
        actions.ShouldNotContain(a => a.Title.StartsWith("Extract aggregate", StringComparison.Ordinal));
    }

    [Fact]
    public void No_aggregate_action_when_the_root_candidate_is_already_nested_in_an_aggregate()
    {
        var src =
            "context C {\n" +
            "  aggregate Sales root Order {\n" +
            "    entity Order identified by OrderId {\n" +
            "      note: String\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        // Select the whole nested entity (line 2, col 4 .. line 4, col 6); it is NOT a top-level type.
        var actions = RefactorsAt(src, 2, 4, 4, 6);
        actions.ShouldNotContain(a => a.Title.StartsWith("Extract aggregate", StringComparison.Ordinal));
    }

    /// <summary>The "Inline value object" refactor at this selection (a plain <c>refactor</c> Kind, the
    /// inverse of extract).</summary>
    private static CodeActionEdit InlineValueObjectAt(string src, int sl, int sc, int el, int ec) =>
        RefactorsAt(src, sl, sc, el, ec)
            .Where(a => a.Kind == "refactor" && a.Title.StartsWith("Inline value object", StringComparison.Ordinal))
            .ShouldHaveSingleItem();

    [Fact]
    public void Inlining_a_single_use_value_object_inlines_its_members_and_removes_the_declaration()
    {
        var src =
            "context C {\n" +
            "  value Address {\n" +
            "    street: String\n" +
            "    city: String\n" +
            "  }\n" +
            "  value Customer {\n" +
            "    addr: Address\n" +
            "  }\n" +
            "}\n";
        // Line 6 (0-based) = "    addr: Address"; the "Address" reference begins at col 10.
        var inline = InlineValueObjectAt(src, 6, 10, 6, 17);

        var applied = Apply(src, inline);
        var model = Parse(applied); // re-parses cleanly

        var types = model.Contexts[0].Types;
        // The single-use Address declaration is gone.
        types.ShouldNotContain(t => t.Name == "Address");

        // Customer now carries Address's members inlined in place of the `addr: Address` field.
        var customer = types.Single(t => t.Name == "Customer").ShouldBeOfType<ValueObjectDecl>();
        customer.Members.ShouldContain(m => m.Name == "street");
        customer.Members.ShouldContain(m => m.Name == "city");
        customer.Members.ShouldNotContain(m => m.Name == "addr");
    }

    [Fact]
    public void No_inline_action_when_the_value_object_is_referenced_more_than_once()
    {
        var src =
            "context C {\n" +
            "  value Address {\n" +
            "    street: String\n" +
            "  }\n" +
            "  value Customer {\n" +
            "    home: Address\n" +
            "    work: Address\n" +
            "  }\n" +
            "}\n";
        // Line 5 (0-based) = "    home: Address"; the "Address" reference begins at col 10.
        var actions = RefactorsAt(src, 5, 10, 5, 17);
        actions.ShouldNotContain(a => a.Kind == "refactor" && a.Title.StartsWith("Inline value object", StringComparison.Ordinal));
    }

    [Fact]
    public void No_inline_action_when_the_value_object_carries_invariants()
    {
        var src =
            "context C {\n" +
            "  value Money {\n" +
            "    amount: Decimal\n" +
            "    invariant amount > 0\n" +
            "  }\n" +
            "  value Price {\n" +
            "    value: Money\n" +
            "  }\n" +
            "}\n";
        // Line 6 (0-based) = "    value: Money"; the "Money" reference begins at col 11.
        var actions = RefactorsAt(src, 6, 11, 6, 16);
        actions.ShouldNotContain(a => a.Kind == "refactor" && a.Title.StartsWith("Inline value object", StringComparison.Ordinal));
    }

    [Fact]
    public void No_inline_action_when_the_selection_is_on_a_primitive_typed_field()
    {
        var src = "context C {\n  value Address { street: String }\n}\n";
        // Select "street" (a primitive-typed field, not a VO reference) on line 1 (cols 18..24).
        var actions = RefactorsAt(src, 1, 18, 1, 24);
        actions.ShouldNotContain(a => a.Kind == "refactor" && a.Title.StartsWith("Inline value object", StringComparison.Ordinal));
    }

    [Fact]
    public void No_inline_action_for_a_member_less_value_object_and_no_throw()
    {
        var src =
            "context C {\n" +
            "  value Empty {}\n" +
            "  entity Order identified by OrderId {\n" +
            "    e: Empty\n" +
            "  }\n" +
            "}\n";
        // Line 3 (0-based) = "    e: Empty"; the "Empty" reference spans cols 7..12. A member-less VO has
        // nothing to inline, so no action is offered — and computing the refactor must not throw
        // (BuildInline used to index inlined[0] on an empty Members list).
        var actions = Should.NotThrow(() => RefactorsAt(src, 3, 7, 3, 12));
        actions.ShouldNotContain(a => a.Kind == "refactor" && a.Title.StartsWith("Inline value object", StringComparison.Ordinal));
    }

    /// <summary>The "Move to context 'Target'" refactor at this selection (a plain <c>refactor</c> Kind),
    /// for the named target context.</summary>
    private static CodeActionEdit MoveToContextAt(string src, string target, int sl, int sc, int el, int ec) =>
        RefactorsAt(src, sl, sc, el, ec)
            .Where(a => a.Kind == "refactor" && a.Title == $"Move to context '{target}'")
            .ShouldHaveSingleItem();

    private static (KoineModel Model, IReadOnlyList<Diagnostic> Diagnostics) ParseAndValidate(string src)
    {
        var (model, parseDiags) = new KoineCompiler().Parse(src);
        model.ShouldNotBeNull();
        var diags = parseDiags.Concat(new SemanticValidator().Validate(model)).ToList();
        return (model, diags);
    }

    [Fact]
    public void Moving_a_standalone_type_relocates_it_to_the_target_context_with_no_diagnostics()
    {
        var src =
            "context A {\n" +
            "  value Address {\n" +
            "    street: String\n" +
            "    city: String\n" +
            "  }\n" +
            "}\n" +
            "context B {\n" +
            "  value Tag { name: String }\n" +
            "}\n";
        // Line 1 (0-based) = "  value Address {"; place the cursor inside the Address declaration.
        var move = MoveToContextAt(src, "B", 1, 8, 1, 8);

        var applied = Apply(src, move);
        var (model, diags) = ParseAndValidate(applied); // re-parses and validates cleanly
        diags.ShouldBeEmpty();

        var a = model.Contexts.Single(c => c.Name == "A").Types;
        var b = model.Contexts.Single(c => c.Name == "B").Types;
        // Address now lives in B and is gone from A.
        a.ShouldNotContain(t => t.Name == "Address");
        var moved = b.Single(t => t.Name == "Address").ShouldBeOfType<ValueObjectDecl>();
        moved.Members.ShouldContain(m => m.Name == "street");
        moved.Members.ShouldContain(m => m.Name == "city");
        // B's pre-existing type is undisturbed.
        b.ShouldContain(t => t.Name == "Tag");
    }

    [Fact]
    public void Moving_a_type_still_referenced_by_a_sibling_surfaces_a_cross_context_diagnostic()
    {
        // Sibling `Customer` in A references `Address`; after the move, that reference becomes a
        // cross-context one with no import, which the semantic validator must flag (not silent).
        var src =
            "context A {\n" +
            "  value Address {\n" +
            "    street: String\n" +
            "  }\n" +
            "  value Customer {\n" +
            "    home: Address\n" +
            "  }\n" +
            "}\n" +
            "context B {\n" +
            "  value Tag { name: String }\n" +
            "}\n";
        // Line 1 (0-based) = "  value Address {"; place the cursor inside the Address declaration.
        var move = MoveToContextAt(src, "B", 1, 8, 1, 8);

        var applied = Apply(src, move);
        var (model, diags) = ParseAndValidate(applied);

        // Address really moved to B...
        model.Contexts.Single(c => c.Name == "A").Types.ShouldNotContain(t => t.Name == "Address");
        model.Contexts.Single(c => c.Name == "B").Types.ShouldContain(t => t.Name == "Address");
        // ...and the now-dangling reference in A is surfaced, not silently broken.
        diags.ShouldNotBeEmpty();
    }

    [Fact]
    public void No_move_action_in_a_single_context_model()
    {
        var src =
            "context A {\n" +
            "  value Address {\n" +
            "    street: String\n" +
            "  }\n" +
            "}\n";
        // Cursor inside the Address declaration; there is no other context to move it to.
        var actions = RefactorsAt(src, 1, 8, 1, 8);
        actions.ShouldNotContain(a => a.Kind == "refactor" && a.Title.StartsWith("Move to context", StringComparison.Ordinal));
    }

    [Fact]
    public void No_move_action_when_the_selection_is_on_a_type_nested_in_an_aggregate()
    {
        var src =
            "context A {\n" +
            "  aggregate Sales root Order {\n" +
            "    entity Order identified by OrderId {\n" +
            "      note: String\n" +
            "    }\n" +
            "  }\n" +
            "}\n" +
            "context B {\n" +
            "  value Tag { name: String }\n" +
            "}\n";
        // Cursor inside the nested Order entity (line 2, 0-based); it is NOT a top-level context type.
        var actions = RefactorsAt(src, 2, 12, 2, 12);
        actions.ShouldNotContain(a => a.Kind == "refactor" && a.Title.StartsWith("Move to context", StringComparison.Ordinal));
    }

    [Fact]
    public void Moving_offers_one_action_per_other_context()
    {
        var src =
            "context A {\n" +
            "  value Address { street: String }\n" +
            "}\n" +
            "context B {\n" +
            "  value Tag { name: String }\n" +
            "}\n" +
            "context C {\n" +
            "  value Note { text: String }\n" +
            "}\n";
        // Cursor inside the Address declaration on line 1 (0-based).
        var moves = RefactorsAt(src, 1, 8, 1, 8)
            .Where(a => a.Kind == "refactor" && a.Title.StartsWith("Move to context", StringComparison.Ordinal))
            .ToList();
        moves.Count.ShouldBe(2);
        moves.ShouldContain(a => a.Title == "Move to context 'B'");
        moves.ShouldContain(a => a.Title == "Move to context 'C'");
    }

    // ---- Reindent robustness (tabs + column-0) ----------------------------

    [Fact]
    public void Extracting_from_a_tab_indented_source_produces_space_clean_indentation()
    {
        // Tab-indented members. Re-indenting must strip the leading TABS (not just spaces), so a moved
        // line does not end up as the new space-indent stacked on a leftover tab ("   \tcity").
        var src =
            "context C {\n" +
            "\tvalue Address {\n" +
            "\t\tstreet: String\n" +
            "\t\tcity: String\n" +
            "\t}\n" +
            "}\n";
        // Select from the start of "street" (line 2, char 2 — after two tabs) through the end of "city"
        // (line 3, char 6).
        var extract = ExtractValueObjectAt(src, 2, 2, 3, 6);
        var applied = Apply(src, extract);
        Parse(applied); // re-parses cleanly

        var lines = applied.Replace("\r\n", "\n").Split('\n');
        var cityLine = lines.Single(l => l.TrimStart(' ', '\t') == "city: String");
        var cityIndent = cityLine[..(cityLine.Length - cityLine.TrimStart(' ', '\t').Length)];
        cityIndent.ShouldNotContain('\t'); // re-indented cleanly to spaces, no leftover tab
    }

    [Fact]
    public void Moving_a_column0_declaration_indents_its_body_under_the_keyword()
    {
        // A type written flush against the context (column 0) with a flat body. The move must still nest
        // the body one level under the keyword in the target context rather than collapsing it flat.
        var src =
            "context A {\n" +
            "value Address {\n" +
            "street: String\n" +
            "}\n" +
            "}\n" +
            "context B {\n" +
            "value Tag { name: String }\n" +
            "}\n";
        // "value Address" is on line 1 (0-based) at column 0; cursor inside it.
        var move = MoveToContextAt(src, "B", 1, 2, 1, 2);
        var applied = Apply(src, move);
        Parse(applied); // re-parses cleanly

        var lines = applied.Replace("\r\n", "\n").Split('\n');
        var keywordLine = lines.Single(l => l.TrimStart().StartsWith("value Address", StringComparison.Ordinal));
        var bodyLine = lines.Single(l => l.TrimStart() == "street: String");
        static int Indent(string l) => l.Length - l.TrimStart(' ').Length;
        Indent(bodyLine).ShouldBeGreaterThan(Indent(keywordLine)); // body nested under its keyword
    }
}
