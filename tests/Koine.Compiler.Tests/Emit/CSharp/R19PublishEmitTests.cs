using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Epic R19 — C# emission of the <c>publish &lt;IntegrationEvent&gt;(field: expr, …)</c> command
/// clause. The aggregate ROOT records a published integration event in a dedicated
/// <c>_integrationEvents</c> list, parallel to (and strictly separate from) the <c>_domainEvents</c>
/// list <c>emit</c> feeds: a domain event is intra-aggregate (<c>IDomainEvent</c>), an integration
/// event is a published-language contract leaving the context (<c>IIntegrationEvent</c>).
/// <para>The outbox path that CLOSES on that list is covered here too: a publishing context's
/// <c>IUnitOfWork</c> declares the <c>Enqueue</c> seam, and the emitted command handler relays the
/// root's <c>IntegrationEvents</c> into it BEFORE the commit, so the outbox rows persist in the same
/// transaction as the aggregate change.</para>
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

    /// <summary>
    /// A context that publishes NOTHING at all — the negative control for the <c>IUnitOfWork</c>
    /// enqueue seam, which is gated on the context's published language, not on a single root.
    /// </summary>
    private const string NoPublishesFixture = """
        context Warehouse {
          aggregate Stocking root Stock {
            entity Stock identified by StockId {
              quantity: Int
              command receive(amount: Int) {
                quantity -> quantity + amount
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

    /// <summary>
    /// The same emit with the Application + Infrastructure layers switched on, so the contract
    /// (<c>IUnitOfWork</c>), its realization (<c>UnitOfWork</c>) and its consumer (the handler) are all
    /// in one output — the only shape in which a signature drift between them can be caught.
    /// </summary>
    private static IReadOnlyList<EmittedFile> EmitFullStack(string source)
    {
        var options = new CSharpEmitterOptions(
            new Dictionary<string, string>(StringComparer.Ordinal),
            Layers: new HashSet<CSharpLayer> { CSharpLayer.Domain, CSharpLayer.Application, CSharpLayer.Infrastructure });
        var result = new KoineCompiler().Compile(source, new CSharpEmitter(options));
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files;
    }

    private static string File(IReadOnlyList<EmittedFile> files, string relativePath) =>
        files.Single(f => f.RelativePath == relativePath).Contents;

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

    // ---- the outbox seam on the abstraction ----------------------------------

    [Fact]
    public void Publishing_context_declares_the_enqueue_seam_on_the_unit_of_work()
    {
        var uow = File(EmitFullStack(PublishFixture), "Sales/Abstractions/IUnitOfWork.cs");

        // Same member the concrete UnitOfWork realizes, spelled identically.
        uow.ShouldContain("void Enqueue(IIntegrationEvent integrationEvent);");
        File(EmitFullStack(PublishFixture), "Sales/Infrastructure/UnitOfWork.cs")
            .ShouldContain("public void Enqueue(IIntegrationEvent integrationEvent)");
    }

    [Fact]
    public void Non_publishing_context_has_no_enqueue_on_the_unit_of_work()
    {
        var uow = File(EmitFullStack(NoPublishesFixture), "Warehouse/Abstractions/IUnitOfWork.cs");

        uow.ShouldNotContain("Enqueue");
        uow.ShouldContain("Task<int> SaveChangesAsync(CancellationToken ct = default);");
    }

    // ---- the relay in the command handler ------------------------------------

    [Fact]
    public void Handler_relays_the_published_events_to_the_unit_of_work()
    {
        var handler = File(EmitFullStack(PublishFixture), "Sales/Application/OrderConfirmHandler.cs");

        handler.ShouldContain("foreach (var integrationEvent in aggregate.IntegrationEvents)");
        handler.ShouldContain("_unitOfWork.Enqueue(integrationEvent);");
        handler.ShouldContain("aggregate.ClearIntegrationEvents();");
    }

    [Fact]
    public void Relay_happens_before_the_commit_so_the_outbox_rides_the_transaction()
    {
        var handler = File(EmitFullStack(PublishFixture), "Sales/Application/OrderConfirmHandler.cs");

        var relay = handler.IndexOf("_unitOfWork.Enqueue(integrationEvent);", StringComparison.Ordinal);
        var clear = handler.IndexOf("aggregate.ClearIntegrationEvents();", StringComparison.Ordinal);
        var commit = handler.IndexOf("await _unitOfWork.SaveChangesAsync(ct);", StringComparison.Ordinal);

        relay.ShouldBeGreaterThan(-1);
        commit.ShouldBeGreaterThan(-1);
        // Enqueue → clear → commit: the outbox rows are queued (and the aggregate emptied) while the
        // unit of work is still open, so SaveChangesAsync writes them in the same transaction.
        clear.ShouldBeGreaterThan(relay);
        commit.ShouldBeGreaterThan(clear);
    }

    [Fact]
    public void Handler_for_a_non_publishing_root_has_no_relay()
    {
        // Sales still publishes OrderPlaced (so IUnitOfWork keeps Enqueue), but this root never
        // `publish`es — it has no IntegrationEvents member, so the handler must not reach for one.
        var handler = File(EmitFullStack(NoPublishFixture), "Sales/Application/OrderConfirmHandler.cs");

        File(EmitFullStack(NoPublishFixture), "Sales/Abstractions/IUnitOfWork.cs")
            .ShouldContain("void Enqueue(IIntegrationEvent integrationEvent);");
        handler.ShouldNotContain("IntegrationEvents");
        handler.ShouldNotContain("Enqueue");
    }

    // ---- the collision this feature introduces --------------------------------

    [Fact]
    public void Factory_colliding_with_the_integration_event_api_is_reported()
    {
        // `create integrationEvents` would emit a second `IntegrationEvents` member on a publishing
        // root (CS0102/CS0111); it must be a diagnostic, not broken generated C#.
        const string src = """
            context Sales {
              publishes OrderPlaced
              integration event OrderPlaced { orderId: OrderId }

              aggregate Ordering root Order {
                entity Order identified by OrderId {
                  total: Decimal
                  create integrationEvents(total: Decimal) { total -> total }
                  command confirm {
                    publish OrderPlaced(orderId: id)
                  }
                }
              }
            }
            """;

        new KoineCompiler().Diagnose(src)
            .ShouldContain(d => d.Code == DiagnosticCodes.FactoryNameCollision);
    }

    [Fact]
    public void Factory_colliding_with_the_integration_event_clear_is_reported()
    {
        const string src = """
            context Sales {
              publishes OrderPlaced
              integration event OrderPlaced { orderId: OrderId }

              aggregate Ordering root Order {
                entity Order identified by OrderId {
                  total: Decimal
                  create clearIntegrationEvents(total: Decimal) { total -> total }
                  command confirm {
                    publish OrderPlaced(orderId: id)
                  }
                }
              }
            }
            """;

        new KoineCompiler().Diagnose(src)
            .ShouldContain(d => d.Code == DiagnosticCodes.FactoryNameCollision);
    }

    // ---- the load-bearing check: it actually compiles -------------------------

    [Fact]
    public void Emitted_publish_output_compiles()
    {
        var (assembly, errors) = TestSupport.Compile(Emit(PublishFixture));

        errors.ShouldBeEmpty("generated C# failed to compile:\n" + string.Join("\n", errors));
        assembly.ShouldNotBeNull();
    }

    /// <summary>
    /// The load-bearing check for the outbox path: the domain, the application handler and the EF Core
    /// infrastructure compile TOGETHER. The handler now calls an interface method, so a drift between
    /// <c>IUnitOfWork.Enqueue</c> and <c>UnitOfWork.Enqueue</c> surfaces only here.
    /// </summary>
    [Fact]
    public void Emitted_publish_outbox_path_compiles_end_to_end()
    {
        var (assembly, errors) = TestSupport.Compile(EmitFullStack(PublishFixture));

        errors.ShouldBeEmpty("generated C# failed to compile:\n" + string.Join("\n", errors));
        assembly.ShouldNotBeNull();
    }
}
