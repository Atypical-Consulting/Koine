using Koine.Compiler.Ast;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Unit tests for <see cref="ModelIndex.Classify(string?, string)"/> — the context-aware overload of
/// <see cref="ModelIndex.Classify(string)"/> (issue #1560). R13.2 lets two different bounded contexts
/// each legally declare a type with the same simple name (uniqueness is enforced PER CONTEXT, not
/// globally), so a context-blind classification can silently answer for the wrong context's
/// declaration when two contexts both declare, say, a <c>Status</c>. This mirrors the existing
/// <see cref="ModelIndex.TryGetMemberType(string?, string, string, out TypeRef)"/> context-aware
/// overload's contract: try local-to-context (then an unambiguous import) first, and only fall back to
/// the global (last-write-wins) view when that fails.
/// </summary>
public class ModelIndexClassifyTests
{
    private static ModelIndex IndexOf(string source)
    {
        var result = new KoineCompiler().Compile(source, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return new SemanticModel(result.Model!).Index;
    }

    private const string SameNameDifferentKinds = """
        context Billing {
          enum Status { Open Closed }
        }
        context Shipping {
          value Status { code: Int }
        }
        """;

    [Fact]
    public void Same_named_type_in_two_contexts_classifies_to_its_own_context_local_kind()
    {
        var index = IndexOf(SameNameDifferentKinds);

        // Billing's Status is an enum; Shipping's Status is a value object — a context-aware
        // classification must resolve each to ITS OWN declaration, not the global last-write-wins one.
        index.Classify("Billing", "Status").ShouldBe(TypeKind.Enum);
        index.Classify("Shipping", "Status").ShouldBe(TypeKind.Value);
    }

    [Fact]
    public void No_context_call_falls_back_to_the_unchanged_global_behavior()
    {
        var index = IndexOf(SameNameDifferentKinds);

        // A null context (or the plain 1-arg overload) must still answer SOMETHING for a known name,
        // proving the fallback path isn't broken by the refactor — it just can't disambiguate which
        // context's Status it means, so it's whichever declaration won the last-write-wins index.
        index.Classify(null, "Status").ShouldNotBe(TypeKind.Unknown);
        index.Classify("Status").ShouldNotBe(TypeKind.Unknown);
        index.Classify(null, "Status").ShouldBe(index.Classify("Status"));
    }

    private const string ThirdContextNoLocalDeclaration = """
        context Billing {
          enum Status { Open Closed }
        }
        context Shipping {
          value Parcel { weight: Int }
        }
        """;

    [Fact]
    public void Context_aware_call_for_a_type_absent_from_that_context_falls_back_to_the_global_answer()
    {
        var index = IndexOf(ThirdContextNoLocalDeclaration);

        // Shipping neither declares nor imports Status, so TryGetDeclIn fails for ("Shipping", "Status")
        // and Classify must fall back to the global view (Billing's enum) rather than returning Unknown.
        index.Classify("Shipping", "Status").ShouldBe(TypeKind.Enum);
    }

    private const string ImportedType = """
        context Alpha {
          value Money { amount: Int }
        }
        context Gamma {
          import Alpha.{ Money }

          value Wallet { balance: Money }
        }
        """;

    [Fact]
    public void Context_aware_call_resolves_a_type_reached_via_an_unambiguous_import()
    {
        var index = IndexOf(ImportedType);

        // Gamma doesn't declare Money locally — it imports it from Alpha. TryGetDeclIn already resolves
        // this (local, then unambiguous import); Classify(context, typeName) must go through the same path.
        index.Classify("Gamma", "Money").ShouldBe(TypeKind.Value);
    }
}
