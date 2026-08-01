using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// The anti-corruption-layer slice of the Java backend (issue #1090, Phase 2 Task 4) — the Java analogue
/// of <c>PythonEmitter.Acl.cs</c> / <c>TypeScriptEmitter.Acl.cs</c> and the C# emitter's
/// <c>I&lt;Up&gt;To&lt;Down&gt;Translator</c>. Each context-map relation of kind
/// <c>anti-corruption-layer</c> that carries an <c>acl { … }</c> block emits one translator
/// <b>interface</b> into the DOWNSTREAM context, with one
/// <c>translate&lt;Upstream&gt;To&lt;Local&gt;(&lt;Upstream&gt; source)</c> method per mapping. It is a
/// pure structural seam — no behavior, exactly like the C#/TS interfaces and the Python Protocol.
/// The fixture mirrors <see cref="Conformance.TypeScriptAclSnapshotTests"/>'s.
/// </summary>
public class JavaAclTests
{
    /// <summary>
    /// Two contexts and an ACL relation mapping the upstream context's types onto local ones, mirroring
    /// pizzeria's <c>Gateway -&gt; Payment : anti-corruption-layer acl { … }</c>.
    /// </summary>
    internal const string Fixture = """
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

    /// <summary>
    /// The translator lands in the DOWNSTREAM context's package (that is the side that must defend
    /// itself) and carries one method per mapping, with the upstream type package-qualified — the
    /// downstream package cannot see an upstream type by simple name.
    /// </summary>
    [Fact]
    public void Acl_relation_emits_a_translator_interface_in_the_downstream_package()
    {
        var result = new KoineCompiler().Compile(Fixture, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var translator = result.Files.Single(f =>
            f.RelativePath == "koine/generated/billing/LegacyToBillingTranslator.java").Contents;

        translator.ShouldContain("public interface LegacyToBillingTranslator {");
        translator.ShouldContain("Customer translateAccountToCustomer(koine.generated.legacy.Account source);");
        translator.ShouldContain("Invoice translateChargeToInvoice(koine.generated.legacy.Charge source);");
    }

    /// <summary>
    /// The method name carries BOTH the upstream and the local type. The validator already rejects two
    /// mappings with the same UPSTREAM type (KOI1408), but two mappings may legally funnel different
    /// upstream types into the SAME downstream type — a local-only method name would then collide,
    /// surviving only as a parameter-type overload. Naming both ends keeps each method distinct by
    /// construction, matching the Python emitter's scheme.
    /// </summary>
    [Fact]
    public void Acl_method_names_carry_both_ends_so_a_shared_target_type_does_not_collide()
    {
        const string src = """
            context Legacy {
              value Account { reference: String }
              value Charge  { amount: Decimal }
            }
            context Billing {
              value Customer { name: String }
            }
            contextmap {
              Legacy -> Billing : anti-corruption-layer
                acl { Legacy.Account -> Billing.Customer
                      Legacy.Charge  -> Billing.Customer }
            }
            """;
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var translator = result.Files.Single(f =>
            f.RelativePath == "koine/generated/billing/LegacyToBillingTranslator.java").Contents;

        translator.ShouldContain("Customer translateAccountToCustomer(koine.generated.legacy.Account source);");
        translator.ShouldContain("Customer translateChargeToCustomer(koine.generated.legacy.Charge source);");
    }

    /// <summary>
    /// A relation of another kind — or an ACL relation with no <c>acl { … }</c> block — emits no
    /// translator, so an ordinary context map does not gain a stray empty interface.
    /// </summary>
    [Fact]
    public void Non_acl_relations_emit_no_translator()
    {
        const string src = """
            context Legacy {
              value Account { reference: String }
            }
            context Billing {
              value Customer { name: String }
            }
            contextmap {
              Legacy -> Billing : conformist
            }
            """;
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        result.Files.ShouldNotContain(f => f.RelativePath.EndsWith("Translator.java", StringComparison.Ordinal));
    }
}
