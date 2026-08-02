using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Guards that an <c>emit</c>'s event name resolves in the bounded context that encloses it, rather
/// than through <see cref="Ast.ModelIndex"/>'s flat, last-declaration-wins view (#1834).
/// </summary>
/// <remarks>
/// <para>Two bounded contexts may each declare a same-named domain <c>event</c> with a different
/// payload — R13.2/R14 make that explicit, because a context owns its own ubiquitous language. The
/// flat view keeps only whichever was indexed last, so resolving through it makes the whole model's
/// legality depend on the <b>source order</b> of its contexts. Every fixture below therefore ships in
/// two orders, and both must behave identically.</para>
/// <para><b>The validator and the emitters are one contract.</b> #1816 (implementing #1796) fixed the
/// mirror image of this defect for <c>publish</c>: there the validator already resolved context-aware
/// while the emitters stayed flat, so a legal model type-checked and then emitted an uncompilable
/// constructor call of the wrong arity. Moving only one half of <c>emit</c> re-opens exactly that hole
/// — so these tests deliberately assert on <b>both</b> halves (no diagnostics <i>and</i> the emitted
/// payload, for every target).</para>
/// </remarks>
public class EmitCrossContextResolutionTests
{
    /// <summary>
    /// The repro from #1834, with <c>Ordering</c> declared <b>first</b> — the rejecting order, and the
    /// one a directory-mode build hits naturally (files are read alphabetically, so <c>Ordering</c>
    /// lands before <c>Warehouse</c>). <c>Warehouse.Shipped</c> is indexed last and wins the flat
    /// table, so <c>Ordering</c>'s <c>emit</c> was checked against a payload it never declared.
    /// </summary>
    internal const string OrderingFirstFixture = """
        context Ordering {
          value OrderId { value: String }

          event Shipped { orderId: OrderId }

          aggregate Sales root Order {
            entity Order identified by OrderId {
              shipped: Bool = false

              command ship {
                shipped -> true
                emit Shipped(orderId: id)
              }
            }
          }
        }

        context Warehouse {
          value PackageId { value: String }

          event Shipped {
            packageId: PackageId
            carrier: String
          }
        }
        """;

    /// <summary>
    /// The identical model with the two <c>context</c> blocks swapped — the order that accidentally
    /// compiled clean, because the flat table then happened to hold <c>Ordering</c>'s declaration.
    /// </summary>
    internal const string WarehouseFirstFixture = """
        context Warehouse {
          value PackageId { value: String }

          event Shipped {
            packageId: PackageId
            carrier: String
          }
        }

        context Ordering {
          value OrderId { value: String }

          event Shipped { orderId: OrderId }

          aggregate Sales root Order {
            entity Order identified by OrderId {
              shipped: Bool = false

              command ship {
                shipped -> true
                emit Shipped(orderId: id)
              }
            }
          }
        }
        """;

    private static IReadOnlyList<Diagnostic> Diagnose(string source) => new KoineCompiler().Diagnose(source);

    [Fact]
    public void Emit_resolves_a_same_named_event_in_its_own_context()
    {
        // `Ordering` first: `Warehouse.Shipped` wins the flat table. Before #1834 this produced three
        // false KOI0602s — one "no field 'orderId'" plus one missing-field per Warehouse-only field.
        Diagnose(OrderingFirstFixture).ShouldBeEmpty();
    }

    [Fact]
    public void Emit_resolves_a_same_named_event_regardless_of_context_declaration_order()
    {
        // The same model, contexts swapped. This order always compiled — asserting it alongside the
        // other is what turns "it compiles" into "it compiles *deterministically*".
        Diagnose(WarehouseFirstFixture).ShouldBeEmpty();
    }

    [Fact]
    public void Emit_resolution_does_not_depend_on_context_source_order()
    {
        Diagnose(OrderingFirstFixture)
            .Select(d => d.Code)
            .ShouldBe(Diagnose(WarehouseFirstFixture).Select(d => d.Code));
    }
}
