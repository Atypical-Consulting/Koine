using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Issue #1276: the TypeScript emitter's <c>RefOnly</c> mode (gated by
/// <see cref="TsEmitterOptions.ReferenceOnly"/>) switches quantities, plain value objects, entities,
/// and CQRS read-model projections from full method/getter bodies to declaration-only stubs. A prior
/// baseline (<see cref="Koine.Compiler.Tests.ReferenceOnlyEmitTests"/>, since the feature's original PR
/// #137) already covers a VO invariant + an entity command/factory, but nothing exercised the quantity
/// add/subtract/multiply/divide branch pair added in #1269, an entity's <c>checkInvariants</c>/
/// <c>domainEvents</c>/<c>equals</c> stubs, or the read-model projection stub — so a signature drift
/// between a real method and its <c>RefOnly</c> stub (the exact mistake #1269's fix had to avoid by
/// hand) had no test that would catch it. This file closes that gap.
/// </summary>
public class TypeScriptRefOnlyTests
{
    /// <summary>The literal stub body <c>WriteRefStubMethod</c>/the inline branches emit.</summary>
    private const string RefStubStatement = "throw new Error('reference-only');";

    /// <summary>
    /// A representative cross-section: a <c>quantity</c> (unit-checked add/subtract, scalar
    /// multiply/divide), a plain value object with demand-generated add/subtract/multiply/divide, an
    /// aggregate entity with an invariant and an event-emitting factory (so both <c>checkInvariants</c>
    /// and <c>domainEvents</c>/<c>clearDomainEvents</c> are emitted), and a CQRS read model with a
    /// derived (projected) field.
    /// </summary>
    private const string Fixture = """
        context Shop {
          enum MassUnit { Grams, Kilograms }

          quantity Weight {
            amount: Decimal
            unit:   MassUnit
          }

          value Money {
            amount: Decimal
            invariant amount >= 0 "an amount cannot be negative"
          }

          value Line {
            base:       Money
            combined:   Money = base + base
            diff:       Money = base - base
            discounted: Money = base * 0.9
            halved:     Money = base / 2
          }

          aggregate Cart root Basket {
            event BasketOpened {
              basketId: BasketId
            }

            entity Basket identified by BasketId {
              weight: Weight
              invariant weight.amount >= 0 "a basket cannot carry a negative weight"

              create open(weight: Weight) {
                emit BasketOpened(basketId: id)
              }
            }
          }

          readmodel BasketSummary from Basket {
            id
            heavy: Bool = weight.amount > 10
          }

          service BasketService {
            usecase GetBasket(id: BasketId): BasketSummary
          }

          query BasketsHeavierThan(min: Decimal): List<BasketSummary>
        }
        """;

    /// <summary>
    /// Every dual-branch site (Task 1's table): the exact signature text shared, byte-for-byte, by the
    /// real method and its <c>RefOnly</c> stub. A mismatch here means one side of a pair drifted.
    /// </summary>
    private static readonly string[] DualBranchSignatures =
    [
        "protected equalityComponents(): readonly unknown[] {",
        "multiply(factor: number): Money {",
        "divide(divisor: number): Money {",
        "add(other: Money): Money {",
        "subtract(other: Money): Money {",
        "add(other: Weight): Weight {",
        "subtract(other: Weight): Weight {",
        "multiply(factor: number): Weight {",
        "divide(divisor: number): Weight {",
        "private checkInvariants(): void {",
        "get domainEvents(): readonly DomainEvent[] {",
        "clearDomainEvents(): void {",
        "equals(other: Basket | undefined): boolean {",
    ];

    /// <summary>Domain-model files whose emission <c>RefOnly</c> actually gates (excludes the always-full
    /// shared <c>runtime.ts</c> and the always-full smart-enum helper, neither of which <c>RefOnly</c>
    /// touches).</summary>
    private static readonly string[] GatedFileSuffixes =
    [
        "Basket.ts", "read-models/BasketSummary.ts", "value-objects/Line.ts",
        "value-objects/Money.ts", "value-objects/Weight.ts",
    ];

    private static IReadOnlyList<EmittedFile> EmitFiles(bool refOnly)
    {
        var result = new KoineCompiler().Compile(Fixture, new TypeScriptEmitter(new TsEmitterOptions { ReferenceOnly = refOnly }));
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files;
    }

    private static string Gated(IReadOnlyList<EmittedFile> files) =>
        TestSupport.Render(files.Where(f => GatedFileSuffixes.Any(suffix => f.RelativePath.EndsWith(suffix, StringComparison.Ordinal))));

    /// <summary>
    /// <c>RefOnly</c> emit must replace every executable body — quantity ops, plain-VO scalar/additive
    /// ops, the constructor, invariant checks, domain-event bookkeeping, identity equality, and the
    /// read-model projection function — with the shared stub statement, and must never leak a real
    /// invariant message or a real return expression. The type/member SIGNATURES survive intact. Scoped
    /// to <see cref="GatedFileSuffixes"/> — the shared runtime/enum helpers are always fully emitted and
    /// legitimately contain plenty of real <c>return</c> statements.
    /// </summary>
    [Fact]
    public void RefOnly_mode_emits_stub_declarations_not_bodies()
    {
        var gated = Gated(EmitFiles(refOnly: true));

        gated.ShouldContain(RefStubStatement);
        gated.ShouldNotContain("return ");
        gated.ShouldNotContain("DomainInvariantViolationError");
        gated.ShouldNotContain("an amount cannot be negative");
        gated.ShouldNotContain("a basket cannot carry a negative weight");

        gated.ShouldContain("export class Money extends ValueObject {");
        gated.ShouldContain("export class Weight extends ValueObject {");
        gated.ShouldContain("export class Basket {");
        foreach (var signature in DualBranchSignatures)
        {
            gated.ShouldContain(signature);
        }
    }
}
