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
public class ModelIndexClassifyTests(ITestOutputHelper output)
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

    [Fact]
    public void Context_aware_is_known_type_tracks_the_context_aware_classification()
    {
        var index = IndexOf(SameNameDifferentKinds);

        // IsKnownType(context, name) is defined as "Classify(context, name) is not Unknown", so it must
        // answer for the same declarations the context-aware Classify resolves — including a name only
        // reachable through the global fallback — and stay false for a name no context declares.
        index.IsKnownType("Billing", "Status").ShouldBeTrue();
        index.IsKnownType("Shipping", "Status").ShouldBeTrue();
        index.IsKnownType(null, "Status").ShouldBeTrue();
        index.IsKnownType("Billing", "Nope").ShouldBeFalse();
        index.IsKnownType(null, "Nope").ShouldBeFalse();
    }

    private const string SharedMemberNameAcrossThreeContexts = """
        context A {
          enum Status { Red }
        }
        context B {
          enum Status { Green }
        }
        context C {
          enum Flag { Red, Blue }
          value V {
            ok: Bool = Red == Blue
          }
        }
        """;

    [Fact]
    public void Context_aware_EnumsDeclaring_scopes_owners_to_what_is_visible_from_that_context()
    {
        var index = IndexOf(SharedMemberNameAcrossThreeContexts);

        // Issue #1739: A's Status also declares Red, but A is neither declared-in nor imported-into C —
        // so from C's own perspective only its own Flag owns Red. The context-blind overload still
        // reports both (B's Status doesn't declare Red at all, so it's absent from either list).
        index.EnumsDeclaring("C", "Red").ShouldBe(new[] { "Flag" });
        index.EnumsDeclaring("Red").ShouldBe(new[] { "Status", "Flag" });
    }

    [Fact]
    public void Context_aware_EnumsDeclaring_with_a_null_context_matches_the_flat_overload()
    {
        var index = IndexOf(SharedMemberNameAcrossThreeContexts);

        index.EnumsDeclaring(null, "Red").ShouldBe(index.EnumsDeclaring("Red"));
    }

    [Fact]
    public void Context_aware_EnumsDeclaring_agrees_with_the_flat_overload_when_there_is_no_collision()
    {
        var index = IndexOf(SharedMemberNameAcrossThreeContexts);

        // Backward compatibility (issue #1739 spec): for a member with no cross-context collision, the
        // two overloads must agree exactly — "Blue" is declared only by Flag, model-wide.
        index.EnumsDeclaring("C", "Blue").ShouldBe(index.EnumsDeclaring("Blue"));
    }

    /// <summary>
    /// The load-bearing premise of <c>SemanticValidator.ValidateTypeRef</c>'s context threading
    /// (#1715): the two overloads can disagree about WHICH declaration a name means, but never about
    /// whether the name is known at all. That holds because <c>_byName</c> and <c>_declsByContext</c>
    /// are filled by two INDEPENDENT traversals (<c>ModelIndex.IndexType</c> over <c>ctx.Types</c>
    /// with its own aggregate recursion, and <c>ContextNode.AllTypeDecls()</c>) that happen to
    /// enumerate the same declaration set — so a name resolvable in a context is always a key in the
    /// flat table too. Nothing in the type system enforces that; this test does, over every type
    /// reference in every shipped template, so the day the two traversals drift apart it fails here
    /// rather than silently changing which diagnostics <c>ValidateTypeRef</c> reports.
    /// </summary>
    [Fact]
    public void Context_aware_and_flat_Classify_never_disagree_on_unknown_ness_across_all_templates()
    {
        var folders = TemplatesValidationTests.TemplateFolders()
            .Select(data => (string)data[0])
            .ToList();
        folders.ShouldNotBeEmpty("templates/ must contain at least one folder with a template.json");

        int total = 0;
        foreach (string folder in folders)
        {
            string name = Path.GetFileName(folder);
            KoineModel model = CompileTemplateModel(folder);
            ModelIndex index = new SemanticModel(model).Index;

            int perTemplate = 0;
            foreach (ContextNode ctx in model.Contexts)
            {
                foreach (TypeRef type in NodeWalker.Descendants(ctx).OfType<TypeRef>())
                {
                    bool contextAwareUnknown = index.Classify(ctx.Name, type.Name) == TypeKind.Unknown;
                    bool flatUnknown = index.Classify(type.Name) == TypeKind.Unknown;

                    contextAwareUnknown.ShouldBe(
                        flatUnknown,
                        $"template '{name}', context '{ctx.Name}', type reference '{type.Name}' at " +
                        $"{type.Span.Line}:{type.Span.Column}: Classify(context, name) says " +
                        $"{(contextAwareUnknown ? "Unknown" : "known")} but Classify(name) says " +
                        $"{(flatUnknown ? "Unknown" : "known")} — the flat and per-context type tables " +
                        "have drifted apart, so ValidateTypeRef's built-in-first classification is no " +
                        "longer a no-op for the KOI0101 unknown-type report");
                    perTemplate++;
                }
            }

            // A template that contributes nothing would make this test vacuously green.
            perTemplate.ShouldBeGreaterThan(0, $"template '{name}' yielded no type references to check");
            total += perTemplate;
        }

        output.WriteLine($"checked {total} type references across {folders.Count} templates");
    }

    /// <summary>
    /// Compiles a template folder in directory mode — every <c>.koi</c> under it as one model, so
    /// cross-file imports and context maps resolve — exactly as <see cref="TemplatesValidationTests"/>
    /// does, and returns the bound model.
    /// </summary>
    private static KoineModel CompileTemplateModel(string folder)
    {
        var sources = Directory
            .EnumerateFiles(folder, "*.koi", SearchOption.AllDirectories)
            .OrderBy(p => p, StringComparer.Ordinal)
            .Select(p => new SourceFile(p, File.ReadAllText(p)))
            .ToList();

        sources.ShouldNotBeEmpty($"template '{Path.GetFileName(folder)}' has no .koi files to compile");
        var result = new KoineCompiler().Compile(sources, new CSharpEmitter());
        result.Model.ShouldNotBeNull($"template '{Path.GetFileName(folder)}' produced no model");
        return result.Model!;
    }
}
