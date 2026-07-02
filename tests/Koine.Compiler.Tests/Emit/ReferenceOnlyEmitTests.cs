using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Production-grade emit, Task 8: a <c>ReferenceOnly</c> mode that emits a compilable contract
/// surface — every type/member signature, interface and command/event/repository contract — with
/// implementation bodies stripped to reference-assembly stubs (no invariant checks, no field
/// mutation, no business expressions). The feature is gated on
/// <see cref="CSharpEmitterOptions.ReferenceOnly"/> / <see cref="TsEmitterOptions.ReferenceOnly"/>
/// (default <c>false</c>); with the flag off the emitted text MUST be byte-identical to the default
/// emitter.
/// </summary>
public class ReferenceOnlyEmitTests
{
    private readonly ITestOutputHelper _output;

    public ReferenceOnlyEmitTests(ITestOutputHelper output) => _output = output;

    /// <summary>
    /// A fixture exercising the whole construct surface: a value object with an invariant, an
    /// aggregate whose root entity carries a command (with a precondition + transition + emit), a
    /// factory, a configured repository, and a domain event.
    /// </summary>
    private const string Fixture = """
        context Ordering {

          value Money {
            amount:   Decimal
            currency: String
            invariant amount >= 0   "amount cannot be negative"
          }

          enum OrderStatus { Draft, Placed, Cancelled }

          aggregate Order root Order {

            repository {
              operations: getById, add, update
            }

            event OrderPlaced {
              orderId: OrderId
              total:   Money
            }

            entity Order identified by OrderId {
              total:  Money
              status: OrderStatus = Draft

              invariant total.amount >= 0   "order total cannot be negative"

              states status {
                Draft  -> Placed, Cancelled
                Placed
                Cancelled
              }

              command place {
                requires status == Draft   "order must be a draft to place"
                status -> Placed
                emit OrderPlaced(orderId: id, total: total)
              }

              create open(total: Money) {
                requires total.amount >= 0   "an order total cannot be negative"
                emit OrderPlaced(orderId: id, total: total)
              }
            }
          }
        }
        """;

    private static IReadOnlyList<EmittedFile> EmitCSharp(CSharpEmitterOptions options)
    {
        var result = new KoineCompiler().Compile(
            new[] { new SourceFile("ordering.koi", Fixture) },
            new CSharpEmitter(options));
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files;
    }

    private static IReadOnlyList<EmittedFile> EmitTs(TsEmitterOptions options)
    {
        var result = new KoineCompiler().Compile(
            new[] { new SourceFile("ordering.koi", Fixture) },
            new TypeScriptEmitter(options));
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files;
    }

    private static EmittedFile File(IReadOnlyList<EmittedFile> files, string suffix) =>
        files.Single(f => f.RelativePath.EndsWith(suffix, StringComparison.Ordinal));

    // ------------------------------------------------------------------
    // C# — bodies stripped, signatures/contracts kept, Roslyn-compiles.
    // ------------------------------------------------------------------

    [Fact]
    public void CSharp_referenceOnly_strips_implementation_logic_and_keeps_stubs()
    {
        var files = EmitCSharp(CSharpEmitterOptions.Empty with { ReferenceOnly = true });

        var money = File(files, "Money.cs");
        // (a) The real invariant guard / message is GONE; only the reference stub remains.
        money.Contents.ShouldNotContain("amount cannot be negative");
        money.Contents.ShouldNotContain("DomainInvariantViolationException");
        money.Contents.ShouldContain("throw null!;");

        var order = File(files, "Order.cs");
        // The command's precondition message and the field mutation must be ABSENT.
        order.Contents.ShouldNotContain("order must be a draft to place");
        order.Contents.ShouldNotContain("Status = OrderStatus.Placed");
        order.Contents.ShouldNotContain("_domainEvents.Add(");
        // The command/factory SIGNATURES survive as the contract surface.
        order.Contents.ShouldContain("public void Place()");
        order.Contents.ShouldContain("public static Order Open(");
        order.Contents.ShouldContain("throw null!;");
    }

    [Fact]
    public void CSharp_referenceOnly_keeps_interfaces_and_type_signatures()
    {
        var files = EmitCSharp(CSharpEmitterOptions.Empty with { ReferenceOnly = true });

        // (b) Repository interface + its contract methods.
        var repo = File(files, "IOrderRepository.cs");
        repo.Contents.ShouldContain("public interface IOrderRepository");
        repo.Contents.ShouldContain("Task<Order?> GetByIdAsync(OrderId id, CancellationToken ct = default);");
        repo.Contents.ShouldContain("Task AddAsync(Order aggregate, CancellationToken ct = default);");

        // Command/event/value-object type declarations + their member signatures survive.
        File(files, "OrderPlaced.cs").Contents.ShouldContain("public sealed record OrderPlaced : IDomainEvent");
        File(files, "Money.cs").Contents.ShouldContain("public decimal Amount { get; }");
        File(files, "Order.cs").Contents.ShouldContain("public sealed class Order : IAggregateRoot");
    }

    [Fact]
    public void CSharp_referenceOnly_output_roslyn_compiles()
    {
        // (c) The whole contract surface must compile as a reference assembly.
        var files = EmitCSharp(CSharpEmitterOptions.Empty with { ReferenceOnly = true });

        var (assembly, errors) = TestSupport.Compile(files);
        assembly.ShouldNotBeNull(string.Join("\n", errors));
    }

    [Fact]
    public void CSharp_referenceOnly_false_is_byte_identical_to_the_default_emitter()
    {
        // (d) The flag-off path is exactly the unconfigured emitter's output.
        var off = EmitCSharp(CSharpEmitterOptions.Empty);
        var unconfigured = new KoineCompiler().Compile(
            new[] { new SourceFile("ordering.koi", Fixture) },
            new CSharpEmitter()).Files;

        TestSupport.Render(off).ShouldBe(TestSupport.Render(unconfigured));

        foreach (var f in off)
        {
            f.Contents.ShouldNotContain("throw null!;");
        }
    }

    // ------------------------------------------------------------------
    // TypeScript — bodies stripped, declarations kept, tsc --strict accepts.
    // ------------------------------------------------------------------

    [Fact]
    public void Ts_referenceOnly_strips_bodies_and_keeps_declarations()
    {
        var files = EmitTs(new TsEmitterOptions { ReferenceOnly = true });

        var money = File(files, "Money.ts");
        money.Contents.ShouldNotContain("amount cannot be negative");
        money.Contents.ShouldContain("throw new Error('reference-only');");
        // The class + field declarations survive (with definite-assignment assertions).
        money.Contents.ShouldContain("export class Money extends ValueObject");
        money.Contents.ShouldContain("readonly amount!:");

        var order = File(files, "Order.ts");
        order.Contents.ShouldNotContain("order must be a draft to place");
        order.Contents.ShouldContain("place(): void {");
        order.Contents.ShouldContain("static open(");
        order.Contents.ShouldContain("throw new Error('reference-only');");
    }

    [Fact]
    public void Ts_referenceOnly_output_typechecks_with_tsc_strict()
    {
        var files = EmitTs(new TsEmitterOptions { ReferenceOnly = true });

        var check = TestSupport.TypeCheckTypeScript(files);
        if (!check.ToolchainAvailable)
        {
            _output.WriteLine("No tsc toolchain found; skipping the TypeScript type-check half.");
            return;
        }

        check.Ok.ShouldBeTrue("expected reference-only TS to type-check:\n" + string.Join("\n", check.Errors));
    }

    [Fact]
    public void Ts_referenceOnly_false_is_byte_identical_to_the_default_emitter()
    {
        var off = EmitTs(new TsEmitterOptions());
        var unconfigured = new KoineCompiler().Compile(
            new[] { new SourceFile("ordering.koi", Fixture) },
            new TypeScriptEmitter()).Files;

        TestSupport.Render(off).ShouldBe(TestSupport.Render(unconfigured));

        foreach (var f in off)
        {
            f.Contents.ShouldNotContain("throw new Error('reference-only');");
        }
    }
}
