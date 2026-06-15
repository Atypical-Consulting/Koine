using System.Collections;
using System.Reflection;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>Epic R6 — Domain Events.</summary>
public class R6EventTests
{
    private const string Fixture = """
        context Sales {
          enum OrderStatus { Draft, Placed }
          value OrderLine { product: ProductId  quantity: Int }

          /// Raised when an order is placed.
          event OrderPlaced {
            orderId:   OrderId
            lineCount: Int
          }

          aggregate Order root Order {
            entity Order identified by OrderId {
              status: OrderStatus = Draft
              lines:  List<OrderLine>

              invariant status == Draft when lines.isEmpty

              command place {
                requires !lines.isEmpty   "cannot place an empty order"
                requires status == Draft  "order already placed"
                status -> Placed
                emit OrderPlaced(orderId: id, lineCount: lines.count)
              }
            }
          }
        }
        """;

    private static (Assembly Asm, IReadOnlyList<EmittedFile> Files) Compile(string source)
    {
        var result = new KoineCompiler().Compile(source, new CSharpEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var (asm, errors) = TestSupport.Compile(result.Files);
        Assert.True(asm is not null, "generated C# failed to compile:\n" + string.Join("\n", errors));
        return (asm, result.Files);
    }

    private static IReadOnlyList<Diagnostic> Diagnose(string source) => new KoineCompiler().Diagnose(source);

    // ---- R6.1 event types --------------------------------------------------

    [Fact]
    public void Event_is_a_record_implementing_IDomainEvent_with_occurred_on()
    {
        var (asm, _) = Compile(Fixture);
        var ev = asm.GetType("Sales.OrderPlaced")!;
        var orderId = asm.GetType("Sales.OrderId")!;

        Assert.Contains(ev.GetInterfaces(), i => i.Name == "IDomainEvent");

        var e = Activator.CreateInstance(ev, orderId.GetMethod("New")!.Invoke(null, null), 3)!;
        var occurredOn = (DateTimeOffset)ev.GetProperty("OccurredOn")!.GetValue(e)!;
        Assert.True(occurredOn > DateTimeOffset.UtcNow.AddMinutes(-1));
        Assert.Equal(3, ev.GetProperty("LineCount")!.GetValue(e));
    }

    [Fact]
    public void Event_has_value_equality_on_its_fields()
    {
        var (asm, _) = Compile(Fixture);
        var ev = asm.GetType("Sales.OrderPlaced")!;
        var orderId = asm.GetType("Sales.OrderId")!;
        var id = orderId.GetMethod("New")!.Invoke(null, null);

        var e1 = Activator.CreateInstance(ev, id, 3)!;
        var e2 = Activator.CreateInstance(ev, id, 3)!;
        // Align the only non-field member (the occurrence timestamp) so we compare on data.
        ev.GetProperty("OccurredOn")!.SetValue(e2, ev.GetProperty("OccurredOn")!.GetValue(e1));
        Assert.True(e1.Equals(e2));   // value equality

        var e3 = Activator.CreateInstance(ev, id, 99)!;
        ev.GetProperty("OccurredOn")!.SetValue(e3, ev.GetProperty("OccurredOn")!.GetValue(e1));
        Assert.False(e1.Equals(e3));  // different field -> not equal
    }

    [Fact]
    public void IDomainEvent_runtime_is_emitted_only_when_events_exist()
    {
        var (_, withEvents) = Compile(Fixture);
        Assert.Contains(withEvents, f => f.RelativePath == "Koine/Runtime/IDomainEvent.cs");

        const string noEvents = "context C {\n  value V { x: Int }\n}\n";
        var result = new KoineCompiler().Compile(noEvents, new CSharpEmitter());
        Assert.DoesNotContain(result.Files, f => f.RelativePath == "Koine/Runtime/IDomainEvent.cs");
    }

    // ---- R6.2 emit ---------------------------------------------------------

    [Fact]
    public void Command_emit_records_the_event_and_clear_empties_the_collection()
    {
        var (asm, _) = Compile(Fixture);
        var order = asm.GetType("Sales.Order")!;
        var orderId = asm.GetType("Sales.OrderId")!;
        var line = asm.GetType("Sales.OrderLine")!;
        var productId = asm.GetType("Sales.ProductId")!;

        var lines = (IList)Activator.CreateInstance(typeof(List<>).MakeGenericType(line))!;
        lines.Add(Activator.CreateInstance(line, productId.GetMethod("New")!.Invoke(null, null), 1));
        var o = Activator.CreateInstance(order, orderId.GetMethod("New")!.Invoke(null, null), lines, null)!;

        order.GetMethod("Place")!.Invoke(o, null);

        var events = (IEnumerable)order.GetProperty("DomainEvents")!.GetValue(o)!;
        var recorded = events.Cast<object>().ToList();
        Assert.Single(recorded);
        Assert.Equal("OrderPlaced", recorded[0].GetType().Name);
        Assert.Equal(1, recorded[0].GetType().GetProperty("LineCount")!.GetValue(recorded[0]));
        Assert.Equal(order.GetProperty("Id")!.GetValue(o), recorded[0].GetType().GetProperty("OrderId")!.GetValue(recorded[0]));

        order.GetMethod("ClearDomainEvents")!.Invoke(o, null);
        Assert.Empty(((IEnumerable)order.GetProperty("DomainEvents")!.GetValue(o)!).Cast<object>());
    }

    // ---- diagnostics -------------------------------------------------------

    [Fact]
    public void Emit_of_unknown_event_is_reported()
    {
        const string src =
            "context C {\n  entity E identified by EId {\n    n: Int\n    command go { emit Nope(x: n) }\n  }\n}\n";
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.UnknownEvent);
    }

    [Fact]
    public void Emit_with_unknown_payload_field_is_reported()
    {
        const string src =
            "context C {\n  event Happened { n: Int }\n  entity E identified by EId {\n    n: Int\n    command go { emit Happened(bogus: n) }\n  }\n}\n";
        var diags = Diagnose(src);
        Assert.Contains(diags, d => d.Code == DiagnosticCodes.EmitPayloadMismatch && d.Message.Contains("no field 'bogus'"));
    }

    [Fact]
    public void Emit_missing_a_payload_field_is_reported()
    {
        const string src =
            "context C {\n  event Happened { a: Int  b: Int }\n  entity E identified by EId {\n    a: Int\n    command go { emit Happened(a: a) }\n  }\n}\n";
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.EmitPayloadMismatch && d.Message.Contains("missing field 'b'"));
    }

    [Fact]
    public void Emit_with_wrong_payload_type_is_reported()
    {
        const string src =
            "context C {\n  event Happened { name: String }\n  entity E identified by EId {\n    n: Int\n    command go { emit Happened(name: n) }\n  }\n}\n";
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.EmitPayloadMismatch);
    }

    // ---- regressions found by the R6 review --------------------------------

    [Fact]
    public void Emit_args_align_with_reordered_event_constructor()
    {
        // `note` is optional and declared FIRST, so the event ctor reorders it last;
        // the emit must still bind values to the right parameters.
        const string src =
            "context C {\n" +
            "  event Pair { note: String?  amount: Int }\n" +
            "  entity E identified by EId {\n" +
            "    n: Int\n" +
            "    command go { n -> n  emit Pair(note: \"hi\", amount: n) }\n" +
            "  }\n" +
            "}\n";
        Assert.Empty(Diagnose(src));

        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        var (asm, errors) = TestSupport.Compile(result.Files);
        Assert.True(asm is not null, "generated C# failed to compile:\n" + string.Join("\n", errors));
    }

    [Fact]
    public void Event_field_colliding_with_OccurredOn_is_reported()
    {
        Assert.Contains(Diagnose("context C {\n  event E { occurredOn: Instant  n: Int }\n}\n"),
            d => d.Code == DiagnosticCodes.ReservedEventField);
    }

    [Fact]
    public void Emit_with_mismatched_collection_element_is_reported()
    {
        const string src =
            "context C {\n  event E { xs: List<Int> }\n  entity Ent identified by EId {\n    ys: List<String>\n    command go { emit E(xs: ys) }\n  }\n}\n";
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.EmitPayloadMismatch);
    }

    [Fact]
    public void Emit_with_numeric_narrowing_is_reported_but_widening_is_allowed()
    {
        const string narrowing =
            "context C {\n  event E { n: Int }\n  entity Ent identified by EId {\n    price: Decimal\n    command go { emit E(n: price) }\n  }\n}\n";
        Assert.Contains(Diagnose(narrowing), d => d.Code == DiagnosticCodes.EmitPayloadMismatch);

        const string widening =
            "context C {\n  event E { d: Decimal }\n  entity Ent identified by EId {\n    count: Int\n    command go { emit E(d: count) }\n  }\n}\n";
        Assert.Empty(Diagnose(widening)); // Int -> Decimal is an implicit widening
    }

    [Fact]
    public void Emit_from_a_non_root_entity_is_reported()
    {
        const string src =
            "context C {\n" +
            "  event Ev { x: Int }\n" +
            "  aggregate A root Root {\n" +
            "    entity Root identified by RId { n: Int }\n" +
            "    entity Child identified by CId { q: Int  command go { emit Ev(x: q) } }\n" +
            "  }\n" +
            "}\n";
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.EmitOutsideRoot);
    }
}
