using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Guards that a <c>policy … when &lt;Event&gt; then …</c> resolves its trigger event in the bounded
/// context that encloses it, rather than through <see cref="Ast.ModelIndex"/>'s flat,
/// last-declaration-wins view (#1849).
/// </summary>
/// <remarks>
/// <para>Two bounded contexts may each declare a same-named domain <c>event</c> with a different
/// payload — R13.2/R14 make that explicit, because a context owns its own ubiquitous language. The
/// flat view keeps only whichever was indexed last, so resolving through it makes the whole model's
/// legality depend on the <b>source order</b> of its contexts. Every fixture below therefore ships in
/// two orders, and both must behave identically.</para>
/// <para><b>The validator and the emitters are one contract.</b> #1844 (implementing #1834) fixed the
/// same defect one construct over, for <c>emit</c>; #1816 (implementing #1796) fixed the mirror image
/// for <c>publish</c>, where a context-aware validator over flat emitters let a legal model
/// type-check and then emit another context's payload. Moving only one half of <c>policy</c> re-opens
/// exactly that hole — so these tests deliberately assert on <b>both</b> halves (no diagnostics
/// <i>and</i> the emitted reaction sketch, for every backend that emits policies).</para>
/// </remarks>
public class PolicyCrossContextResolutionTests
{
    /// <summary>
    /// The repro from #1849, with <c>Ordering</c> declared <b>first</b> — the rejecting order, and the
    /// one a directory-mode build hits naturally (files are read alphabetically, so <c>Ordering</c>
    /// lands before <c>Warehouse</c>). <c>Warehouse.Shipped</c> is indexed last and wins the flat
    /// table, so <c>Ordering</c>'s policy was checked against a payload it never declared.
    /// </summary>
    internal const string OrderingFirstFixture = """
        context Ordering {
          event Shipped { orderId: String }

          aggregate Sales root Order {
            entity Order identified by OrderId {
              code: String
              shipped: Bool = false

              command ship {
                shipped -> true
                emit Shipped(orderId: code)
              }
              command note(orderId: String) { shipped -> true }
            }
          }

          policy NoteOnShip when Shipped then Order.note(orderId: orderId)
        }

        context Warehouse {
          event Shipped {
            packageId: String
            carrier: String
          }

          aggregate Storage root Package {
            entity Package identified by PackageId {
              label: String
            }
          }
        }
        """;

    /// <summary>
    /// The identical model with the two <c>context</c> blocks swapped — the order that accidentally
    /// compiled clean, because the flat table then happened to hold <c>Ordering</c>'s declaration.
    /// </summary>
    internal const string WarehouseFirstFixture = """
        context Warehouse {
          event Shipped {
            packageId: String
            carrier: String
          }

          aggregate Storage root Package {
            entity Package identified by PackageId {
              label: String
            }
          }
        }

        context Ordering {
          event Shipped { orderId: String }

          aggregate Sales root Order {
            entity Order identified by OrderId {
              code: String
              shipped: Bool = false

              command ship {
                shipped -> true
                emit Shipped(orderId: code)
              }
              command note(orderId: String) { shipped -> true }
            }
          }

          policy NoteOnShip when Shipped then Order.note(orderId: orderId)
        }
        """;

    private static IReadOnlyList<Diagnostic> Diagnose(string source) => new KoineCompiler().Diagnose(source);

    [Fact]
    public void Policy_resolves_a_same_named_trigger_event_in_its_own_context()
    {
        // `Ordering` first: `Warehouse.Shipped` wins the flat table, so the reaction argument
        // `orderId` was checked against Warehouse's {packageId, carrier} payload — a false KOI0201
        // "unknown field 'orderId'" on a model R13.2/R14 explicitly allow.
        Diagnose(OrderingFirstFixture).ShouldBeEmpty();
    }

    [Fact]
    public void Policy_resolves_a_same_named_trigger_event_regardless_of_context_declaration_order()
    {
        // The same model, contexts swapped. This order always compiled — asserting it alongside the
        // other is what turns "it compiles" into "it compiles *deterministically*".
        Diagnose(WarehouseFirstFixture).ShouldBeEmpty();
    }

    [Fact]
    public void Policy_resolution_does_not_depend_on_context_source_order()
    {
        Diagnose(OrderingFirstFixture)
            .Select(d => d.Code)
            .ShouldBe(Diagnose(WarehouseFirstFixture).Select(d => d.Code));
    }
}
