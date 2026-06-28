using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Call-hierarchy support in the language service (#260, Task 3). The domain call graph is
/// <c>command --emit--> event --policy--> command</c>; each request expands exactly ONE level of
/// edges (so a self-emitting cycle terminates). Prepare resolves the command/event under the cursor;
/// incoming/outgoing walk one hop via the Task 1 <see cref="Koine.Compiler.Ast.ModelIndex"/> graph,
/// resolving each edge target back to its declaration span so an editor can navigate to it.
/// </summary>
public class CallHierarchyTests
{
    private static readonly KoineLanguageService Svc = new();

    // A clean two-file model: an Ordering entity command emits OrderPlaced; a Shipping policy
    // reacts to OrderPlaced by invoking Shipment.B. Mirrors CallGraphIndexTests' syntax.
    private const string OrderingUri = "file:///ordering.koi";
    private const string OrderingSrc =
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

    private const string ShippingUri = "file:///shipping.koi";
    private const string ShippingSrc =
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

    private static KoineCompilation Compile() =>
        KoineCompilation.Create(new[]
        {
            new SourceFile(OrderingUri, OrderingSrc),
            new SourceFile(ShippingUri, ShippingSrc),
        });

    // The 0-based LSP line/character of `needle` within a substring search anchored at `after` (so we
    // can target `place` on its command line, not an earlier mention). The cursor is placed ONE column
    // into the token (TokenLocator.Contains is `(start, end]` — a cursor at the token's first column
    // does not select it), so the token sits under the cursor.
    private static (int line, int character) PositionOf(string source, string needle, string after)
    {
        var anchor = source.IndexOf(after, StringComparison.Ordinal);
        var index = source.IndexOf(needle, anchor, StringComparison.Ordinal) + 1;
        var line = 0;
        var lineStart = 0;
        for (var i = 0; i < index; i++)
        {
            if (source[i] == '\n')
            {
                line++;
                lineStart = i + 1;
            }
        }

        return (line, index - lineStart);
    }

    [Fact]
    public void Prepare_on_a_command_name_returns_one_Command_item()
    {
        var comp = Compile();
        var (line, character) = PositionOf(OrderingSrc, "place", "command place");

        var items = Svc.PrepareCallHierarchy(comp, OrderingUri, line, character);

        var item = items.ShouldHaveSingleItem();
        item.Kind.ShouldBe(CallHierarchyItemKind.Command);
        item.Name.ShouldBe("place");
        item.OwningType.ShouldBe("Order");
    }

    [Fact]
    public void OutgoingCalls_on_a_command_contain_the_emitted_event()
    {
        var comp = Compile();
        var (line, character) = PositionOf(OrderingSrc, "place", "command place");
        var command = Svc.PrepareCallHierarchy(comp, OrderingUri, line, character).Single();

        var outgoing = Svc.OutgoingCalls(comp, command);

        outgoing.ShouldContain(c => c.To.Kind == CallHierarchyItemKind.Event && c.To.Name == "OrderPlaced");
    }

    [Fact]
    public void IncomingCalls_on_an_event_contain_the_emitting_command()
    {
        var comp = Compile();
        var (line, character) = PositionOf(OrderingSrc, "OrderPlaced", "event OrderPlaced");
        var ev = Svc.PrepareCallHierarchy(comp, OrderingUri, line, character).Single();
        ev.Kind.ShouldBe(CallHierarchyItemKind.Event);

        var incoming = Svc.IncomingCalls(comp, ev);

        incoming.ShouldContain(c =>
            c.From.Kind == CallHierarchyItemKind.Command && c.From.Name == "place" && c.From.OwningType == "Order");
    }

    [Fact]
    public void OutgoingCalls_on_an_event_contain_the_policy_triggered_command()
    {
        var comp = Compile();
        var (line, character) = PositionOf(OrderingSrc, "OrderPlaced", "event OrderPlaced");
        var ev = Svc.PrepareCallHierarchy(comp, OrderingUri, line, character).Single();

        var outgoing = Svc.OutgoingCalls(comp, ev);

        // The Shipping policy reacts to OrderPlaced by invoking Shipment.B — resolved cross-file.
        outgoing.ShouldContain(c =>
            c.To.Kind == CallHierarchyItemKind.Command && c.To.Name == "B" && c.To.OwningType == "Shipment");
        var b = outgoing.First(c => c.To.Name == "B").To;
        b.Uri.ShouldBe(ShippingUri);
    }

    [Fact]
    public void Edge_item_points_at_the_declaration_across_files()
    {
        var comp = Compile();
        var (line, character) = PositionOf(OrderingSrc, "place", "command place");
        var command = Svc.PrepareCallHierarchy(comp, OrderingUri, line, character).Single();

        // The emitted-event edge resolves to OrderPlaced's declaration in ordering.koi.
        var emitted = Svc.OutgoingCalls(comp, command).First(c => c.To.Name == "OrderPlaced").To;
        emitted.Uri.ShouldBe(OrderingUri);
        emitted.Span.IsNone.ShouldBeFalse();
    }

    [Fact]
    public void Prepare_off_any_command_or_event_returns_empty()
    {
        var comp = Compile();

        // The `total` field name is neither a command nor an event.
        var (line, character) = PositionOf(OrderingSrc, "total", "total: Int");
        Svc.PrepareCallHierarchy(comp, OrderingUri, line, character).ShouldBeEmpty();

        // A primitive type name (`Int`) is also off-target.
        var (l2, c2) = PositionOf(OrderingSrc, "Int", "total: Int");
        Svc.PrepareCallHierarchy(comp, OrderingUri, l2, c2).ShouldBeEmpty();
    }

    // A self-emitting cycle: Loop.tick emits Ticked, and a policy re-triggers Loop.tick on Ticked.
    private const string CycleUri = "file:///cycle.koi";
    private const string CycleSrc =
        """
        context Looping {
          event Ticked {
            loop: LoopId
          }

          entity Loop identified by LoopId {
            count: Int

            command tick {
              emit Ticked(loop: id)
            }
          }

          policy ReTick when Ticked then Loop.tick()
        }
        """;

    // Two entities both declare `settle`; Invoice has a `Receipt`-typed field immediately before its
    // own `command settle`, so the token two before the cursor is `Receipt` — which ALSO declares
    // `settle`. The owner must be the enclosing entity (Invoice), not the preceding type token.
    private const string AmbiguousUri = "file:///billing.koi";
    private const string AmbiguousSrc =
        """
        context Billing {
          entity Receipt identified by ReceiptId {
            total: Int

            command settle {
              total -> total
            }
          }

          entity Invoice identified by InvoiceId {
            receipt: Receipt

            command settle {
              receipt -> receipt
            }
          }
        }
        """;

    [Fact]
    public void Prepare_binds_a_command_to_its_enclosing_entity_not_a_preceding_type_token()
    {
        var comp = KoineCompilation.Create(new[] { new SourceFile(AmbiguousUri, AmbiguousSrc) });
        // Cursor on Invoice's `settle` (anchored after its `Receipt`-typed field, which is unique to it).
        var (line, character) = PositionOf(AmbiguousSrc, "settle", "receipt: Receipt");

        var item = Svc.PrepareCallHierarchy(comp, AmbiguousUri, line, character).ShouldHaveSingleItem();

        item.Kind.ShouldBe(CallHierarchyItemKind.Command);
        item.Name.ShouldBe("settle");
        item.OwningType.ShouldBe("Invoice"); // the enclosing entity wins over the `Receipt` token before `command`
    }

    [Fact]
    public void A_self_emitting_cycle_terminates()
    {
        var comp = KoineCompilation.Create(new[] { new SourceFile(CycleUri, CycleSrc) });
        var (line, character) = PositionOf(CycleSrc, "tick", "command tick");
        var command = Svc.PrepareCallHierarchy(comp, CycleUri, line, character).Single();

        // One level only: tick -> Ticked (outgoing). The cycle does NOT recurse, so this is finite.
        var outgoing = Svc.OutgoingCalls(comp, command);
        outgoing.ShouldContain(c => c.To.Kind == CallHierarchyItemKind.Event && c.To.Name == "Ticked");

        // And the event's outgoing edge re-points at tick — still just one level, no stack overflow.
        var ev = Svc.PrepareCallHierarchy(comp, CycleUri,
            PositionOf(CycleSrc, "Ticked", "event Ticked").line,
            PositionOf(CycleSrc, "Ticked", "event Ticked").character).Single();
        Svc.OutgoingCalls(comp, ev)
            .ShouldContain(c => c.To.Kind == CallHierarchyItemKind.Command && c.To.Name == "tick");
        Svc.IncomingCalls(comp, ev)
            .ShouldContain(c => c.From.Kind == CallHierarchyItemKind.Command && c.From.Name == "tick");
    }
}
