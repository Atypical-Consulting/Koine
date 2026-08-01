using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Regression guard for #1777: <see cref="TestSupport.CompileRust"/> invocations sharing one
/// <c>CARGO_TARGET_DIR</c> must never report a false <c>Ok</c> for a genuinely broken crate, no matter
/// how many OTHER, differently-sourced Rust conformance tests are compiling concurrently against the
/// same target dir. Before the fix, Cargo's own build-unit fingerprinting collided across concurrent
/// processes that shared a (package name, version, target dir) triple, even though each had a
/// genuinely distinct source tree — a standalone stress harness outside <c>dotnet test</c> reproduced
/// this deterministically (documented on the issue). This test forces the same condition FROM INSIDE
/// the real harness: many concurrent <see cref="TestSupport.CompileRust"/> calls, half against a model
/// whose emitted Rust is a known, documented compile failure (the capture-guard limitation from
/// #1764/#1768, mirrored from <see cref="RustDerivedMemberInvariantTests"/>), half against its
/// substitutable sibling. Skipped (not failed) when no Rust toolchain is present.
/// </summary>
public class RustCargoTargetDirConcurrencyTests
{
    private const string NoToolchainNotice =
        "No usable Rust toolchain (cargo, networked) available; compile not run. " +
        "Install Rust (or set KOINE_CARGO) — CI runs this for real.";

    // Semantically valid, but the emitter's capture guard leaves a dangling `total` (rustc E0425) —
    // a genuine, known compile failure, not a fixture bug (see RustDerivedMemberInvariantTests).
    private const string KnownBadModel = """
        context Shop {
          value LineItem {
            amount: Decimal
          }
          value Cart {
            rate:  Decimal
            lines: List<LineItem>
            total: Decimal = rate * 2
            invariant lines.all(rate => rate.amount < total) "every line stays below the total"
          }
        }
        """;

    // The same shape with a lambda binding that shadows nothing — this one substitutes and compiles.
    private const string KnownGoodModel = """
        context Shop {
          value LineItem {
            amount: Decimal
          }
          value Basket {
            rate:  Decimal
            lines: List<LineItem>
            total: Decimal = rate * 2
            invariant lines.all(line => line.amount < total) "every line stays below the total"
          }
        }
        """;

    [Fact]
    public void Concurrent_compiles_sharing_one_target_dir_never_report_a_false_ok_for_broken_rust()
    {
        var badFiles = new KoineCompiler().Compile(KnownBadModel, new RustEmitter()).Files;
        var goodFiles = new KoineCompiler().Compile(KnownGoodModel, new RustEmitter()).Files;

        const int concurrency = 20;
        var results = new TestSupport.RustCheck[concurrency];
        Parallel.For(0, concurrency, i =>
        {
            results[i] = TestSupport.CompileRust(i % 2 == 0 ? goodFiles : badFiles);
        });

        // Check every invocation, not just the first: a genuinely absent toolchain skips all of them
        // identically, but a transient per-process launch failure could skip just one, and treating
        // that as a real Ok=false would be a spurious failure unrelated to the concurrency bug this
        // test guards against.
        TestSupport.RequireOrSkip(results.All(r => r.ToolchainAvailable), NoToolchainNotice);

        for (int i = 0; i < concurrency; i++)
        {
            bool expectedOk = i % 2 == 0;
            results[i].Ok.ShouldBe(
                expectedOk,
                $"invocation {i} ({(expectedOk ? "good" : "bad")} model) reported Ok={results[i].Ok} " +
                "under concurrency — exactly the shared-CARGO_TARGET_DIR collision #1777 fixed.");
        }
    }
}
