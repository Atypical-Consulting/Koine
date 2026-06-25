using Koine.Compiler.Emit.TypeScript;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// R14.3 integration-event snapshot coverage for the TypeScript backend, the TS counterpart of the
/// C# emitter's published-language contract and its <c>IHandle&lt;Event&gt;</c> subscriber seam. The
/// fixture mirrors pizzeria's <c>Ordering -&gt; Kitchen : open-host</c>: a publisher context declares
/// an <c>integration event</c> and <c>publishes</c> it; a subscriber context <c>subscribes</c> to it
/// (authorized by an open-host relation). The reviewed <c>.verified.txt</c> locks in (1) the emitted
/// integration-event class in the publisher's <c>integration-events/</c> folder and (2) the
/// <c>IHandle&lt;Event&gt;</c> handler interface in the subscriber's <c>abstractions/</c> folder, with
/// a single <c>handle(event): Promise&lt;void&gt;</c> method importing the event from the publisher's
/// generated module — exactly as the C# emitter references it by fully-qualified name (no
/// <c>CancellationToken</c>, since TS has no analogue).
/// </summary>
public class TypeScriptIntegrationSnapshotTests
{
    private const string NoToolchainNotice =
        "No TypeScript toolchain (tsc) available locally; type-check not run. " +
        "Install TypeScript (or set KOINE_TSC) — CI runs this for real.";

    /// <summary>
    /// A publisher context declaring + publishing an integration event, and a subscriber context that
    /// subscribes to it, authorized by an open-host context-map relation (mirrors pizzeria).
    /// </summary>
    internal const string Fixture = """
        context Ordering {
          integration event OrderPlaced {
            orderId: String
            total:   Decimal
          }

          publishes OrderPlaced
        }

        context Kitchen {
          subscribes Ordering.OrderPlaced
        }

        contextmap {
          Ordering -> Kitchen : open-host
        }
        """;

    /// <summary>The emitted TypeScript for the integration-event fixture must match its reviewed snapshot.</summary>
    [Fact]
    public Task TypeScript_integration_fixture_emits_expected_typescript()
    {
        var result = new KoineCompiler().Compile(Fixture, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        return Verify(TestSupport.Render(result.Files))
            .UseDirectory("Snapshots");
    }

    /// <summary>
    /// The handler is an interface-only seam (no runtime behavior), so behavioral parity is N/A — the
    /// proof is that the emitted TypeScript (the integration-event contract + the importing handler
    /// interface) type-checks under <c>tsc --strict</c>. Reported <c>Skipped</c> (a hard <c>Failed</c>
    /// under <c>KOINE_REQUIRE_CONFORMANCE</c>) when no toolchain is present; with one it MUST pass with
    /// zero diagnostics.
    /// </summary>
    [Fact]
    public void Emitted_integration_typescript_typechecks_under_strict()
    {
        var result = new KoineCompiler().Compile(Fixture, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue("emitted integration-event TypeScript should type-check under --strict:\n" + string.Join("\n", check.Errors));
    }
}
