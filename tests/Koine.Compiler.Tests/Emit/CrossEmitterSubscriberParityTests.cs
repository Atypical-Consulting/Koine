using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// #420 — a subscriber that consumes the same integration-event short name from two different
/// publishers must get two distinct, non-clobbering handler seams in EVERY emitter that emits a
/// subscriber seam (C#, TypeScript, PHP), each qualified by its publisher; AsyncAPI must likewise emit
/// two distinct receive operations. The Python emitter ships no per-subscription seam (integration
/// events emit only as per-context DTOs), so the model is collision-safe there by construction —
/// asserted too, so a future Python subscriber seam can't silently reintroduce the collision. One
/// model, every subscriber-consuming emitter: the cross-emitter parity guard.
/// </summary>
public class CrossEmitterSubscriberParityTests
{
    // Sales.Shipped + Returns.Shipped, both subscribed by Fulfillment.
    private const string Source = R14IntegrationEventsTests.SameNameCrossPublisher;

    private static IReadOnlyList<EmittedFile> Emit(IEmitter emitter)
    {
        var result = new KoineCompiler().Compile(Source, emitter);
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files;
    }

    private static void AssertTwoDistinctQualifiedSeams(
        IReadOnlyList<EmittedFile> files, string salesSuffix, string returnsSuffix, string bareSuffix)
    {
        files.Count(f => f.RelativePath.EndsWith(salesSuffix, StringComparison.Ordinal)).ShouldBe(1);
        files.Count(f => f.RelativePath.EndsWith(returnsSuffix, StringComparison.Ordinal)).ShouldBe(1);
        // The bare seam would clobber across publishers — it must not be emitted.
        files.ShouldNotContain(f => f.RelativePath.EndsWith(bareSuffix, StringComparison.Ordinal));
        // No two emitted files share a path: the model is collision-safe end to end.
        files.Select(f => f.RelativePath).ShouldBeUnique();
    }

    [Fact]
    public void CSharp_emits_two_publisher_qualified_seams()
        => AssertTwoDistinctQualifiedSeams(
            Emit(new CSharpEmitter()),
            "Fulfillment/Abstractions/IHandleSalesShipped.cs",
            "Fulfillment/Abstractions/IHandleReturnsShipped.cs",
            "Fulfillment/Abstractions/IHandleShipped.cs");

    [Fact]
    public void TypeScript_emits_two_publisher_qualified_seams()
        => AssertTwoDistinctQualifiedSeams(
            Emit(new TypeScriptEmitter()),
            "Fulfillment/abstractions/IHandleSalesShipped.ts",
            "Fulfillment/abstractions/IHandleReturnsShipped.ts",
            "Fulfillment/abstractions/IHandleShipped.ts");

    [Fact]
    public void Php_emits_two_publisher_qualified_seams()
        => AssertTwoDistinctQualifiedSeams(
            Emit(new PhpEmitter()),
            "Fulfillment/Abstractions/HandleSalesShipped.php",
            "Fulfillment/Abstractions/HandleReturnsShipped.php",
            "Fulfillment/Abstractions/HandleShipped.php");

    [Fact]
    public void AsyncApi_emits_two_distinct_publisher_qualified_receive_operations()
    {
        var yaml = Emit(new AsyncApiEmitter()).ShouldHaveSingleItem().Contents;

        // Two distinct receive operations — one per publisher; the bare key would drop a subscription.
        yaml.ShouldContain("  Fulfillment_receive_Sales_Shipped:");
        yaml.ShouldContain("  Fulfillment_receive_Returns_Shipped:");
        yaml.ShouldNotContain("  Fulfillment_receive_Shipped:");
    }

    [Fact]
    public void Python_is_collision_safe_with_no_subscriber_seam()
    {
        var files = Emit(new PythonEmitter());

        // Python emits no per-subscription handler seam; the two same-named events live in distinct
        // context packages, so the model is collision-safe by construction.
        files.Count(f => f.RelativePath.EndsWith("sales/events/shipped.py", StringComparison.Ordinal)).ShouldBe(1);
        files.Count(f => f.RelativePath.EndsWith("returns/events/shipped.py", StringComparison.Ordinal)).ShouldBe(1);
        files.Select(f => f.RelativePath).ShouldBeUnique();
    }
}
