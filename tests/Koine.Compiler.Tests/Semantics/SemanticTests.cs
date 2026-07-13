using Koine.Compiler.Diagnostics;
using Koine.Compiler.Semantics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

public class SemanticTests
{
    private static IReadOnlyList<Diagnostic> Validate(string source)
    {
        var (model, syntax) = new KoineCompiler().Parse(source);
        syntax.ShouldBeEmpty();
        model.ShouldNotBeNull();
        return new SemanticValidator().Validate(model);
    }

    [Fact]
    public void Valid_fixture_has_no_diagnostics()
    {
        Validate(TestSupport.BillingFixture).ShouldBeEmpty();
    }

    [Fact]
    public void Unknown_type_reference_is_reported()
    {
        const string src = "context C {\n  value V {\n    x: Nope\n  }\n}\n";
        var diags = Validate(src);
        diags.ShouldContain(d => d.Code == DiagnosticCodes.UnknownType);
    }

    [Theory]
    [InlineData("id")]   // collides with the generated identity property
    [InlineData("Id")]
    [InlineData("equals")]
    [InlineData("getHashCode")]
    public void Entity_member_colliding_with_a_generated_member_is_reported(string member)
    {
        var src = $"context C {{\n  entity E identified by EId {{ {member}: Int }}\n}}\n";
        Validate(src).ShouldContain(d => d.Code == DiagnosticCodes.ReservedGeneratedMember);
    }

    [Fact]
    public void Entity_member_named_like_a_generated_member_but_distinct_after_casing_is_allowed()
    {
        // `gethashcode` PascalCases to `Gethashcode`, which does NOT collide with GetHashCode.
        const string src = "context C {\n  entity E identified by EId { gethashcode: Int }\n}\n";
        Validate(src).ShouldNotContain(d => d.Code == DiagnosticCodes.ReservedGeneratedMember);
    }

    [Theory]
    [InlineData("equals")]
    [InlineData("getHashCode")]
    [InlineData("getEqualityComponents")] // the overridden method on every value object
    public void Value_object_member_colliding_with_a_generated_member_is_reported(string member)
    {
        var src = $"context C {{\n  value V {{ {member}: Int }}\n}}\n";
        Validate(src).ShouldContain(d => d.Code == DiagnosticCodes.ReservedGeneratedMember);
    }

    [Theory]
    [InlineData("equals")]
    [InlineData("toString")]
    [InlineData("printMembers")]
    public void Event_field_colliding_with_a_record_member_is_reported(string field)
    {
        var src = $"context C {{\n  event E {{ {field}: Int }}\n}}\n";
        Validate(src).ShouldContain(d => d.Code == DiagnosticCodes.ReservedRecordMember);
    }

    [Fact]
    public void Duplicate_member_is_reported()
    {
        const string src = "context C {\n  value V {\n    x: Int\n    x: Int\n  }\n}\n";
        var diags = Validate(src);
        diags.ShouldContain(d => d.Code == DiagnosticCodes.DuplicateMember);
    }

    [Fact]
    public void Invariant_referencing_unknown_field_is_reported()
    {
        const string src = "context C {\n  value V {\n    x: Int\n    invariant y >= 0 \"bad\"\n  }\n}\n";
        var diags = Validate(src);
        diags.ShouldContain(d => d.Code == DiagnosticCodes.UnknownField);
    }

    [Fact]
    public void Enum_member_in_invariant_is_accepted()
    {
        const string src =
            "context C {\n" +
            "  enum E { A, B }\n" +
            "  value V {\n" +
            "    state: E\n" +
            "    invariant state == A \"must start at A\"\n" +
            "  }\n" +
            "}\n";
        Validate(src).ShouldBeEmpty();
    }

    [Fact]
    public void Duplicate_enum_member_is_reported()
    {
        var diags = Validate("context C {\n  enum E { A, A, B }\n}\n");
        diags.ShouldContain(d => d.Code == DiagnosticCodes.DuplicateEnumMember && d.Message.Contains("'A'"));
    }

    [Fact]
    public void Unknown_aggregate_root_is_reported()
    {
        const string src =
            "context C {\n  aggregate Ord root Missing {\n    entity Ord identified by OrdId { x: Int }\n  }\n}\n";
        var diags = Validate(src);
        diags.ShouldContain(d => d.Code == DiagnosticCodes.UnknownAggregateRoot);
    }

    [Fact]
    public void Aggregate_sharing_its_name_with_its_root_is_a_warning_not_an_error()
    {
        // `aggregate Order root Order` still compiles (it is NOT a duplicate-type error), but the
        // boundary reading as nothing more than its root is a code smell: it earns a KOI0109 warning.
        const string src =
            "context C {\n  aggregate Order root Order {\n    entity Order identified by OrderId { x: Int }\n  }\n}\n";
        var diags = Validate(src);
        diags.ShouldContain(d => d.Code == DiagnosticCodes.AggregateNameMatchesRoot
            && d.Severity == DiagnosticSeverity.Warning);
        diags.ShouldNotContain(d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void Aggregate_with_a_distinct_boundary_name_has_no_warning()
    {
        // Naming the boundary after the activity it groups (Sales) rather than its root (Order)
        // is the recommended shape and is completely clean.
        const string src =
            "context C {\n  aggregate Sales root Order {\n    entity Order identified by OrderId { x: Int }\n  }\n}\n";
        Validate(src).ShouldBeEmpty();
    }

    [Fact]
    public void Duplicate_type_is_reported()
    {
        const string src = "context C {\n  value Money { a: Int }\n  value Money { b: String }\n}\n";
        var diags = Validate(src);
        diags.ShouldContain(d => d.Code == DiagnosticCodes.DuplicateType && d.Message.Contains("Money"));
    }

    [Fact]
    public void Enum_default_must_belong_to_the_fields_enum()
    {
        // Default `Y` belongs to enum B, but the field's type is A.
        const string src =
            "context C {\n  enum A { X }\n  enum B { Y }\n  value V {\n    f: A = Y\n  }\n}\n";
        var diags = Validate(src);
        diags.ShouldContain(d => d.Code == DiagnosticCodes.UnknownEnumMemberForType && d.Message.Contains("'Y'"));
    }

    /// <summary>
    /// Issue #1498 (Gap A): a bogus member access on an ENUM-typed receiver — as opposed to the
    /// qualified <c>EnumType.Member</c> form, which <c>CheckMember</c> already validates — must be
    /// rejected like any other unknown member. It is the only known way a real <c>.koi</c> model can
    /// carry a member access whose type genuinely does not resolve, which is what lets the Rust
    /// emitter's <c>EffectiveScope</c> shadow-fallthrough (Gap B) manifest.
    /// </summary>
    [Fact]
    public void Unknown_member_on_an_enum_typed_receiver_is_reported()
    {
        const string src =
            """
            context Shop {
              enum Status { Active, Inactive }

              value Widget {
                status: Status
                hasIt: Bool = status.bogusMember == 1
              }
            }
            """;
        Validate(src).ShouldContain(d => d.Code == DiagnosticCodes.UnknownMember && d.Message.Contains("bogusMember"));
    }

    /// <summary>
    /// Issue #1498's companion guard: the new Enum-receiver check must not fire on a LEGITIMATE
    /// smart-enum associated-data access. <c>symbol</c> is a real parameter of <c>Currency</c>'s
    /// signature, so it resolves through <c>ModelIndex.MemberTypeOf</c> and raises nothing.
    /// </summary>
    [Fact]
    public void Smart_enum_associated_data_access_is_not_reported()
    {
        const string src =
            """
            context Shop {
              enum Currency(symbol: String, decimals: Int) {
                EUR("€", 2)
                USD("$", 2)
              }

              value Price {
                currency: Currency
                label: String = currency.symbol
              }
            }
            """;
        Validate(src).ShouldBeEmpty();
    }
}
