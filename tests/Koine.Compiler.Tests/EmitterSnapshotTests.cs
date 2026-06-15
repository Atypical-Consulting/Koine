using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Services;
using VerifyXunit;

namespace Koine.Compiler.Tests;

/// <summary>
/// Snapshot test over the emitted C#. Changes to generated output must be
/// reviewed deliberately by updating the .verified.txt snapshot.
/// </summary>
public class EmitterSnapshotTests
{
    [Fact]
    public Task Billing_fixture_emits_expected_csharp()
    {
        var result = new KoineCompiler().Compile(TestSupport.BillingFixture, new CSharpEmitter());
        Assert.True(result.Success);

        return Verifier.Verify(TestSupport.Render(result.Files))
            .UseDirectory("Snapshots");
    }
}
