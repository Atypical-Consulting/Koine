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

    // ---- the __result hoist: `emit` and `publish` must see ONE value ---------

    /// <summary>
    /// A command whose result is NON-DETERMINISTIC (<c>now</c> → <c>DateTimeOffset.UtcNow</c>) and
    /// whose value is carried by BOTH an <c>emit</c> and a <c>publish</c>. Rendering the publish
    /// argument inline would read the clock a second time, so the domain event and the published
    /// contract it is meant to mirror would carry two different instants for one execution.
    /// </summary>
    private const string HoistFixture = """
        context Sales {
          publishes OrderClosed
          integration event OrderClosed { orderId: OrderId  at: Instant }
          event OrderClosedInternally { orderId: OrderId  at: Instant }

          aggregate Ordering root Order {
            entity Order identified by OrderId {
              closedAt: Instant?
              command close: Instant {
                closedAt -> now
                emit OrderClosedInternally(orderId: id, at: now)
                publish OrderClosed(orderId: id, at: now)
                result now
              }
            }
          }
        }
        """;

    /// <summary>The same command with the <c>emit</c> removed: the hoist must not need one.</summary>
    private const string PublishOnlyHoistFixture = """
        context Sales {
          publishes OrderClosed
          integration event OrderClosed { orderId: OrderId  at: Instant }

          aggregate Ordering root Order {
            entity Order identified by OrderId {
              closedAt: Instant?
              command close: Instant {
                publish OrderClosed(orderId: id, at: now)
                result now
              }
            }
          }
        }
        """;

    [Fact]
    public void Publish_and_emit_of_the_same_expression_share_one_hoisted_local()
    {
        var order = RootSource(HoistFixture);

        order.ShouldContain("var __result = DateTimeOffset.UtcNow;");
        order.ShouldContain("_domainEvents.Add(new OrderClosedInternally(Id, __result));");
        order.ShouldContain("_integrationEvents.Add(new OrderClosed(Id, __result));");
    }

    [Fact]
    public void Publish_does_not_re_read_a_non_deterministic_result_expression()
    {
        var order = RootSource(HoistFixture);

        // The exact shape of the bug: a SECOND `DateTimeOffset.UtcNow` inside the publish, which
        // would make OrderClosedInternally.At and OrderClosed.At disagree for one command run.
        order.ShouldNotContain("_integrationEvents.Add(new OrderClosed(Id, DateTimeOffset.UtcNow));");
    }

    [Fact]
    public void A_publish_only_command_still_hoists_its_result()
    {
        // The hoist is not keyed on there being an `emit`: a lone `publish` of the returned value
        // must read it once too.
        var order = RootSource(PublishOnlyHoistFixture);

        order.ShouldContain("var __result = DateTimeOffset.UtcNow;");
        order.ShouldContain("_integrationEvents.Add(new OrderClosed(Id, __result));");
        order.ShouldContain("return __result;");
    }

    // ---- the load-bearing check: it actually compiles -------------------------

    [Fact]
    public void Emitted_hoisted_publish_output_compiles()
    {
        var (assembly, errors) = TestSupport.Compile(Emit(HoistFixture));

        errors.ShouldBeEmpty("generated C# failed to compile:\n" + string.Join("\n", errors));
        assembly.ShouldNotBeNull();
    }

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

    // ---- cross-context resolution (the same-named integration event) ----------

    /// <summary>
    /// Two contexts that each legitimately publish a SAME-NAMED integration event with a DIFFERENT
    /// payload — the shape <c>R14IntegrationEventsTests.SameNameCrossPublisher</c> already blesses,
    /// here with each publisher actually running a <c>publish</c>.
    /// <para><c>ValidatePublish</c> resolves the name context-aware, so it checks Alpha's payload
    /// against Alpha's declaration. The emitter used to resolve it through the FLAT, last-write-wins
    /// <c>ModelIndex</c> view, so it built the constructor call from whichever declaration was indexed
    /// last: this model validated with ZERO diagnostics and emitted
    /// <c>new Shipped(default!, default!)</c> into <c>Alpha.Order</c> — CS1729 against Alpha's
    /// one-argument <c>Shipped</c>, with <c>orderId: code</c> dropped. It was also source-order
    /// dependent, so reordering the two contexts silently moved the breakage to the other one.</para>
    /// </summary>
    private const string CrossContextSameNameFixture = """
        context Alpha version 1 {
          publishes Shipped
          integration event Shipped { orderId: String }

          aggregate Sales root Order {
            entity Order identified by OrderId {
              code: String
              command ship { publish Shipped(orderId: code) }
            }
          }
        }
        context Beta version 1 {
          publishes Shipped
          integration event Shipped { trackingCode: String  carrier: String }

          aggregate Freight root Consignment {
            entity Consignment identified by ConsignmentId {
              label: String
              hauler: String
              command dispatch { publish Shipped(trackingCode: label, carrier: hauler) }
            }
          }
        }
        """;

    /// <summary>
    /// The SAME model with the two contexts written in the other order. The emitted publish statements
    /// must be byte-identical to <see cref="CrossContextSameNameFixture"/>'s — resolution keyed on the
    /// enclosing context, never on which declaration the flat index happened to see last.
    /// </summary>
    private const string CrossContextSameNameReorderedFixture = """
        context Beta version 1 {
          publishes Shipped
          integration event Shipped { trackingCode: String  carrier: String }

          aggregate Freight root Consignment {
            entity Consignment identified by ConsignmentId {
              label: String
              hauler: String
              command dispatch { publish Shipped(trackingCode: label, carrier: hauler) }
            }
          }
        }
        context Alpha version 1 {
          publishes Shipped
          integration event Shipped { orderId: String }

          aggregate Sales root Order {
            entity Order identified by OrderId {
              code: String
              command ship { publish Shipped(orderId: code) }
            }
          }
        }
        """;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Publish_resolves_a_same_named_integration_event_in_its_own_context(bool reordered)
    {
        var files = Emit(reordered ? CrossContextSameNameReorderedFixture : CrossContextSameNameFixture);

        // Each root constructs ITS OWN context's Shipped, with the payload the validator checked.
        File(files, "Alpha/Order.cs").ShouldContain("_integrationEvents.Add(new Shipped(Code));");
        File(files, "Beta/Consignment.cs").ShouldContain("_integrationEvents.Add(new Shipped(Label, Hauler));");

        // The exact shape of the bug: the other context's arity, with every argument dropped.
        File(files, "Alpha/Order.cs").ShouldNotContain("default!");
        File(files, "Beta/Consignment.cs").ShouldNotContain("default!");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Emitted_cross_context_publish_output_compiles(bool reordered)
    {
        // The load-bearing half: a wrong-context resolution yields a wrong-arity constructor call
        // (CS1729), which only a real compile catches.
        var (assembly, errors) =
            TestSupport.Compile(Emit(reordered ? CrossContextSameNameReorderedFixture : CrossContextSameNameFixture));

        errors.ShouldBeEmpty("generated C# failed to compile:\n" + string.Join("\n", errors));
        assembly.ShouldNotBeNull();
    }
}
