using Koine.Compiler.Emit;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Emit.Php;
using Koine.Compiler.Emit.Python;
using Koine.Compiler.Emit.TypeScript;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Regressions caught by the production-grade-emit code review:
/// <list type="bullet">
/// <item>reference-only emit must not leak a policy's reaction expressions (doc sketch or the
/// <c>reactionArgs</c> body) — only the parameter-name contract survives;</item>
/// <item>the Python/PHP emitters must override <see cref="IEmitter.CacheDiscriminator"/> so their
/// package/namespace maps participate in <see cref="KoineCompiler"/>'s content-addressed emit cache
/// (otherwise differently-mapped emits of the same source collide and return stale bytes).</item>
/// </list>
/// </summary>
public class ReviewFixesTests
{
    /// <summary>An event whose field feeds a policy reaction argument (the would-be leak).</summary>
    private const string PolicyFixture = """
        context Sales {
          event ChargeCaptured {
            charge:         Int
            capturedAmount: Decimal
          }

          aggregate Books root LedgerEntry {
            entity LedgerEntry identified by LedgerEntryId {
              charge:  Int
              balance: Decimal

              command record(amount: Decimal) {
                balance -> amount
              }
            }
          }

          policy PostToLedger when ChargeCaptured then Books.record(amount: capturedAmount)
        }
        """;

    [Fact]
    public void Csharp_reference_only_policy_does_not_leak_the_reaction_expression()
    {
        var result = new KoineCompiler().Compile(
            PolicyFixture, new CSharpEmitter(CSharpEmitterOptions.Empty with { ReferenceOnly = true }));
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var policy = result.Files.Single(f => f.Contents.Contains("class PostToLedgerPolicy", StringComparison.Ordinal));
        // The interface contract survives, and the command's parameter name is still documented…
        policy.Contents.ShouldContain("interface IPostToLedgerPolicy");
        policy.Contents.ShouldContain("amount: …");          // "amount: …" (value elided)
        // …but the translated business expression (the event field) must not appear.
        policy.Contents.ShouldNotContain("capturedAmount");
    }

    [Fact]
    public void Typescript_reference_only_policy_stubs_reactionArgs_and_hides_the_expression()
    {
        var result = new KoineCompiler().Compile(
            PolicyFixture, new TypeScriptEmitter(new TsEmitterOptions { ReferenceOnly = true }));
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var policy = result.Files.Single(f => f.Contents.Contains("class PostToLedgerPolicy", StringComparison.Ordinal));
        policy.Contents.ShouldContain("export interface IPostToLedgerPolicy");
        policy.Contents.ShouldContain("throw new Error('reference-only');"); // reactionArgs body stubbed
        policy.Contents.ShouldNotContain("capturedAmount");                  // expression not leaked

        // The stubbed reference-only TypeScript still type-checks (when the toolchain is present).
        var check = TestSupport.TypeCheckTypeScript(result.Files);
        if (check.ToolchainAvailable)
        {
            check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
        }
    }

    [Fact]
    public void Python_cache_discriminator_reflects_the_package_map()
    {
        IEmitter a = new PythonEmitter(new PythonEmitterOptions(
            new Dictionary<string, string>(StringComparer.Ordinal) { ["catalog"] = "acme.catalog" }));
        IEmitter b = new PythonEmitter(new PythonEmitterOptions(
            new Dictionary<string, string>(StringComparer.Ordinal) { ["catalog"] = "other.catalog" }));
        IEmitter c = new PythonEmitter(PythonEmitterOptions.Empty);
        IEmitter d = new PythonEmitter(PythonEmitterOptions.Empty);

        a.CacheDiscriminator.ShouldNotBe(b.CacheDiscriminator); // different maps → different key
        c.CacheDiscriminator.ShouldBe(d.CacheDiscriminator);    // equal options → equal key
        a.CacheDiscriminator.ShouldNotBe(c.CacheDiscriminator);
    }

    [Fact]
    public void Php_cache_discriminator_reflects_the_namespace_map()
    {
        IEmitter a = new PhpEmitter(new PhpEmitterOptions(
            new Dictionary<string, string>(StringComparer.Ordinal) { ["Catalog"] = "Acme\\Catalog" }));
        IEmitter b = new PhpEmitter(new PhpEmitterOptions(
            new Dictionary<string, string>(StringComparer.Ordinal) { ["Catalog"] = "Other\\Catalog" }));
        IEmitter c = new PhpEmitter(PhpEmitterOptions.Empty);

        a.CacheDiscriminator.ShouldNotBe(b.CacheDiscriminator);
        a.CacheDiscriminator.ShouldNotBe(c.CacheDiscriminator);
    }
}
