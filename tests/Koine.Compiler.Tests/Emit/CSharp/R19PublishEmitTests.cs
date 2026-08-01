using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Epic R19 — C# emission of the <c>publish &lt;IntegrationEvent&gt;(field: expr, …)</c> command
/// clause. The aggregate ROOT records a published integration event in a dedicated
/// <c>_integrationEvents</c> list, parallel to (and strictly separate from) the <c>_domainEvents</c>
/// list <c>emit</c> feeds: a domain event is intra-aggregate (<c>IDomainEvent</c>), an integration
/// event is a published-language contract leaving the context (<c>IIntegrationEvent</c>). Relaying
/// that list to the outbox is a separate concern and is NOT covered here.
/// </summary>
public class R19PublishEmitTests
{
    /// <summary>
    /// A root whose single command BOTH emits a domain event and publishes an integration event, so
    /// the two recordings must coexist and land in different lists.
    /// </summary>
    private const string PublishFixture = """
        context Sales {
          publishes OrderPlaced
          integration event OrderPlaced { orderId: OrderId  total: Decimal }
          event OrderConfirmed { orderId: OrderId }

          aggregate Ordering root Order {
            entity Order identified by OrderId {
              total: Decimal
              confirmed: Bool = false
              command confirm {
                confirmed -> true
                emit OrderConfirmed(orderId: id)
                publish OrderPlaced(orderId: id, total: total)
              }
            }
          }
        }
        """;

    /// <summary>The same shape MINUS the <c>publish</c> — the negative control for the gate.</summary>
    private const string NoPublishFixture = """
        context Sales {
          publishes OrderPlaced
          integration event OrderPlaced { orderId: OrderId  total: Decimal }
          event OrderConfirmed { orderId: OrderId }

          aggregate Ordering root Order {
            entity Order identified by OrderId {
              total: Decimal
              confirmed: Bool = false
              command confirm {
                confirmed -> true
                emit OrderConfirmed(orderId: id)
              }
            }
          }
        }
        """;

    private static IReadOnlyList<EmittedFile> Emit(string source)
    {
        var result = new KoineCompiler().Compile(source, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files;
    }

    private static string RootSource(string source) =>
        Emit(source).Single(f => f.RelativePath.EndsWith("/Order.cs", StringComparison.Ordinal)).Contents;

    // ---- the root's integration-event recording surface ----------------------

    [Fact]
    public void Root_declares_a_separate_integration_event_list()
    {
        var order = RootSource(PublishFixture);

        order.ShouldContain("private readonly List<IIntegrationEvent> _integrationEvents");
        order.ShouldContain("public IReadOnlyList<IIntegrationEvent> IntegrationEvents");
        order.ShouldContain("ClearIntegrationEvents");
    }

    [Fact]
    public void Integration_event_list_mirrors_the_domain_event_block_shape()
    {
        var order = RootSource(PublishFixture);

        // Read-only exposure + an explicit clear, exactly as the domain-event block does.
        order.ShouldContain("public IReadOnlyList<IIntegrationEvent> IntegrationEvents\n        => _integrationEvents;");
        order.ShouldContain("public void ClearIntegrationEvents()\n        => _integrationEvents.Clear();");
    }

    [Fact]
    public void Publish_records_the_integration_event_in_the_command_body()
    {
        var order = RootSource(PublishFixture);

        order.ShouldContain("_integrationEvents.Add(new OrderPlaced(Id, Total));");
    }

    [Fact]
    public void Emit_still_records_into_the_domain_event_list_unchanged()
    {
        var order = RootSource(PublishFixture);

        order.ShouldContain("private readonly List<IDomainEvent> _domainEvents = new();");
        order.ShouldContain("_domainEvents.Add(new OrderConfirmed(Id));");
    }

    [Fact]
    public void Domain_events_are_recorded_before_the_published_ones()
    {
        var order = RootSource(PublishFixture);

        var domain = order.IndexOf("_domainEvents.Add(new OrderConfirmed", StringComparison.Ordinal);
        var published = order.IndexOf("_integrationEvents.Add(new OrderPlaced", StringComparison.Ordinal);

        domain.ShouldBeGreaterThan(-1);
        published.ShouldBeGreaterThan(domain);
    }

    [Fact]
    public void Integration_events_do_not_leak_into_the_domain_event_list()
    {
        var order = RootSource(PublishFixture);

        order.ShouldNotContain("_domainEvents.Add(new OrderPlaced(");
        // The two marker interfaces stay distinct: the record itself is never an IDomainEvent.
        Emit(PublishFixture)
            .Single(f => f.RelativePath.EndsWith("/OrderPlaced.cs", StringComparison.Ordinal))
            .Contents
            .ShouldContain("public sealed record OrderPlaced : IIntegrationEvent");
    }

    // ---- the negative control: no publish ⇒ no member at all -----------------

    [Fact]
    public void A_model_without_publish_emits_no_integration_event_member()
    {
        var order = RootSource(NoPublishFixture);

        order.ShouldNotContain("_integrationEvents");
        order.ShouldNotContain("IntegrationEvents");
        order.ShouldContain("private readonly List<IDomainEvent> _domainEvents = new();");
    }

    // ---- the load-bearing check: it actually compiles -------------------------

    [Fact]
    public void Emitted_publish_output_compiles()
    {
        var (assembly, errors) = TestSupport.Compile(Emit(PublishFixture));

        errors.ShouldBeEmpty("generated C# failed to compile:\n" + string.Join("\n", errors));
        assembly.ShouldNotBeNull();
    }
}
