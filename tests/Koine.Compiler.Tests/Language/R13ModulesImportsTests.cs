using System.Reflection;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>Epic R13 — Multi-File Compilation, Imports &amp; Modules.</summary>
public class R13ModulesImportsTests
{
    private static IReadOnlyList<Diagnostic> Diagnose(string source) => new KoineCompiler().Diagnose(source);

    private static (Assembly Asm, IReadOnlyList<Emit.EmittedFile> Files) Build(params SourceFile[] files)
    {
        var result = new KoineCompiler().Compile(files, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        return (asm, result.Files);
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
        asm.GetType("Billing.Money").ShouldNotBeNull();
        asm.GetType("Billing.Order").ShouldNotBeNull();
    }

    [Fact]
    public void A_single_file_still_compiles_backward_compatible()
    {
        var (asm, _) = Build("context C {\n  value V { n: Int }\n}\n");
        asm.GetType("C.V").ShouldNotBeNull();
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
        // Error-tolerant parsing no longer blanks the workspace: the good file's context still
        // surfaces in the partial model, while the syntax error is stamped with its own file.
        model.ShouldNotBeNull();
        model.Contexts.ShouldContain(c => c.Name == "A");
        diags.ShouldContain(d => d.Code == DiagnosticCodes.SyntaxError && d.File == "bad.koi");
        diags.ShouldNotContain(d => d.File == "good.koi");
    }

    [Fact]
    public void A_semantic_error_carries_its_source_file()
    {
        var compiler = new KoineCompiler();
        var (model, _) = compiler.Parse(new[]
        {
            new SourceFile("a.koi", "context A {\n  value V { x: Nope }\n}\n"),
        });
        var diags = new Semantics.SemanticValidator().Validate(model!);
        diags.ShouldContain(d => d.Code == DiagnosticCodes.UnknownType && d.File == "a.koi");
    }

    // ---- R13.2 — imports & qualified references ---------------------------

    private const string Shared = "context Billing {\n  value Money { amount: Decimal }\n}\n";

    [Fact]
    public void Named_import_resolves_and_emits_a_precise_using()
    {
        var (_, files) = Build(Shared + "context Sales {\n  import Billing.{ Money }\n  value Quote { price: Money }\n}\n");
        FileContents(files, "Sales/ValueObjects/Quote.cs").ShouldContain("using Billing;");
    }

    [Fact]
    public void Wildcard_import_resolves()
    {
        Diagnose(Shared + "context Sales {\n  import Billing.*\n  value Quote { price: Money }\n}\n").ShouldBeEmpty();
    }

    [Fact]
    public void Qualified_reference_resolves_without_an_import_and_emits_fully_qualified()
    {
        var (_, files) = Build(Shared + "context Sales {\n  value Quote { price: Billing.Money }\n}\n");
        var quote = FileContents(files, "Sales/ValueObjects/Quote.cs");
        quote.ShouldContain("Billing.Money Price");
        quote.ShouldNotContain("using Billing;"); // fully-qualified needs no using
    }

    [Fact]
    public void Un_imported_cross_context_reference_is_reported()
    {
        Diagnose(Shared + "context Sales {\n  value Quote { price: Money }\n}\n").ShouldContain(d => d.Code == DiagnosticCodes.UnimportedReference);
    }

    [Fact]
    public void Ambiguous_unqualified_reference_lists_candidates()
    {
        const string src =
            "context A {\n  value Money { a: Decimal }\n}\n" +
            "context B {\n  value Money { a: Decimal }\n}\n" +
            "context C {\n  import A.*\n  import B.*\n  value Q { m: Money }\n}\n";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.AmbiguousReference);
    }

    [Fact]
    public void Same_type_name_in_two_contexts_is_allowed()
    {
        // Per-context uniqueness (R13.2): each context may declare its own Money.
        var (asm, _) = Build(
            "context A {\n  value Money { a: Decimal }\n}\n" +
            "context B {\n  value Money { a: Decimal }\n}\n");
        asm.GetType("A.Money").ShouldNotBeNull();
        asm.GetType("B.Money").ShouldNotBeNull();
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
        Diagnose(src).ShouldBeEmpty();
        var (_, files) = Build(src);
        FileContents(files, "A/ValueObjects/Wallet.cs").ShouldContain("M.Amount");
    }

    [Fact]
    public void Importing_an_unknown_context_is_reported()
    {
        Diagnose("context C {\n  import Nope.{ X }\n  value V { n: Int }\n}\n").ShouldContain(d => d.Code == DiagnosticCodes.UnknownContext);
    }

    [Fact]
    public void Importing_a_non_exported_name_is_reported()
    {
        Diagnose(Shared + "context Sales {\n  import Billing.{ Nope }\n  value V { n: Int }\n}\n").ShouldContain(d => d.Code == DiagnosticCodes.NotExported);
    }

    [Fact]
    public void A_qualified_reference_to_an_unknown_context_is_reported()
    {
        Diagnose("context C {\n  value V { x: Nope.Money }\n}\n").ShouldContain(d => d.Code == DiagnosticCodes.UnknownContext);
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
        files.ShouldContain(f => f.RelativePath == "Billing/Pricing/ValueObjects/Money.cs");
        FileContents(files, "Billing/Pricing/ValueObjects/Money.cs").ShouldContain("namespace Billing.Pricing;");
        asm.GetType("Billing.Pricing.Money").ShouldNotBeNull();
        // Currency is in the base namespace; the module file imports it precisely.
        FileContents(files, "Billing/Pricing/ValueObjects/Money.cs").ShouldContain("using Billing;");
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
        invoice.ShouldContain("namespace Billing.Invoicing;");
        invoice.ShouldContain("using Billing.Pricing;");
        asm.GetType("Billing.Invoicing.Invoice").ShouldNotBeNull();
    }

    [Fact]
    public void Modules_may_nest()
    {
        var (asm, files) = Build("""
            context C {
              module Outer { module Inner { value V { n: Int } } }
            }
            """);
        files.ShouldContain(f => f.RelativePath == "C/Outer/Inner/ValueObjects/V.cs");
        asm.GetType("C.Outer.Inner.V").ShouldNotBeNull();
    }

    [Fact]
    public void A_module_sharing_a_name_with_a_type_is_reported()
    {
        const string src = "context C {\n  value Pricing { n: Int }\n  module Pricing { value M { a: Decimal } }\n}\n";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.ModuleNameCollision);
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
        result.Diagnostics.ShouldContain(d => d.Code == DiagnosticCodes.ModuleNameCollision);
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
        files.ShouldContain(f => f.RelativePath == "Billing/Invoicing/Repositories/IOrderRepository.cs");
        FileContents(files, "Billing/Abstractions/IUnitOfWork.cs").ShouldContain("Billing.Invoicing.IOrderRepository Orders { get; }");
        files.ShouldContain(f => f.RelativePath == "Billing/ValueObjects/OrderId.cs"); // ID in BASE namespace
        asm.GetType("Billing.Invoicing.Order").ShouldNotBeNull();
        asm.GetType("Billing.IUnitOfWork").ShouldNotBeNull();
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
        FileContents(files, "A/ReadModels/MoneyView.cs").ShouldContain("public sealed record MoneyView(decimal Amount);");
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
        Diagnose(src).ShouldBeEmpty(); // A.Money has `amount`; the global B.Money must not shadow it
    }

    // ---- soft keywords -----------------------------------------------------

    [Fact]
    public void New_keywords_remain_usable_as_field_names()
    {
        Diagnose("context C {\n  value V { import: Int  module: Int }\n}\n").ShouldBeEmpty();
    }
}
