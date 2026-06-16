using System.Reflection;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>Epic R14.3 — Integration events as a published language with subscribers.</summary>
public class R14IntegrationEventsTests
{
    private static IReadOnlyList<Diagnostic> Diagnose(string source) => new KoineCompiler().Diagnose(source);

    private static (Assembly Asm, IReadOnlyList<Emit.EmittedFile> Files) Build(params SourceFile[] files)
    {
        var result = new KoineCompiler().Compile(files, new CSharpEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var (asm, errors) = TestSupport.Compile(result.Files);
        Assert.True(asm is not null, "generated C# failed to compile:\n" + string.Join("\n", errors));
        return (asm!, result.Files);
    }

    private static (Assembly Asm, IReadOnlyList<Emit.EmittedFile> Files) Build(string source) =>
        Build(new SourceFile("<test>.koi", source));

    private static string FileContents(IEnumerable<Emit.EmittedFile> files, string path) =>
        files.Single(f => f.RelativePath == path).Contents;

    // A publisher/subscriber pair authorized by an open-host relation.
    private const string PubSub = """
        context Sales {
          publishes OrderPlaced
          integration event OrderPlaced {
            orderId:  OrderId
            total:    Decimal
            placedAt: Instant
          }
        }
        context Shipping {
          subscribes Sales.OrderPlaced
        }
        contextmap {
          Sales -> Shipping : open-host
        }
        """;

    // ---- emission ----------------------------------------------------------

    [Fact]
    public void Integration_event_emits_a_record_with_the_runtime_marker()
    {
        var (asm, files) = Build(PubSub);
        Assert.Contains("public sealed record OrderPlaced : IIntegrationEvent", FileContents(files, "Sales/IntegrationEvents/OrderPlaced.cs"));
        Assert.Contains(files, f => f.RelativePath == "Koine/Runtime/IIntegrationEvent.cs");
        Assert.NotNull(asm.GetType("Sales.OrderPlaced"));
        Assert.NotNull(asm.GetType("Koine.Runtime.IIntegrationEvent"));
    }

    [Fact]
    public void The_marker_is_only_emitted_when_integration_events_exist()
    {
        var (_, files) = Build("context C {\n  value V { n: Int }\n}\n");
        Assert.DoesNotContain(files, f => f.RelativePath == "Koine/Runtime/IIntegrationEvent.cs");
    }

    [Fact]
    public void Subscriber_gets_a_handler_interface_with_a_precise_publisher_using()
    {
        var (asm, files) = Build(PubSub);
        var handler = FileContents(files, "Shipping/Abstractions/IHandleOrderPlaced.cs");
        Assert.Contains("public interface IHandleOrderPlaced", handler);
        // The event type is fully-qualified with the publisher namespace (so it cannot bind to a
        // same-named local integration event).
        Assert.Contains("Task Handle(Sales.OrderPlaced theEvent, CancellationToken ct = default);", handler);
        Assert.NotNull(asm.GetType("Shipping.IHandleOrderPlaced"));
    }

    [Fact]
    public void A_publish_only_context_gets_no_handler()
    {
        var (_, files) = Build(PubSub);
        Assert.DoesNotContain(files, f => f.RelativePath == "Sales/Abstractions/IHandleOrderPlaced.cs");
    }

    [Fact]
    public void A_subscriber_does_not_re_emit_the_publishers_event_record()
    {
        var (_, files) = Build(PubSub);
        Assert.DoesNotContain(files, f => f.RelativePath == "Shipping/IntegrationEvents/OrderPlaced.cs");
    }

    [Fact]
    public void An_integration_event_at_module_scope_gets_the_module_namespace()
    {
        var (asm, files) = Build("""
            context Sales {
              module Contracts { integration event OrderPlaced { orderId: OrderId } }
            }
            """);
        Assert.Contains("namespace Sales.Contracts;", FileContents(files, "Sales/Contracts/IntegrationEvents/OrderPlaced.cs"));
        Assert.NotNull(asm.GetType("Sales.Contracts.OrderPlaced"));
    }

    // ---- field-type leak checks (KOI1409) ----------------------------------

    [Fact]
    public void A_field_referencing_an_entity_leaks_internals()
    {
        const string src = """
            context Sales {
              entity Order identified by OrderId { customer: CustomerId }
              integration event OrderPlaced { order: Order }
            }
            """;
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.IntegrationEventLeaksInternals);
    }

    [Fact]
    public void A_field_referencing_a_value_object_leaks_internals()
    {
        const string src = """
            context Sales {
              value Money { amount: Decimal }
              integration event OrderPlaced { total: Money }
            }
            """;
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.IntegrationEventLeaksInternals);
    }

    [Fact]
    public void A_field_referencing_a_domain_event_leaks_internals()
    {
        const string src = """
            context Sales {
              event OrderOpened { orderId: OrderId }
              integration event OrderPlaced { opened: OrderOpened }
            }
            """;
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.IntegrationEventLeaksInternals);
    }

    [Fact]
    public void Primitives_enums_ids_and_other_integration_events_are_allowed()
    {
        const string src = """
            context Sales {
              enum Channel { Web, Store }
              integration event LineAdded { sku: String }
              integration event OrderPlaced {
                orderId:  OrderId
                total:    Decimal
                channel:  Channel
                lines:    List<LineAdded>
              }
            }
            """;
        Assert.DoesNotContain(Diagnose(src), d => d.Code == DiagnosticCodes.IntegrationEventLeaksInternals);
    }

    // ---- publishes ---------------------------------------------------------

    [Fact]
    public void Publishing_an_unknown_event_is_reported()
    {
        Assert.Contains(Diagnose("context Sales {\n  publishes Ghost\n}\n"),
            d => d.Code == DiagnosticCodes.UnknownPublishedEvent);
    }

    [Fact]
    public void Publishing_a_domain_event_rather_than_an_integration_event_is_reported()
    {
        const string src = "context Sales {\n  publishes OrderOpened\n  event OrderOpened { orderId: OrderId }\n}\n";
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.UnknownPublishedEvent);
    }

    [Fact]
    public void Publishing_the_same_event_twice_is_reported()
    {
        const string src = "context Sales {\n  publishes OrderPlaced\n  publishes OrderPlaced\n  integration event OrderPlaced { orderId: OrderId }\n}\n";
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.DuplicatePublish);
    }

    // ---- subscribes --------------------------------------------------------

    [Fact]
    public void Subscribing_to_an_unknown_context_is_reported()
    {
        Assert.Contains(Diagnose("context Shipping {\n  subscribes Nope.OrderPlaced\n}\n"),
            d => d.Code == DiagnosticCodes.SubscribeUnknownContext);
    }

    [Fact]
    public void Subscribing_to_an_event_that_is_not_published_is_reported()
    {
        const string src = """
            context Sales { integration event OrderPlaced { orderId: OrderId } }
            context Shipping { subscribes Sales.OrderPlaced }
            contextmap { Sales -> Shipping : open-host }
            """;
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.SubscribeNotPublished);
    }

    [Fact]
    public void Subscribing_twice_to_the_same_event_is_reported()
    {
        const string src = """
            context Sales { publishes OrderPlaced  integration event OrderPlaced { orderId: OrderId } }
            context Shipping { subscribes Sales.OrderPlaced  subscribes Sales.OrderPlaced }
            contextmap { Sales -> Shipping : open-host }
            """;
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.DuplicateSubscribe);
    }

    [Fact]
    public void Subscribing_without_an_authorizing_relation_is_reported()
    {
        const string src = """
            context Sales { publishes OrderPlaced  integration event OrderPlaced { orderId: OrderId } }
            context Shipping { subscribes Sales.OrderPlaced }
            contextmap { Sales -> Shipping : conformist }
            """;
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.SubscribeNoRelation);
    }

    [Fact]
    public void An_open_host_relation_authorizes_a_subscribe()
    {
        Assert.DoesNotContain(Diagnose(PubSub), d => d.Code == DiagnosticCodes.SubscribeNoRelation);
    }

    [Fact]
    public void A_customer_supplier_relation_authorizes_a_subscribe()
    {
        const string src = """
            context Sales { publishes OrderPlaced  integration event OrderPlaced { orderId: OrderId } }
            context Shipping { subscribes Sales.OrderPlaced }
            contextmap { Sales -> Shipping : customer-supplier }
            """;
        Assert.DoesNotContain(Diagnose(src), d => d.Code == DiagnosticCodes.SubscribeNoRelation);
    }

    [Fact]
    public void With_no_context_map_a_subscribe_is_not_a_relation_error()
    {
        const string src = """
            context Sales { publishes OrderPlaced  integration event OrderPlaced { orderId: OrderId } }
            context Shipping { subscribes Sales.OrderPlaced }
            """;
        Assert.DoesNotContain(Diagnose(src), d => d.Code == DiagnosticCodes.SubscribeNoRelation);
    }

    // ---- merge & soft keywords --------------------------------------------

    [Fact]
    public void Publish_and_subscribe_merge_across_files()
    {
        var (_, files) = Build(
            new SourceFile("sales.koi", "context Sales {\n  publishes OrderPlaced\n  integration event OrderPlaced { orderId: OrderId }\n}\n"),
            new SourceFile("shipping.koi", "context Shipping {\n  subscribes Sales.OrderPlaced\n}\n"),
            new SourceFile("map.koi", "contextmap {\n  Sales -> Shipping : open-host\n}\n"));
        Assert.Contains(files, f => f.RelativePath == "Shipping/Abstractions/IHandleOrderPlaced.cs");
    }

    [Fact]
    public void New_keywords_remain_usable_as_field_names()
    {
        Assert.Empty(Diagnose("context C {\n  value V { integration: Int  publishes: Int  subscribes: Int  acl: Int }\n}\n"));
    }

    // ---- review regressions ------------------------------------------------

    [Fact]
    public void A_handler_does_not_bind_to_a_same_named_local_integration_event()
    {
        // Shipping declares its OWN OrderPlaced; the handler for Sales.OrderPlaced must take
        // Sales.OrderPlaced, not the local one.
        var (asm, _) = Build("""
            context Sales {
              publishes OrderPlaced
              integration event OrderPlaced { orderId: OrderId }
            }
            context Shipping {
              subscribes Sales.OrderPlaced
              integration event OrderPlaced { a: Int  b: Int }
            }
            contextmap { Sales -> Shipping : open-host }
            """);
        var handler = asm.GetType("Shipping.IHandleOrderPlaced")!;
        var param = handler.GetMethod("Handle")!.GetParameters()[0];
        Assert.Equal("Sales.OrderPlaced", param.ParameterType.FullName);
    }

    [Fact]
    public void Subscribing_to_two_same_named_events_from_different_publishers_is_reported()
    {
        const string src = """
            context Sales { publishes Changed  integration event Changed { id: OrderId } }
            context Inventory { publishes Changed  integration event Changed { id: ItemId } }
            context Hub { subscribes Sales.Changed  subscribes Inventory.Changed }
            contextmap {
              Sales -> Hub : open-host
              Inventory -> Hub : open-host
            }
            """;
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.SubscribeHandlerNameCollision);
    }
}
