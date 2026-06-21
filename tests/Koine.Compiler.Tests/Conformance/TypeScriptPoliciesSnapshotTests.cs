using Koine.Compiler.Emit;
using Koine.Compiler.Emit.TypeScript;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// R10.3 (cross-aggregate policy) snapshot coverage for the TypeScript backend, the TS counterpart of
/// the C# emitter's policy slice. The fixture carries a domain <c>event</c>, an aggregate with a
/// <c>command</c>, and a <c>policy … when &lt;Event&gt; then &lt;Aggregate&gt;.&lt;command&gt;(arg: &lt;eventField&gt;)</c>
/// — so the reviewed <c>.verified.txt</c> locks in the emitted handler seam (the
/// <c>I&lt;Name&gt;Policy</c> interface + the <c>abstract</c> policy class) and, crucially, the pure
/// <c>reactionArgs</c> mapping that translates the event's fields into the target command's named
/// arguments exactly.
/// </summary>
public class TypeScriptPoliciesSnapshotTests
{
    private readonly ITestOutputHelper _output;

    public TypeScriptPoliciesSnapshotTests(ITestOutputHelper output) => _output = output;

    private const string NoToolchainNotice =
        "INCONCLUSIVE: no TypeScript toolchain (tsc) available locally; type-check not run. " +
        "Install TypeScript (or set KOINE_TSC) — CI runs this for real.";

    /// <summary>A focused policy cross-section (event + aggregate command + policy), emitted to TypeScript.</summary>
    internal const string Fixture = """
        context Sales {
          /// Recorded when a charge is captured. Triggers the ledger-posting policy.
          event ChargeCaptured {
            charge:         Int
            capturedAmount: Decimal
          }

          aggregate Books root LedgerEntry {
            entity LedgerEntry identified by LedgerEntryId {
              charge:  Int
              balance: Decimal

              /// Post an amount to the ledger entry.
              command record(amount: Decimal) {
                balance -> amount
              }
            }
          }

          /// R10.3 — react to a captured charge by posting it to the ledger.
          policy PostToLedger when ChargeCaptured then Books.record(amount: capturedAmount)
        }
        """;

    /// <summary>The emitted TypeScript for the policy fixture must match its reviewed snapshot.</summary>
    [Fact]
    public Task TypeScript_policy_fixture_emits_expected_typescript()
    {
        var result = new KoineCompiler().Compile(Fixture, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        return Verify(TestSupport.Render(result.Files))
            .UseDirectory("Snapshots");
    }

    /// <summary>
    /// The acceptance check: the policy handler seam (the <c>I&lt;Name&gt;Policy</c> interface, the
    /// abstract policy class, and the pure <c>reactionArgs</c> mapping) must type-check cleanly under
    /// <c>tsc --noEmit --strict</c>. Inconclusive (logged, not failed) only when no toolchain is
    /// present; with one it MUST pass with zero diagnostics.
    /// </summary>
    [Fact]
    public void Emitted_policy_typescript_typechecks_under_strict()
    {
        var result = new KoineCompiler().Compile(Fixture, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        if (!check.ToolchainAvailable)
        {
            _output.WriteLine(NoToolchainNotice);
            return;
        }

        check.Ok.ShouldBeTrue("emitted policy TypeScript should type-check under --strict:\n" + string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Behavioral arg-mapping proof: the policy's <c>reactionArgs</c> helper maps the triggering
    /// event's fields to the target command's named arguments. The emitted module must contain the
    /// <c>amount: event.capturedAmount</c> mapping — the deterministic, testable artifact that proves
    /// the <see cref="Ast.PolicyArg.Value"/> expressions are translated rooted at the event.
    /// </summary>
    [Fact]
    public void Policy_maps_event_fields_to_command_arguments()
    {
        var result = new KoineCompiler().Compile(Fixture, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        EmittedFile policy = result.Files.Single(f => f.RelativePath.EndsWith("PostToLedgerPolicy.ts", StringComparison.Ordinal));

        policy.Contents.ShouldContain("export interface IPostToLedgerPolicy");
        policy.Contents.ShouldContain("handle(event: ChargeCaptured): Promise<void>;");
        policy.Contents.ShouldContain("export abstract class PostToLedgerPolicy implements IPostToLedgerPolicy");
        policy.Contents.ShouldContain("protected reactionArgs(event: ChargeCaptured)");
        policy.Contents.ShouldContain("amount: event.capturedAmount,");
    }
}
