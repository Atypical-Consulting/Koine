using System.Reflection;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>Epic R13 — Multi-File Compilation, Imports &amp; Modules.</summary>
public class R13ModulesImportsTests
{
    private static IReadOnlyList<Diagnostic> Diagnose(string source) => new KoineCompiler().Diagnose(source);

    private static (Assembly Asm, IReadOnlyList<Emit.EmittedFile> Files) Build(params SourceFile[] files)
    {
        var result = new KoineCompiler().Compile(files, new CSharpEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var (asm, errors) = TestSupport.Compile(result.Files);
        Assert.True(asm is not null, "generated C# failed to compile:\n" + string.Join("\n", errors));
        return (asm!, result.Files);
    }

    private static (Assembly Asm, IReadOnlyList<Emit.EmittedFile> Files) Build(string source) =>
        Build(new SourceFile("<test>.koi", source));

    private static string FileContents(IEnumerable<Emit.EmittedFile> files, string path) =>
        files.Single(f => f.RelativePath == path).Contents;

    // ---- R13.1 — multi-file compilation -----------------------------------

    [Fact]
    public void Two_files_declaring_the_same_context_merge()
    {
        var (asm, _) = Build(
            new SourceFile("billing/money.koi", "context Billing {\n  value Money { amount: Decimal }\n}\n"),
            new SourceFile("billing/order.koi", "context Billing {\n  entity Order identified by OrderId { total: Money }\n}\n"));

        // Both types live in one merged Billing namespace, cross-referencing freely.
        Assert.NotNull(asm.GetType("Billing.Money"));
        Assert.NotNull(asm.GetType("Billing.Order"));
    }

    [Fact]
    public void A_single_file_still_compiles_backward_compatible()
    {
        var (asm, _) = Build("context C {\n  value V { n: Int }\n}\n");
        Assert.NotNull(asm.GetType("C.V"));
    }

    [Fact]
    public void A_syntax_error_names_its_originating_file()
    {
        var compiler = new KoineCompiler();
        var (model, diags) = compiler.Parse(new[]
        {
            new SourceFile("good.koi", "context A {\n  value V { n: Int }\n}\n"),
            new SourceFile("bad.koi", "context B {\n  value W { n: !!! }\n}\n"),
        });
        Assert.Null(model);
        Assert.Contains(diags, d => d.Code == DiagnosticCodes.SyntaxError && d.File == "bad.koi");
        Assert.DoesNotContain(diags, d => d.File == "good.koi");
    }

    [Fact]
    public void A_semantic_error_carries_its_source_file()
    {
        var compiler = new KoineCompiler();
        var (model, _) = compiler.Parse(new[]
        {
            new SourceFile("a.koi", "context A {\n  value V { x: Nope }\n}\n"),
        });
        var diags = new Koine.Compiler.Semantics.SemanticValidator().Validate(model!);
        Assert.Contains(diags, d => d.Code == DiagnosticCodes.UnknownType && d.File == "a.koi");
    }

    // ---- R13.2 — imports & qualified references ---------------------------

    private const string Shared = "context Billing {\n  value Money { amount: Decimal }\n}\n";

    [Fact]
    public void Named_import_resolves_and_emits_a_precise_using()
    {
        var (_, files) = Build(Shared + "context Sales {\n  import Billing.{ Money }\n  value Quote { price: Money }\n}\n");
        Assert.Contains("using Billing;", FileContents(files, "Sales/ValueObjects/Quote.cs"));
    }

    [Fact]
    public void Wildcard_import_resolves()
    {
        Assert.Empty(Diagnose(Shared + "context Sales {\n  import Billing.*\n  value Quote { price: Money }\n}\n"));
    }

    [Fact]
    public void Qualified_reference_resolves_without_an_import_and_emits_fully_qualified()
    {
        var (_, files) = Build(Shared + "context Sales {\n  value Quote { price: Billing.Money }\n}\n");
        var quote = FileContents(files, "Sales/ValueObjects/Quote.cs");
        Assert.Contains("Billing.Money Price", quote);
        Assert.DoesNotContain("using Billing;", quote); // fully-qualified needs no using
    }

    [Fact]
    public void Un_imported_cross_context_reference_is_reported()
    {
        Assert.Contains(Diagnose(Shared + "context Sales {\n  value Quote { price: Money }\n}\n"),
            d => d.Code == DiagnosticCodes.UnimportedReference);
    }

    [Fact]
    public void Ambiguous_unqualified_reference_lists_candidates()
    {
        const string src =
            "context A {\n  value Money { a: Decimal }\n}\n" +
            "context B {\n  value Money { a: Decimal }\n}\n" +
            "context C {\n  import A.*\n  import B.*\n  value Q { m: Money }\n}\n";
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.AmbiguousReference);
    }

    [Fact]
    public void Same_type_name_in_two_contexts_is_allowed()
    {
        // Per-context uniqueness (R13.2): each context may declare its own Money.
        var (asm, _) = Build(
            "context A {\n  value Money { a: Decimal }\n}\n" +
            "context B {\n  value Money { a: Decimal }\n}\n");
        Assert.NotNull(asm.GetType("A.Money"));
        Assert.NotNull(asm.GetType("B.Money"));
    }

    [Fact]
    public void Member_access_resolves_to_the_local_type_when_a_name_is_shared_across_contexts()
    {
        // A.Wallet projects A.Money.amount; B.Money (different members) must NOT shadow it.
        const string src = """
            context A {
              value Money { amount: Decimal }
              value Wallet { m: Money  total: Decimal = m.amount }
            }
            context B {
              value Money { cents: Int }
            }
            """;
        Assert.Empty(Diagnose(src));
        var (_, files) = Build(src);
        Assert.Contains("M.Amount", FileContents(files, "A/ValueObjects/Wallet.cs"));
    }

    [Fact]
    public void Importing_an_unknown_context_is_reported()
    {
        Assert.Contains(Diagnose("context C {\n  import Nope.{ X }\n  value V { n: Int }\n}\n"),
            d => d.Code == DiagnosticCodes.UnknownContext);
    }

    [Fact]
    public void Importing_a_non_exported_name_is_reported()
    {
        Assert.Contains(Diagnose(Shared + "context Sales {\n  import Billing.{ Nope }\n  value V { n: Int }\n}\n"),
            d => d.Code == DiagnosticCodes.NotExported);
    }

    [Fact]
    public void A_qualified_reference_to_an_unknown_context_is_reported()
    {
        Assert.Contains(Diagnose("context C {\n  value V { x: Nope.Money }\n}\n"),
            d => d.Code == DiagnosticCodes.UnknownContext);
    }

    // ---- R13.3 — modules --------------------------------------------------

    [Fact]
    public void Module_types_emit_into_a_sub_namespace_and_folder()
    {
        var (asm, files) = Build("""
            context Billing {
              enum Currency { EUR, USD }
              module Pricing { value Money { amount: Decimal  currency: Currency } }
            }
            """);
        Assert.Contains(files, f => f.RelativePath == "Billing/Pricing/ValueObjects/Money.cs");
        Assert.Contains("namespace Billing.Pricing;", FileContents(files, "Billing/Pricing/ValueObjects/Money.cs"));
        Assert.NotNull(asm.GetType("Billing.Pricing.Money"));
        // Currency is in the base namespace; the module file imports it precisely.
        Assert.Contains("using Billing;", FileContents(files, "Billing/Pricing/ValueObjects/Money.cs"));
    }

    [Fact]
    public void Cross_module_reference_in_the_same_context_resolves_and_imports()
    {
        var (asm, files) = Build("""
            context Billing {
              module Pricing  { value Money { amount: Decimal } }
              module Invoicing { entity Invoice identified by InvoiceId { total: Money } }
            }
            """);
        var invoice = FileContents(files, "Billing/Invoicing/Entities/Invoice.cs");
        Assert.Contains("namespace Billing.Invoicing;", invoice);
        Assert.Contains("using Billing.Pricing;", invoice);
        Assert.NotNull(asm.GetType("Billing.Invoicing.Invoice"));
    }

    [Fact]
    public void Modules_may_nest()
    {
        var (asm, files) = Build("""
            context C {
              module Outer { module Inner { value V { n: Int } } }
            }
            """);
        Assert.Contains(files, f => f.RelativePath == "C/Outer/Inner/ValueObjects/V.cs");
        Assert.NotNull(asm.GetType("C.Outer.Inner.V"));
    }

    [Fact]
    public void A_module_sharing_a_name_with_a_type_is_reported()
    {
        const string src = "context C {\n  value Pricing { n: Int }\n  module Pricing { value M { a: Decimal } }\n}\n";
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.ModuleNameCollision);
    }

    [Fact]
    public void A_module_type_collision_split_across_files_is_still_reported()
    {
        // The module lives in a SECOND file; merge must preserve ModuleNames for the check.
        var result = new KoineCompiler().Compile(new[]
        {
            new SourceFile("a.koi", "context C {\n  value Pricing { n: Int }\n}\n"),
            new SourceFile("b.koi", "context C {\n  module Pricing { value M { a: Decimal } }\n}\n"),
        }, new CSharpEmitter());
        Assert.Contains(result.Diagnostics, d => d.Code == DiagnosticCodes.ModuleNameCollision);
    }

    [Fact]
    public void An_aggregate_inside_a_module_compiles_with_its_repository_and_unit_of_work()
    {
        // Exercises the module-namespace boundary: I<Root>Repository lives in the module
        // sub-namespace, the UoW in the base namespace, and the ID in the base namespace.
        var (asm, files) = Build("""
            context Billing {
              module Invoicing {
                aggregate Order root Order {
                  entity Order identified by OrderId { customer: CustomerId }
                }
              }
            }
            """);
        Assert.Contains(files, f => f.RelativePath == "Billing/Invoicing/Repositories/IOrderRepository.cs");
        Assert.Contains("Billing.Invoicing.IOrderRepository Orders { get; }", FileContents(files, "Billing/Abstractions/IUnitOfWork.cs"));
        Assert.Contains(files, f => f.RelativePath == "Billing/ValueObjects/OrderId.cs"); // ID in BASE namespace
        Assert.NotNull(asm.GetType("Billing.Invoicing.Order"));
        Assert.NotNull(asm.GetType("Billing.IUnitOfWork"));
    }

    [Fact]
    public void Read_model_resolves_its_source_to_the_local_context_when_a_name_is_shared()
    {
        // A.MoneyView projects A.Money.amount (Decimal); B.Money.amount (Int) must not win.
        var (_, files) = Build("""
            context A {
              value Money { amount: Decimal }
              readmodel MoneyView from Money { amount }
            }
            context B {
              value Money { amount: Int }
            }
            """);
        Assert.Contains("public sealed record MoneyView(decimal Amount);", FileContents(files, "A/ReadModels/MoneyView.cs"));
    }

    [Fact]
    public void Spec_resolves_its_target_to_the_local_context_when_a_name_is_shared()
    {
        const string src = """
            context A {
              value Money { amount: Decimal }
              spec Positive on Money = amount > 0
            }
            context B {
              value Money { cents: Int }
            }
            """;
        Assert.Empty(Diagnose(src)); // A.Money has `amount`; the global B.Money must not shadow it
    }

    // ---- soft keywords -----------------------------------------------------

    [Fact]
    public void New_keywords_remain_usable_as_field_names()
    {
        Assert.Empty(Diagnose("context C {\n  value V { import: Int  module: Int }\n}\n"));
    }
}
