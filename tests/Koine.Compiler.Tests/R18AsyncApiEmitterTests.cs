using Koine.Compiler.Emit.AsyncApi;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Epic R18 — the AsyncAPI 3.0 emitter (<c>--target asyncapi</c>): one YAML document
/// describing a domain's integration-event contracts and their pub/sub flow.
/// </summary>
public class R18AsyncApiEmitterTests
{
    private readonly ITestOutputHelper _output;

    public R18AsyncApiEmitterTests(ITestOutputHelper output) => _output = output;

    [Fact]
    public void Target_name_is_asyncapi()
    {
        new AsyncApiEmitter().TargetName.ShouldBe("asyncapi");
    }

    [Fact]
    public void Emits_a_single_asyncapi_yaml_with_a_valid_3_0_header()
    {
        const string source = """
            context Sales {
              integration event OrderPlaced {
                orderId:  String
                placedAt: Instant
              }
              publishes OrderPlaced
            }
            """;

        var result = new KoineCompiler().Compile(source, new AsyncApiEmitter());

        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var file = result.Files.ShouldHaveSingleItem();
        file.RelativePath.ShouldEndWith("asyncapi.yaml");
        file.Contents.ShouldContain("asyncapi: 3.0.0");
    }

    [Fact]
    public Task Channels_and_messages_for_each_integration_event()
    {
        const string source = """
            context Sales {
              /// Announced when a customer places an order.
              integration event OrderPlaced {
                orderId: String
              }
              integration event OrderCancelled {
                orderId: String
              }
              publishes OrderPlaced
              publishes OrderCancelled
            }
            """;

        var result = new KoineCompiler().Compile(source, new AsyncApiEmitter());

        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var yaml = result.Files.ShouldHaveSingleItem().Contents;

        // One channel per event, plus a matching message under components.
        yaml.ShouldContain("channels:");
        yaml.ShouldContain("  OrderCancelled:");
        yaml.ShouldContain("  OrderPlaced:");
        yaml.ShouldContain("components:");
        yaml.ShouldContain("  messages:");
        yaml.ShouldContain("$ref: '#/components/messages/OrderPlaced'");

        return Verify(yaml).UseDirectory("Snapshots");
    }

    [Fact]
    public Task Payload_schemas_from_event_fields()
    {
        const string source = """
            context Sales {
              enum OrderStatus { Draft, Placed }
              integration event OrderPlaced {
                orderId:  OrderId
                status:   OrderStatus
                quantity: Int
              }
              publishes OrderPlaced
            }
            """;

        var result = new KoineCompiler().Compile(source, new AsyncApiEmitter());

        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var yaml = result.Files.ShouldHaveSingleItem().Contents;

        // The message references a payload schema.
        yaml.ShouldContain("$ref: '#/components/schemas/OrderPlacedPayload'");
        // The payload lists each property with the right JSON-Schema type.
        yaml.ShouldContain("  OrderPlacedPayload:");
        yaml.ShouldContain("      type: object");
        yaml.ShouldContain("quantity:");
        yaml.ShouldContain("type: integer");
        // The enum field carries an enum: list.
        yaml.ShouldContain("enum:");
        yaml.ShouldContain("- Draft");
        yaml.ShouldContain("- Placed");
        // The ID value object is a shared schema, referenced by $ref.
        yaml.ShouldContain("$ref: '#/components/schemas/OrderId'");
        yaml.ShouldContain("  OrderId:");

        return Verify(yaml).UseDirectory("Snapshots");
    }

    [Fact]
    public Task Send_and_receive_operations_from_the_context_map()
    {
        const string source = """
            context Sales {
              integration event OrderPlaced {
                orderId: String
              }
              publishes OrderPlaced
            }

            context Shipping {
              subscribes Sales.OrderPlaced
            }

            contextmap {
              Sales -> Shipping : customer-supplier
            }
            """;

        var result = new KoineCompiler().Compile(source, new AsyncApiEmitter());

        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var yaml = result.Files.ShouldHaveSingleItem().Contents;

        yaml.ShouldContain("operations:");
        // The publisher sends; the subscriber receives — both bound to the same channel.
        yaml.ShouldContain("  Sales_send_OrderPlaced:");
        yaml.ShouldContain("action: send");
        yaml.ShouldContain("  Shipping_receive_OrderPlaced:");
        yaml.ShouldContain("action: receive");
        yaml.ShouldContain("$ref: '#/channels/OrderPlaced'");

        return Verify(yaml).UseDirectory("Snapshots");
    }

    [Fact]
    public void No_integration_events_emits_a_minimal_valid_document()
    {
        // A model without any integration event still emits a valid AsyncAPI 3.0 document:
        // the info block and empty channels/operations maps, with no components section.
        const string source = """
            context Catalog {
              value Sku { code: String }
            }
            """;

        var result = new KoineCompiler().Compile(source, new AsyncApiEmitter());

        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var yaml = result.Files.ShouldHaveSingleItem().Contents;

        yaml.ShouldContain("asyncapi: 3.0.0");
        yaml.ShouldContain("info:");
        yaml.ShouldContain("channels: {}");
        yaml.ShouldContain("operations: {}");
        yaml.ShouldNotContain("components:");
    }

    [Fact]
    public void Published_but_unsubscribed_event_emits_a_send_op_and_no_receive()
    {
        // No context map and no subscriber: the channel and the publisher's send operation are
        // emitted, but there is no receive operation.
        const string source = """
            context Sales {
              integration event OrderPlaced {
                orderId: String
              }
              publishes OrderPlaced
            }
            """;

        var result = new KoineCompiler().Compile(source, new AsyncApiEmitter());

        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var yaml = result.Files.ShouldHaveSingleItem().Contents;

        yaml.ShouldContain("  OrderPlaced:");
        yaml.ShouldContain("  Sales_send_OrderPlaced:");
        yaml.ShouldContain("action: send");
        yaml.ShouldNotContain("action: receive");
    }

    [Fact]
    public Task Collection_and_map_fields_emit_correct_schemas()
    {
        const string source = """
            context Sales {
              integration event OrderPlaced {
                lineItems: List<OrderId>
                labels:    Set<String>
                metadata:  Map<String, Int>
                note:      String?
              }
              publishes OrderPlaced
            }
            """;

        var result = new KoineCompiler().Compile(source, new AsyncApiEmitter());

        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var yaml = result.Files.ShouldHaveSingleItem().Contents;

        // A list is an array; a set is an array of unique items; a map is an object keyed by its values.
        yaml.ShouldContain("type: array");
        yaml.ShouldContain("uniqueItems: true");
        yaml.ShouldContain("additionalProperties:");
        // The optional field is not required.
        yaml.ShouldNotContain("- note");

        return Verify(yaml).UseDirectory("Snapshots");
    }

    [Fact]
    public void Enum_members_that_collide_with_yaml_booleans_are_quoted()
    {
        // `On`/`Off` are YAML 1.1 booleans, so they must be quoted to round-trip as strings; a plain
        // member like `Draft` stays unquoted.
        const string source = """
            context Sales {
              enum Switch { On, Off, Draft }
              integration event Toggled {
                state: Switch
              }
              publishes Toggled
            }
            """;

        var result = new KoineCompiler().Compile(source, new AsyncApiEmitter());

        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var yaml = result.Files.ShouldHaveSingleItem().Contents;

        yaml.ShouldContain("- \"On\"");
        yaml.ShouldContain("- \"Off\"");
        yaml.ShouldContain("- Draft");
    }

    [Fact]
    public void Subscribes_without_a_context_map_still_emits_a_receive_op()
    {
        // A subscription is valid without a context map (the map only gates authorization when present),
        // so a receive operation must still be emitted for it.
        const string source = """
            context Sales {
              integration event OrderPlaced {
                orderId: String
              }
              publishes OrderPlaced
            }

            context Shipping {
              subscribes Sales.OrderPlaced
            }
            """;

        var result = new KoineCompiler().Compile(source, new AsyncApiEmitter());

        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var yaml = result.Files.ShouldHaveSingleItem().Contents;

        yaml.ShouldContain("  Shipping_receive_OrderPlaced:");
        yaml.ShouldContain("action: receive");
    }

    [Fact]
    public void Doc_summary_with_yaml_metacharacters_is_escaped()
    {
        // A doc comment carrying `:`, `"`, and `#` must be quoted/escaped so the summary stays valid YAML.
        const string source = """
            context Sales {
              /// Fires when "status: placed" — see #orders.
              integration event OrderPlaced {
                orderId: String
              }
              publishes OrderPlaced
            }
            """;

        var result = new KoineCompiler().Compile(source, new AsyncApiEmitter());

        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var yaml = result.Files.ShouldHaveSingleItem().Contents;

        // Double-quoted with the embedded quotes escaped; the colon/hash ride safely inside the quotes.
        yaml.ShouldContain("summary: \"Fires when \\\"status: placed\\\" — see #orders.\"");
    }

    [Fact]
    public void Same_named_events_in_two_contexts_are_context_qualified()
    {
        // Two contexts each declare a *different-shaped* integration event of the same name and both
        // publish it — a valid model the validator does not reject. The emitter must keep BOTH
        // contracts (no silent data loss): context-qualify the colliding name so each context gets its
        // own channel, message, and payload schema carrying its own fields.
        const string source = """
            context Sales {
              integration event OrderPlaced {
                orderId:   String
                customerId: String
              }
              publishes OrderPlaced
            }

            context Logistics {
              integration event OrderPlaced {
                shipmentId: String
                warehouse:  String
              }
              publishes OrderPlaced
            }
            """;

        var result = new KoineCompiler().Compile(source, new AsyncApiEmitter());

        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var yaml = result.Files.ShouldHaveSingleItem().Contents;

        // Two distinct, context-qualified channels — neither bare `OrderPlaced` survives on its own.
        yaml.ShouldContain("  Sales_OrderPlaced:");
        yaml.ShouldContain("  Logistics_OrderPlaced:");
        // Each context's payload schema survives with its own fields (no shape was dropped).
        yaml.ShouldContain("  Sales_OrderPlacedPayload:");
        yaml.ShouldContain("  Logistics_OrderPlacedPayload:");
        yaml.ShouldContain("customerId:");
        yaml.ShouldContain("shipmentId:");
        // Each publisher's send operation binds to its own context-qualified channel.
        yaml.ShouldContain("$ref: '#/channels/Sales_OrderPlaced'");
        yaml.ShouldContain("$ref: '#/channels/Logistics_OrderPlaced'");
    }

    [Fact]
    public void Nested_event_field_resolves_to_the_qualified_payload_under_collision()
    {
        // `Detail` collides across Sales and Logistics. Sales.OrderPlaced has a field whose type is the
        // (Sales-local) `Detail` integration event — the nested $ref must point at Sales's qualified
        // payload schema (`Sales_DetailPayload`), not a bare `DetailPayload` that no longer exists.
        const string source = """
            context Sales {
              integration event Detail {
                code: String
              }
              integration event OrderPlaced {
                detail: Detail
              }
              publishes Detail
              publishes OrderPlaced
            }

            context Logistics {
              integration event Detail {
                ref: String
              }
              publishes Detail
            }
            """;

        var result = new KoineCompiler().Compile(source, new AsyncApiEmitter());

        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var yaml = result.Files.ShouldHaveSingleItem().Contents;

        // Both contexts' Detail payloads survive, context-qualified.
        yaml.ShouldContain("  Sales_DetailPayload:");
        yaml.ShouldContain("  Logistics_DetailPayload:");
        // The nested field reference resolves to Sales's qualified payload, not a dangling bare ref.
        yaml.ShouldContain("$ref: '#/components/schemas/Sales_DetailPayload'");
    }

    [Fact]
    public void Emitted_yaml_is_valid_per_the_asyncapi_cli_when_enabled()
    {
        // External conformance: gated behind KOINE_ASYNCAPI_VALIDATE so the suite stays hermetic.
        // When the flag is unset (CI default) the conformance is INCONCLUSIVE and skipped; when set,
        // the emitted document must pass `asyncapi validate`.
        if (Environment.GetEnvironmentVariable("KOINE_ASYNCAPI_VALIDATE") is not { Length: > 0 })
        {
            _output.WriteLine("KOINE_ASYNCAPI_VALIDATE not set — AsyncAPI CLI conformance is INCONCLUSIVE (skipped).");
            return;
        }

        const string source = """
            context Sales {
              enum OrderStatus { Draft, Placed }
              integration event OrderPlaced {
                orderId:  OrderId
                status:   OrderStatus
                total:    Decimal
                placedAt: Instant
              }
              publishes OrderPlaced
            }

            context Shipping {
              subscribes Sales.OrderPlaced
            }

            contextmap {
              Sales -> Shipping : customer-supplier
            }
            """;

        var result = new KoineCompiler().Compile(source, new AsyncApiEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var yaml = result.Files.ShouldHaveSingleItem().Contents;

        var check = TestSupport.ValidateAsyncApi(yaml);
        if (!check.ToolchainAvailable)
        {
            _output.WriteLine("AsyncAPI CLI not found on PATH; conformance INCONCLUSIVE (skipped).");
            return;
        }

        check.Ok.ShouldBeTrue("AsyncAPI CLI rejected the emitted document:\n" + string.Join("\n", check.Errors));
    }
}
