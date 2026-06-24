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
