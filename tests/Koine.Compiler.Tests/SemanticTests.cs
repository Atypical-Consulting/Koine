using Koine.Compiler.Diagnostics;
using Koine.Compiler.Semantics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

public class SemanticTests
{
    private static IReadOnlyList<Diagnostic> Validate(string source)
    {
        var (model, syntax) = new KoineCompiler().Parse(source);
        Assert.Empty(syntax);
        Assert.NotNull(model);
        return new SemanticValidator().Validate(model);
    }

    [Fact]
    public void Valid_fixture_has_no_diagnostics()
    {
        Assert.Empty(Validate(TestSupport.BillingFixture));
    }

    [Fact]
    public void Unknown_type_reference_is_reported()
    {
        const string src = "context C {\n  value V {\n    x: Nope\n  }\n}\n";
        var diags = Validate(src);
        Assert.Contains(diags, d => d.Code == DiagnosticCodes.UnknownType);
    }

    [Theory]
    [InlineData("id")]   // collides with the generated identity property
    [InlineData("Id")]
    [InlineData("equals")]
    [InlineData("getHashCode")]
    public void Entity_member_colliding_with_a_generated_member_is_reported(string member)
    {
        var src = $"context C {{\n  entity E identified by EId {{ {member}: Int }}\n}}\n";
        Assert.Contains(Validate(src), d => d.Code == DiagnosticCodes.ReservedEntityMember);
    }

    [Fact]
    public void Entity_member_named_like_a_generated_member_but_distinct_after_casing_is_allowed()
    {
        // `gethashcode` PascalCases to `Gethashcode`, which does NOT collide with GetHashCode.
        const string src = "context C {\n  entity E identified by EId { gethashcode: Int }\n}\n";
        Assert.DoesNotContain(Validate(src), d => d.Code == DiagnosticCodes.ReservedEntityMember);
    }

    [Fact]
    public void Duplicate_member_is_reported()
    {
        const string src = "context C {\n  value V {\n    x: Int\n    x: Int\n  }\n}\n";
        var diags = Validate(src);
        Assert.Contains(diags, d => d.Code == DiagnosticCodes.DuplicateMember);
    }

    [Fact]
    public void Invariant_referencing_unknown_field_is_reported()
    {
        const string src = "context C {\n  value V {\n    x: Int\n    invariant y >= 0 \"bad\"\n  }\n}\n";
        var diags = Validate(src);
        Assert.Contains(diags, d => d.Code == DiagnosticCodes.UnknownField);
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
        Assert.Empty(Validate(src));
    }

    [Fact]
    public void Duplicate_enum_member_is_reported()
    {
        var diags = Validate("context C {\n  enum E { A, A, B }\n}\n");
        Assert.Contains(diags, d => d.Code == DiagnosticCodes.DuplicateEnumMember && d.Message.Contains("'A'"));
    }

    [Fact]
    public void Unknown_aggregate_root_is_reported()
    {
        const string src =
            "context C {\n  aggregate Ord root Missing {\n    entity Ord identified by OrdId { x: Int }\n  }\n}\n";
        var diags = Validate(src);
        Assert.Contains(diags, d => d.Code == DiagnosticCodes.UnknownAggregateRoot);
    }

    [Fact]
    public void Aggregate_named_after_its_root_is_allowed()
    {
        // `aggregate Order root Order` is idiomatic and must NOT be a duplicate-type error.
        const string src =
            "context C {\n  aggregate Order root Order {\n    entity Order identified by OrderId { x: Int }\n  }\n}\n";
        Assert.Empty(Validate(src));
    }

    [Fact]
    public void Duplicate_type_is_reported()
    {
        const string src = "context C {\n  value Money { a: Int }\n  value Money { b: String }\n}\n";
        var diags = Validate(src);
        Assert.Contains(diags, d => d.Code == DiagnosticCodes.DuplicateType && d.Message.Contains("Money"));
    }

    [Fact]
    public void Enum_default_must_belong_to_the_fields_enum()
    {
        // Default `Y` belongs to enum B, but the field's type is A.
        const string src =
            "context C {\n  enum A { X }\n  enum B { Y }\n  value V {\n    f: A = Y\n  }\n}\n";
        var diags = Validate(src);
        Assert.Contains(diags, d => d.Code == DiagnosticCodes.UnknownEnumMemberForType && d.Message.Contains("'Y'"));
    }
}
