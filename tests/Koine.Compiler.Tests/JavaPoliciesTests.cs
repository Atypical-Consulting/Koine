using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// The policy slice of the Java backend (issue #1090, Phase 2 Task 2) — the Java analogue of
/// <c>PythonEmitter.Policies.cs</c> and the C# emitter's <c>EmitPolicy</c>. A Koine
/// <c>policy … when &lt;Event&gt; then &lt;Target&gt;.&lt;command&gt;(arg: …)</c> emits a
/// <c>&lt;Name&gt;Policy</c> reactor <b>interface</b> with a single <c>react(&lt;Event&gt; event)</c>
/// method. Koine deliberately does NOT generate the imperative cross-aggregate call — the intended
/// reaction, with its arguments translated from the triggering event's fields, is documented in the
/// Javadoc and the consumer wires it. The fixture mirrors
/// <see cref="Conformance.TypeScriptPoliciesSnapshotTests"/>'s so the targets stay comparable.
/// </summary>
public class JavaPoliciesTests
{
    /// <summary>A focused policy cross-section (event + aggregate command + policy).</summary>
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

    /// <summary>
    /// A policy emits a <c>&lt;Name&gt;Policy</c> interface whose one method takes the triggering event —
    /// the seam the consumer implements. The reaction sketch names the target command and its arguments
    /// rooted at the <c>event</c> parameter, so the modelled intent survives into the generated Javadoc.
    /// </summary>
    [Fact]
    public void Policy_emits_a_reactor_interface_documenting_the_intended_reaction()
    {
        var result = new KoineCompiler().Compile(Fixture, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var policy = result.Files
            .Single(f => f.RelativePath.EndsWith("PostToLedgerPolicy.java", StringComparison.Ordinal)).Contents;

        policy.ShouldContain("public interface PostToLedgerPolicy {");
        policy.ShouldContain("void react(ChargeCaptured event);");
        // The reaction sketch: the target command with its arguments translated off the event — and every
        // identifier rendered the JAVA way, so `command record` (a Java contextual keyword) is named
        // `record_` here exactly as the emitted LedgerEntry method is. A sketch naming `record` would
        // point at a method that does not exist.
        policy.ShouldContain("Books.record_(amount: event.capturedAmount())");
        // Koine emits the seam, never the cross-aggregate call itself.
        policy.ShouldContain("Koine does not generate the cross-aggregate call");
    }

    /// <summary>
    /// A policy triggered by an event declared in ANOTHER bounded context must type its
    /// <c>react</c> parameter with the event's package-qualified name, or the emitted Java would
    /// reference a type that does not exist in the policy's own package.
    /// </summary>
    [Fact]
    public void Policy_qualifies_a_cross_context_trigger_event()
    {
        const string src = """
            contextmap {
              Sales -> Shipping : conformist
            }

            context Sales {
              event OrderPlaced {
                orderRef: String
              }
            }

            context Shipping {
              import Sales.{ OrderPlaced }

              aggregate Dispatching root Shipment {
                entity Shipment identified by ShipmentId {
                  orderRef: String

                  command schedule(orderRef: String) {
                    orderRef -> orderRef
                  }
                }
              }

              policy ScheduleOnOrder when OrderPlaced then Dispatching.schedule(orderRef: orderRef)
            }
            """;
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var policy = result.Files
            .Single(f => f.RelativePath.EndsWith("shipping/ScheduleOnOrderPolicy.java", StringComparison.Ordinal))
            .Contents;

        policy.ShouldContain("void react(koine.generated.sales.OrderPlaced event);");
    }
}
