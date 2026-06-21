using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>Epic R14.1 — Declare a context map with typed relationships.</summary>
public class R14ContextMapsTests
{
    private static IReadOnlyList<Diagnostic> Diagnose(string source) => new KoineCompiler().Diagnose(source);

    private static KoineModel Parse(string source)
    {
        var (model, diags) = new KoineCompiler().Parse(source);
        model.ShouldNotBeNull();
        diags.ShouldNotContain(d => d.Code == DiagnosticCodes.SyntaxError);
        return model;
    }

    // Two declared contexts to relate (so relations don't trip the unknown-context check).
    private const string TwoContexts = """
        context Catalog { value Sku { code: String } }
        context Sales   { value Quote { n: Int } }
        """;

    // ---- parsing -----------------------------------------------------------

    [Fact]
    public void A_directed_relation_parses_with_upstream_left_and_downstream_right()
    {
        var model = Parse(TwoContexts + "contextmap {\n  Catalog -> Sales : conformist\n}\n");
        var r = model.ContextMap!.Relations.ShouldHaveSingleItem();
        r.Upstream.ShouldBe("Catalog");
        r.Downstream.ShouldBe("Sales");
        r.Kind.ShouldBe(ContextRelationKind.Conformist);
        r.IsBidirectional.ShouldBeFalse();
    }

    [Fact]
    public void A_bidirectional_relation_parses()
    {
        var model = Parse(TwoContexts + "contextmap {\n  Catalog <-> Sales : partnership\n}\n");
        var r = model.ContextMap!.Relations.ShouldHaveSingleItem();
        r.IsBidirectional.ShouldBeTrue();
        r.Kind.ShouldBe(ContextRelationKind.Partnership);
    }

    [Fact]
    public void All_seven_roles_lex_as_single_tokens_and_parse()
    {
        const string map = """
            context A { value V { n: Int } }
            context B { value W { n: Int } }
            contextmap {
              A -> B  : partnership
              A -> B  : shared-kernel
              A -> B  : customer-supplier
              A -> B  : conformist
              A -> B  : anti-corruption-layer
              A -> B  : open-host
              A -> B  : published-language
            }
            """;
        var model = Parse(map);
        var kinds = model.ContextMap!.Relations.Select(r => r.Kind).ToHashSet();
        kinds.Count.ShouldBe(7);
    }

    [Fact]
    public void A_program_with_no_map_has_a_null_context_map()
    {
        var model = Parse("context C {\n  value V { n: Int }\n}\n");
        model.ContextMap.ShouldBeNull();
    }

    [Fact]
    public void Map_relations_merge_across_files()
    {
        var (model, _) = new KoineCompiler().Parse(new[]
        {
            new SourceFile("a.koi", "context A { value V { n: Int } }\ncontext B { value W { n: Int } }\n"),
            new SourceFile("m1.koi", "contextmap { A -> B : conformist }\n"),
            new SourceFile("m2.koi", "contextmap { B -> A : open-host }\n"),
        });
        model.ShouldNotBeNull();
        model.ContextMap!.Relations.Count.ShouldBe(2);
    }

    // ---- validation --------------------------------------------------------

    [Fact]
    public void A_relation_to_an_undeclared_context_is_reported()
    {
        Diagnose(TwoContexts + "contextmap {\n  Catalog -> Nope : conformist\n}\n").ShouldContain(d => d.Code == DiagnosticCodes.ContextMapUnknownContext);
    }

    [Fact]
    public void A_self_relation_is_reported()
    {
        Diagnose(TwoContexts + "contextmap {\n  Sales -> Sales : conformist\n}\n").ShouldContain(d => d.Code == DiagnosticCodes.SelfRelation);
    }

    [Fact]
    public void A_duplicate_pair_is_reported_even_when_reversed_and_bidirectional()
    {
        const string src = """
            context A { value V { n: Int } }
            context B { value W { n: Int } }
            contextmap {
              A <-> B : partnership
              B <-> A : shared-kernel
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.DuplicateContextRelation);
    }

    // ---- map-aware references ----------------------------------------------

    [Fact]
    public void A_conformist_downstream_may_reference_an_upstream_type_without_an_import()
    {
        const string src = """
            context Catalog { value Sku { code: String } }
            context Sales   { value Quote { sku: Sku } }
            contextmap { Catalog -> Sales : conformist }
            """;
        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.UnimportedReference);
    }

    [Fact]
    public void A_permit_relation_reference_emits_a_precise_using_and_compiles()
    {
        // A downstream field typed as an un-imported upstream type (permitted by the map) must get
        // the upstream `using` in the emitted C# — not just pass semantic validation.
        var result = new KoineCompiler().Compile(
            "context Catalog { value Sku { code: String } }\n" +
            "context Sales { value Quote { sku: Sku } }\n" +
            "contextmap { Catalog -> Sales : conformist }\n", new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var quote = result.Files.Single(f => f.RelativePath == "Sales/ValueObjects/Quote.cs").Contents;
        quote.ShouldContain("using Catalog;");
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
    }

    [Fact]
    public void Without_a_permitting_relation_a_cross_context_reference_is_still_reported()
    {
        const string src = """
            context Catalog { value Sku { code: String } }
            context Sales   { value Quote { sku: Sku } }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.UnimportedReference);
    }

    [Fact]
    public void A_customer_supplier_relation_does_not_auto_permit_a_direct_reference()
    {
        const string src = """
            context Catalog { value Sku { code: String } }
            context Sales   { value Quote { sku: Sku } }
            contextmap { Catalog -> Sales : customer-supplier }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.UnimportedReference);
    }

    [Fact]
    public void An_acl_downstream_referencing_an_upstream_type_directly_is_warned()
    {
        const string src = """
            context Legacy  { value Account { id: String } }
            context Billing { value Customer { acct: Account } }
            contextmap { Legacy -> Billing : anti-corruption-layer }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.AclDirectUpstreamReference && d.Severity == DiagnosticSeverity.Warning);
    }
}
