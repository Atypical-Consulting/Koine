using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// R14.2 anti-corruption-layer snapshot coverage for the TypeScript backend, the TS counterpart of
/// the C# emitter's <c>I&lt;Up&gt;To&lt;Down&gt;Translator</c>. The fixture defines two contexts and a
/// context-map <c>anti-corruption-layer</c> relation carrying an <c>acl { … }</c> mapping block with
/// two mappings, so the reviewed <c>.verified.txt</c> locks in the emitted translator interface: one
/// <c>translate&lt;LocalType&gt;(source: &lt;UpstreamType&gt;): &lt;LocalType&gt;</c> method per mapping
/// (upstream type → local type), each type imported from its generated module. The upstream context's
/// types are themselves emitted (mirroring pizzeria's <c>Gateway</c>), so the upstream parameter is a
/// real imported type, exactly as the C# emitter references it by fully-qualified name.
/// </summary>
public class TypeScriptAclSnapshotTests
{
    private const string NoToolchainNotice =
        "No TypeScript toolchain (tsc) available locally; type-check not run. " +
        "Install TypeScript (or set KOINE_TSC) — CI runs this for real.";

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

    /// <summary>The emitted TypeScript for the ACL fixture must match its reviewed snapshot.</summary>
    [Fact]
    public Task TypeScript_acl_fixture_emits_expected_typescript()
    {
        var result = new KoineCompiler().Compile(Fixture, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        return Verify(TestSupport.Render(result.Files))
            .UseDirectory("Snapshots");
    }

    /// <summary>
    /// The ACL translator is an interface-only seam (no runtime behavior), so behavioral parity is
    /// N/A — the proof is that the emitted TypeScript type-checks under <c>tsc --strict</c>. Reported
    /// <c>Skipped</c> (a hard <c>Failed</c> under <c>KOINE_REQUIRE_CONFORMANCE</c>) when no toolchain is
    /// present; with one it MUST pass with zero diagnostics.
    /// </summary>
    [Fact]
    public void Emitted_acl_typescript_typechecks_under_strict()
    {
        var result = new KoineCompiler().Compile(Fixture, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue("emitted ACL TypeScript should type-check under --strict:\n" + string.Join("\n", check.Errors));
    }
}
