using Koine.Compiler.Ast;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Tests for the derived call-graph lookup on <see cref="ModelIndex"/> (target-agnostic):
/// command → emitted events, events → emitting commands, and event → policy reactions.
/// </summary>
public class CallGraphIndexTests
{
    // Context A: an entity command emits a domain event.
    private const string SourceA =
        """
        context Ordering {
          event OrderPlaced {
            order: OrderId
          }

          entity Order identified by OrderId {
            total: Int

            command place {
              emit OrderPlaced(order: id)
            }
          }
        }
        """;

    // Context B: a policy on another context reacts to that event by invoking a command
    // (B) on a target entity, whose argument is drawn from the event's field.
    private const string SourceB =
        """
        context Shipping {
          entity Shipment identified by ShipmentId {
            order: OrderId

            command B(order: OrderId) {
              order -> order
            }
          }

          policy ShipOnOrder when OrderPlaced then Shipment.B(order: order)
        }
        """;

    private static ModelIndex BuildIndex()
    {
        var files = new[]
        {
            new SourceFile("file:///a.koi", SourceA),
            new SourceFile("file:///b.koi", SourceB),
        };
        KoineCompilation comp = KoineCompilation.Create(files);
        return comp.SemanticModel.Index;
    }

    [Fact]
    public void EventsEmittedBy_returns_the_events_a_command_emits()
    {
        ModelIndex index = BuildIndex();

        index.EventsEmittedBy("Order", "place").ShouldContain("OrderPlaced");
    }

    [Fact]
    public void CommandsEmitting_returns_the_command_that_emits_an_event()
    {
        ModelIndex index = BuildIndex();

        index.CommandsEmitting("OrderPlaced").ShouldContain(("Order", "place"));
    }

    [Fact]
    public void PoliciesTriggeredByEvent_returns_the_reaction_target_of_a_policy()
    {
        ModelIndex index = BuildIndex();

        index.PoliciesTriggeredByEvent("OrderPlaced").ShouldContain(("Shipment", "B"));
    }

    [Fact]
    public void Unknown_keys_return_empty_lists()
    {
        ModelIndex index = BuildIndex();

        index.EventsEmittedBy("Nope", "nope").ShouldBeEmpty();
        index.CommandsEmitting("NoSuchEvent").ShouldBeEmpty();
        index.PoliciesTriggeredByEvent("NoSuchEvent").ShouldBeEmpty();
    }
}
