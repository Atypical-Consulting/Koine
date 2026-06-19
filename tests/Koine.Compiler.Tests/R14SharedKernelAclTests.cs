using System.Reflection;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>Epic R14.2 — Shared-kernel ownership &amp; anti-corruption-layer translator stubs.</summary>
public class R14SharedKernelAclTests
{
    private static IReadOnlyList<Diagnostic> Diagnose(string source) => new KoineCompiler().Diagnose(source);

    private static (Assembly Asm, IReadOnlyList<Emit.EmittedFile> Files) Build(params SourceFile[] files)
    {
        var result = new KoineCompiler().Compile(files, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        return (asm!, result.Files);
    }

    private static (Assembly Asm, IReadOnlyList<Emit.EmittedFile> Files) Build(string source) =>
        Build(new SourceFile("<test>.koi", source));

    private static string FileContents(IEnumerable<Emit.EmittedFile> files, string path) =>
        files.Single(f => f.RelativePath == path).Contents;

    // Money declared in Sales, shared with Shipping (Sales is the order-normalized owner).
    private const string SharedKernel = """
        context Sales {
          value Money { amount: Decimal }
          value Quote { price: Money }
        }
        context Shipping {
          value Label { cost: Money }
        }
        contextmap {
          Sales <-> Shipping : shared-kernel { Money }
        }
        """;

    // ---- shared kernel emission --------------------------------------------

    [Fact]
    public void A_shared_type_is_emitted_once_into_a_dedicated_kernel_namespace()
    {
        var (asm, files) = Build(SharedKernel);
        FileContents(files, "Sales__Shipping/Kernel/ValueObjects/Money.cs").ShouldContain("namespace Sales__Shipping.Kernel;");
        asm.GetType("Sales__Shipping.Kernel.Money").ShouldNotBeNull();
        // Not duplicated into either partner's own namespace.
        files.ShouldNotContain(f => f.RelativePath == "Sales/ValueObjects/Money.cs");
        files.ShouldNotContain(f => f.RelativePath == "Shipping/ValueObjects/Money.cs");
        files.Where(f => f.RelativePath.EndsWith("/Money.cs")).ShouldHaveSingleItem();
    }

    [Fact]
    public void Both_partners_reference_the_shared_type_without_an_import()
    {
        Diagnose(SharedKernel).ShouldNotContain(d => d.Code == DiagnosticCodes.UnimportedReference || d.Code == DiagnosticCodes.UnknownType);
    }

    [Fact]
    public void A_partner_file_gets_a_precise_kernel_using()
    {
        var (_, files) = Build(SharedKernel);
        FileContents(files, "Shipping/ValueObjects/Label.cs").ShouldContain("using Sales__Shipping.Kernel;");
        FileContents(files, "Sales/ValueObjects/Quote.cs").ShouldContain("using Sales__Shipping.Kernel;");
    }

    [Fact]
    public void A_non_partner_referencing_a_shared_type_is_still_reported()
    {
        const string src = """
            context Sales    { value Money { amount: Decimal } }
            context Shipping { value Label { cost: Money } }
            context Audit    { value Entry { amount: Money } }
            contextmap { Sales <-> Shipping : shared-kernel { Money } }
            """;
        // Audit is not a kernel partner, so it may not reference Money for free.
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.UnimportedReference);
    }

    [Fact]
    public void The_kernel_namespace_is_order_normalized()
    {
        // Declaring the relation in the reverse direction emits into the same kernel namespace.
        var (_, files) = Build("""
            context Sales { value Money { amount: Decimal } }
            context Shipping { value Label { cost: Money } }
            contextmap { Shipping <-> Sales : shared-kernel { Money } }
            """);
        files.ShouldContain(f => f.RelativePath == "Sales__Shipping/Kernel/ValueObjects/Money.cs");
    }

    [Fact]
    public void An_unknown_shared_kernel_type_is_reported()
    {
        const string src = """
            context Sales { value Money { amount: Decimal } }
            context Shipping { value Label { cost: Decimal } }
            contextmap { Sales <-> Shipping : shared-kernel { Ghost } }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.UnknownSharedKernelType);
    }

    [Fact]
    public void A_shared_kernel_block_on_a_non_kernel_relation_is_reported()
    {
        const string src = """
            context Sales { value Money { amount: Decimal } }
            context Shipping { value Label { cost: Decimal } }
            contextmap { Sales -> Shipping : open-host { Money } }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.SharedTypesOnNonKernel);
    }

    // ---- ACL translator interface ------------------------------------------

    private const string Acl = """
        context Legacy {
          value Account { reference: String }
          value Charge  { amount: Decimal }
        }
        context Billing {
          value Customer { name: String }
          value Invoice  { total: Decimal }
        }
        contextmap {
          Legacy -> Billing : anti-corruption-layer
            acl { Legacy.Account -> Billing.Customer
                  Legacy.Charge  -> Billing.Invoice }
        }
        """;

    [Fact]
    public void An_acl_relation_emits_a_translator_interface_in_the_downstream_context()
    {
        var (asm, files) = Build(Acl);
        var translator = FileContents(files, "Billing/Abstractions/ILegacyToBillingTranslator.cs");
        translator.ShouldContain("namespace Billing;");
        translator.ShouldContain("public interface ILegacyToBillingTranslator");
        translator.ShouldContain("Billing.Customer Translate(Legacy.Account source);");
        translator.ShouldContain("Billing.Invoice Translate(Legacy.Charge source);");
        asm.GetType("Billing.ILegacyToBillingTranslator").ShouldNotBeNull();
    }

    [Fact]
    public void An_acl_relation_without_a_mapping_block_emits_no_translator()
    {
        var (_, files) = Build("""
            context Legacy { value Account { reference: String } }
            context Billing { value Customer { name: String } }
            contextmap { Legacy -> Billing : anti-corruption-layer }
            """);
        files.ShouldNotContain(f => f.RelativePath.Contains("Translator"));
    }

    [Fact]
    public void A_non_acl_relation_emits_no_translator()
    {
        var (_, files) = Build("""
            context Legacy { value Account { reference: String } }
            context Billing { value Customer { name: String } }
            contextmap { Legacy -> Billing : customer-supplier }
            """);
        files.ShouldNotContain(f => f.RelativePath.Contains("Translator"));
    }

    [Fact]
    public void An_acl_block_on_a_non_acl_relation_is_reported()
    {
        const string src = """
            context Legacy { value Account { reference: String } }
            context Billing { value Customer { name: String } }
            contextmap {
              Legacy -> Billing : open-host
                acl { Legacy.Account -> Billing.Customer }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.AclOnNonAclRole);
    }

    [Fact]
    public void An_acl_mapping_with_a_partner_mismatch_is_reported()
    {
        const string src = """
            context Legacy { value Account { reference: String } }
            context Billing { value Customer { name: String } }
            context Other  { value Thing { n: Int } }
            contextmap {
              Legacy -> Billing : anti-corruption-layer
                acl { Other.Thing -> Billing.Customer }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.AclMappingType);
    }

    [Fact]
    public void An_acl_mapping_with_an_unknown_type_is_reported()
    {
        const string src = """
            context Legacy { value Account { reference: String } }
            context Billing { value Customer { name: String } }
            contextmap {
              Legacy -> Billing : anti-corruption-layer
                acl { Legacy.Ghost -> Billing.Customer }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.AclMappingType);
    }

    // ---- review regressions ------------------------------------------------

    [Fact]
    public void A_shared_type_that_references_an_owner_local_type_compiles()
    {
        // Money (shared) references Currency (owned by Sales, NOT shared); the kernel file must
        // get a precise `using Sales;` so it resolves.
        var (asm, files) = Build("""
            context Sales {
              value Currency { code: String }
              value Money { amount: Decimal  unit: Currency }
            }
            context Shipping { value Label { cost: Money } }
            contextmap { Sales <-> Shipping : shared-kernel { Money } }
            """);
        FileContents(files, "Sales__Shipping/Kernel/ValueObjects/Money.cs").ShouldContain("using Sales;");
        asm.GetType("Sales__Shipping.Kernel.Money").ShouldNotBeNull();
    }

    [Fact]
    public void A_shared_id_value_object_is_not_duplicated_and_compiles()
    {
        // Sharing an *Id is redundant (the *Id convention makes it universally available); it must
        // NOT be redirected to a kernel namespace or referenced via a non-existent kernel type.
        var (asm, files) = Build("""
            context Sales { entity Order identified by OrderId { n: Int } }
            context Shipping { value Box { order: OrderId } }
            contextmap { Sales <-> Shipping : shared-kernel { OrderId } }
            """);
        files.ShouldNotContain(f => f.RelativePath.Contains("__") && f.RelativePath.EndsWith("OrderId.cs"));
        asm.GetType("Sales.OrderId").ShouldNotBeNull();
    }

    [Fact]
    public void Sharing_the_same_type_across_two_kernels_is_reported()
    {
        const string src = """
            context A { value Money { amount: Decimal } }
            context B { value Label { cost: Money } }
            context C { value Tag { cost: Money } }
            contextmap {
              A <-> B : shared-kernel { Money }
              A <-> C : shared-kernel { Money }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.SharedKernelTypeConflict);
    }

    [Fact]
    public void An_acl_mapping_to_a_module_namespaced_type_emits_the_correct_namespace()
    {
        var (asm, files) = Build("""
            context Legacy { value Account { reference: String } }
            context Billing { module Crm { value Customer { name: String } } }
            contextmap {
              Legacy -> Billing : anti-corruption-layer
                acl { Legacy.Account -> Billing.Customer }
            }
            """);
        FileContents(files, "Billing/Abstractions/ILegacyToBillingTranslator.cs").ShouldContain("Billing.Crm.Customer Translate(Legacy.Account source);");
        asm.GetType("Billing.ILegacyToBillingTranslator").ShouldNotBeNull();
    }

    [Fact]
    public void KOI1404_does_not_fire_when_a_same_named_type_is_imported_from_a_non_acl_context()
    {
        const string src = """
            context Legacy  { value Money { id: String } }
            context Other   { value Money { id: String } }
            context Billing {
              import Other.{ Money }
              value Customer { m: Money }
            }
            contextmap { Legacy -> Billing : anti-corruption-layer }
            """;
        // Money resolves via the import from Other; the Legacy ACL is irrelevant — no false warning.
        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.AclDirectUpstreamReference);
    }

    [Fact]
    public void Sharing_an_entity_in_a_kernel_is_reported()
    {
        const string src = """
            context Sales { entity LineItem identified by LineItemId { sku: String } }
            context Shipping { value Pack { item: LineItem } }
            contextmap { Sales <-> Shipping : shared-kernel { LineItem } }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.SharedKernelNotShareable);
    }

    [Fact]
    public void Sharing_an_aggregate_in_a_kernel_is_reported()
    {
        const string src = """
            context Sales {
              aggregate Order root Order { entity Order identified by OrderId { total: Decimal } }
            }
            context Shipping { value Ref { o: Order } }
            contextmap { Sales <-> Shipping : shared-kernel { Order } }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.SharedKernelNotShareable);
    }

    [Fact]
    public void A_shared_enum_emits_into_the_kernel_namespace_and_compiles()
    {
        var (asm, files) = Build("""
            context Sales { enum Currency { EUR, USD }  value Price { c: Currency } }
            context Shipping { value Tariff { c: Currency } }
            contextmap { Sales <-> Shipping : shared-kernel { Currency } }
            """);
        files.ShouldContain(f => f.RelativePath == "Sales__Shipping/Kernel/Enums/Currency.cs");
        asm.GetType("Sales__Shipping.Kernel.Currency").ShouldNotBeNull();
    }

    [Fact]
    public void Reemitting_a_kernel_and_acl_model_is_byte_identical()
    {
        var compiler = new KoineCompiler();
        var first = compiler.Compile(SharedKernel, new CSharpEmitter()).Files;
        var second = compiler.Compile(SharedKernel, new CSharpEmitter()).Files;
        TestSupport.Render(second).ShouldBe(TestSupport.Render(first));

        var firstAcl = compiler.Compile(Acl, new CSharpEmitter()).Files;
        var secondAcl = compiler.Compile(Acl, new CSharpEmitter()).Files;
        TestSupport.Render(secondAcl).ShouldBe(TestSupport.Render(firstAcl));
    }

    [Fact]
    public void Relations_and_shared_kernel_merge_across_files_deterministically()
    {
        var first = new KoineCompiler().Compile(new[]
        {
            new SourceFile("sales.koi", "context Sales { value Money { amount: Decimal } }\n"),
            new SourceFile("ship.koi", "context Shipping { value Label { cost: Money } }\n"),
            new SourceFile("map.koi", "contextmap { Sales <-> Shipping : shared-kernel { Money } }\n"),
        }, new CSharpEmitter());
        first.Success.ShouldBeTrue(string.Join("\n", first.Diagnostics.Select(d => d.ToString())));
        first.Files.ShouldContain(f => f.RelativePath == "Sales__Shipping/Kernel/ValueObjects/Money.cs");
    }
}
