using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Unit tests for <see cref="ModelIndex.AllTypes()"/> — the type-registry enumeration every
/// <c>AllTypes()</c>-derived index is built from (issue #1632). R13.2 lets two bounded contexts each
/// legally declare a type with the same simple name (uniqueness is enforced PER CONTEXT, not
/// globally), but <c>AllTypes()</c> used to walk only the flat, last-write-wins <c>_byName</c>
/// dictionary — so a same-named type in the losing context was not merely misclassified (the
/// #1560 family of bugs), it was <b>entirely absent</b> from enumeration. The enum-member index
/// (<see cref="ModelIndex.EnumsDeclaring"/> / <c>_enumMemberToType</c>) is populated by iterating
/// <c>AllTypes()</c>, so the shadowed enum's members were never registered at all and a qualified
/// reference to one failed target-agnostic semantic validation with a false
/// <see cref="DiagnosticCodes.UnknownEnumMemberForType"/> (KOI0106). The declaration order of the two
/// contexts decided which side broke, which is exactly what these tests pin: both orders must
/// validate identically.
/// </summary>
public class ModelIndexAllTypesTests
{
    private static IReadOnlyList<Diagnostic> Diagnose(string source) => new KoineCompiler().Diagnose(source);

    private static ModelIndex IndexOf(string source)
    {
        var result = new KoineCompiler().Compile(source, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return new SemanticModel(result.Model!).Index;
    }

    private const string Shipping = """
        context Shipping {
          enum Status {
            Pending
            Delivered
          }
          value Parcel {
            status: Status
            isDefaultPending: Bool = status == Status.Pending
          }
        }
        """;

    private const string Billing = """
        context Billing {
          enum Status {
            Open
            Closed
          }
          value Invoice {
            status: Status
            isDefaultOpen: Bool = status == Status.Open
          }
        }
        """;

    private const string ShippingFirst = $"{Shipping}\n{Billing}";

    private const string BillingFirst = $"{Billing}\n{Shipping}";

    [Fact]
    public void Qualified_members_of_both_same_name_enums_validate_with_shipping_declared_first()
    {
        Diagnose(ShippingFirst).ShouldNotContain(d => d.Code == DiagnosticCodes.UnknownEnumMemberForType);
    }

    [Fact]
    public void Qualified_members_of_both_same_name_enums_validate_with_billing_declared_first()
    {
        Diagnose(BillingFirst).ShouldNotContain(d => d.Code == DiagnosticCodes.UnknownEnumMemberForType);
    }

    [Fact]
    public void Same_name_enum_in_two_contexts_validates_regardless_of_declaration_order()
    {
        Diagnose(ShippingFirst).ShouldBeEmpty();
        Diagnose(BillingFirst).ShouldBeEmpty();
    }

    [Fact]
    public void AllTypes_yields_every_per_context_declaration_of_a_shared_simple_name()
    {
        ModelIndex index = IndexOf(ShippingFirst);

        List<EnumDecl> statuses = index.AllTypes().OfType<EnumDecl>().Where(e => e.Name == "Status").ToList();
        statuses.Count.ShouldBe(2);
        statuses.SelectMany(e => e.MemberNames).ShouldBe(
            new[] { "Pending", "Delivered", "Open", "Closed" },
            ignoreOrder: true);
    }

    [Fact]
    public void EnumsDeclaring_sees_the_members_of_a_shadowed_same_name_enum()
    {
        ModelIndex index = IndexOf(ShippingFirst);

        // Members of BOTH same-named `Status` enums must be indexed — the shadowed context's own
        // members used to be missing outright (0 owners), not merely ambiguous (≥2 owners).
        index.EnumsDeclaring("Pending").ShouldBe(new[] { "Status" });
        index.EnumsDeclaring("Delivered").ShouldBe(new[] { "Status" });
        index.EnumsDeclaring("Open").ShouldBe(new[] { "Status" });
        index.EnumsDeclaring("Closed").ShouldBe(new[] { "Status" });
    }

    [Fact]
    public void AllTypes_does_not_duplicate_declarations_in_a_single_context_model()
    {
        const string src = """
            context Billing {
              enum Status {
                Open
                Closed
              }
              value Invoice {
                status: Status
              }
            }
            """;

        ModelIndex index = IndexOf(src);

        List<TypeDecl> all = index.AllTypes().ToList();
        all.Select(t => t.Name).ShouldBe(new[] { "Status", "Invoice" });
        all.Distinct().Count().ShouldBe(all.Count);
    }
}
