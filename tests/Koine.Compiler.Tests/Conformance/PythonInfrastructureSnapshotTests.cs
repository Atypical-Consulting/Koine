using Koine.Compiler.Emit;
using Koine.Compiler.Emit.Python;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Snapshot + behavioral coverage for the Python Infrastructure layer (issue #241): concrete repository
/// implementations over an in-memory <c>AggregateStore</c>, a concrete unit of work, and (for a
/// publishing context) a transactional outbox + dispatcher, validation/transaction behaviors and a
/// provider/composition helper. The Verify snapshots lock the per-context infrastructure modules; the
/// explicit assertions pin the gate, determinism, and the key shapes independently of the exact bytes.
/// </summary>
public class PythonInfrastructureSnapshotTests
{
    /// <summary>Two aggregates in one context; Order carries a finder so the lowering is exercised.</summary>
    internal const string Fixture = """
        context Sales {

          aggregate Order root Order {
            repository {
              find byCustomer(customer: CustomerId): List<Order>
            }
            entity Order identified by OrderId {
              total: Int
              customer: CustomerId
            }
          }

          aggregate Customer root Customer {
            entity Customer identified by CustomerId {
              name: String
            }
          }
        }
        """;

    /// <summary>A context with no aggregate whose root is an entity emits no infrastructure.</summary>
    private const string NoAggregateFixture = """
        context Catalog {
          value Money {
            amount: Decimal
          }
        }
        """;

    /// <summary>A publishing context with an aggregate — so the outbox dispatcher + enqueue are emitted.</summary>
    internal const string PublishingFixture = """
        context Ordering {
          integration event OrderPlaced {
            orderId: String
            total:   Decimal
          }

          publishes OrderPlaced

          aggregate Order root Order {
            entity Order identified by OrderId {
              total: Int
            }
          }
        }
        """;

    internal static readonly PythonEmitterOptions InfraOptions = PythonEmitterOptions.Empty with
    {
        Layers = new HashSet<PythonLayer> { PythonLayer.Domain, PythonLayer.Infrastructure },
    };

    private static IReadOnlyList<EmittedFile> Emit(string source) =>
        new KoineCompiler().Compile(source, new PythonEmitter(InfraOptions)).Files;

    /// <summary>The per-context repository impls + unit of work must match the snapshot.</summary>
    [Fact]
    public Task Python_infrastructure_repository_and_unit_of_work_emit_expected_python()
    {
        var result = new KoineCompiler().Compile(Fixture, new PythonEmitter(InfraOptions));
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var infraFiles = result.Files
            .Where(f => f.RelativePath.Contains("/infrastructure/", StringComparison.Ordinal)
                && (f.RelativePath.EndsWith("_repository_impl.py", StringComparison.Ordinal)
                    || f.RelativePath.EndsWith("unit_of_work.py", StringComparison.Ordinal)))
            .ToList();

        return Verify(TestSupport.Render(infraFiles))
            .UseDirectory("Snapshots");
    }

    /// <summary>The concrete repository implements the protocol over the in-memory store seam.</summary>
    [Fact]
    public void Repository_impl_implements_the_protocol_over_the_store()
    {
        var repo = Emit(Fixture).Single(f => f.RelativePath == "sales/infrastructure/order_repository_impl.py").Contents;

        repo.ShouldContain("class OrderRepositoryImpl(OrderRepository):");
        repo.ShouldContain("InMemoryStore[OrderId, Order](lambda entity: entity.id)");
        repo.ShouldContain("async def get(self, id: OrderId) -> Order | None:");
        // The declarative finder lowers to a concrete in-memory query keyed on the matching root property.
        repo.ShouldContain("async def by_customer(self, customer: CustomerId) -> tuple[Order, ...]:");
        repo.ShouldContain("return tuple(entity for entity in items if entity.customer == customer)");
    }

    /// <summary>The concrete unit of work realizes the contract, defaulting each repository attribute.</summary>
    [Fact]
    public void Unit_of_work_impl_wires_each_repository()
    {
        var uow = Emit(Fixture).Single(f => f.RelativePath == "sales/infrastructure/unit_of_work.py").Contents;

        uow.ShouldContain("class UnitOfWork:");
        uow.ShouldContain("self.orders = orders if orders is not None else OrderRepositoryImpl()");
        uow.ShouldContain("self.customers = customers if customers is not None else CustomerRepositoryImpl()");
        uow.ShouldContain("async def save_changes(self) -> None:");
    }

    /// <summary>The per-context outbox dispatcher + publishing unit of work must match the snapshot.</summary>
    [Fact]
    public Task Python_infrastructure_outbox_dispatcher_emits_expected_python()
    {
        var result = new KoineCompiler().Compile(PublishingFixture, new PythonEmitter(InfraOptions));
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var infraFiles = result.Files
            .Where(f => f.RelativePath.Contains("/infrastructure/", StringComparison.Ordinal)
                && (f.RelativePath.EndsWith("integration_event_dispatcher.py", StringComparison.Ordinal)
                    || f.RelativePath.EndsWith("unit_of_work.py", StringComparison.Ordinal)))
            .ToList();

        return Verify(TestSupport.Render(infraFiles))
            .UseDirectory("Snapshots");
    }

    /// <summary>A publishing context emits the dispatcher and a unit of work that enqueues to the outbox.</summary>
    [Fact]
    public void Publishing_context_emits_outbox_dispatcher_and_enqueue()
    {
        var files = Emit(PublishingFixture);

        var dispatcher = files.Single(f => f.RelativePath == "ordering/infrastructure/integration_event_dispatcher.py").Contents;
        dispatcher.ShouldContain("class IntegrationEventDispatcher:");
        dispatcher.ShouldContain("for message in await self._outbox.unprocessed():");
        dispatcher.ShouldContain("await self._handler.handle(message)");

        var uow = files.Single(f => f.RelativePath == "ordering/infrastructure/unit_of_work.py").Contents;
        uow.ShouldContain("def enqueue(self, integration_event: object) -> None:");
        uow.ShouldContain("await self._outbox.add(OutboxMessage.of(integration_event))");
    }

    /// <summary>A subscribe-only / event-free context emits no outbox dispatcher.</summary>
    [Fact]
    public void Non_publishing_context_emits_no_dispatcher()
    {
        Emit(Fixture).ShouldNotContain(f => f.RelativePath.EndsWith("integration_event_dispatcher.py", StringComparison.Ordinal));
    }

    /// <summary>The pipeline behaviors + provider factory must match the snapshot.</summary>
    [Fact]
    public Task Python_infrastructure_behaviors_and_provider_emit_expected_python()
    {
        var result = new KoineCompiler().Compile(Fixture, new PythonEmitter(InfraOptions));
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var infraFiles = result.Files
            .Where(f => f.RelativePath.Contains("/infrastructure/", StringComparison.Ordinal)
                && (f.RelativePath.EndsWith("behaviors.py", StringComparison.Ordinal)
                    || f.RelativePath.EndsWith("_infrastructure.py", StringComparison.Ordinal)))
            .ToList();

        return Verify(TestSupport.Render(infraFiles))
            .UseDirectory("Snapshots");
    }

    /// <summary>The behaviors are emitted as validation + transaction pipeline-behavior factories.</summary>
    [Fact]
    public void Behaviors_are_emitted_as_validation_and_transaction_factories()
    {
        var behaviors = Emit(Fixture).Single(f => f.RelativePath == "sales/infrastructure/behaviors.py").Contents;

        behaviors.ShouldContain("def validation_behavior(");
        behaviors.ShouldContain("raise ValidationError(errors)");
        behaviors.ShouldContain("def transaction_behavior(");
        behaviors.ShouldContain("await unit_of_work.save_changes()");
    }

    /// <summary>The provider assembles repositories, the unit of work and the behaviors.</summary>
    [Fact]
    public void Provider_assembles_the_infrastructure()
    {
        var provider = Emit(Fixture).Single(f => f.RelativePath == "sales/infrastructure/sales_infrastructure.py").Contents;

        provider.ShouldContain("def create_sales_infrastructure() -> SalesInfrastructure:");
        provider.ShouldContain("unit_of_work = UnitOfWork(orders, customers)");
        provider.ShouldContain("validation_behavior(),");
        provider.ShouldContain("transaction_behavior(unit_of_work),");
    }

    /// <summary>A publishing context's provider wires the outbox dispatcher and takes a handler.</summary>
    [Fact]
    public void Publishing_provider_wires_the_dispatcher()
    {
        var provider = Emit(PublishingFixture).Single(f => f.RelativePath == "ordering/infrastructure/ordering_infrastructure.py").Contents;

        provider.ShouldContain("def create_ordering_infrastructure(handler: IntegrationEventHandler) -> OrderingInfrastructure:");
        provider.ShouldContain("dispatcher = IntegrationEventDispatcher(outbox, handler)");
        provider.ShouldContain("dispatcher: IntegrationEventDispatcher");
    }

    /// <summary>The shared infrastructure-runtime module is emitted once at the output root.</summary>
    [Fact]
    public void Shared_infrastructure_runtime_is_emitted_once()
    {
        Emit(Fixture).Count(f => f.RelativePath == "koine_infrastructure.py").ShouldBe(1);
    }

    /// <summary>A context with no entity-rooted aggregate emits no infrastructure (no error).</summary>
    [Fact]
    public void No_entity_rooted_aggregate_emits_no_infrastructure()
    {
        Emit(NoAggregateFixture).ShouldNotContain(f => f.RelativePath.Contains("infrastructure", StringComparison.Ordinal));
    }

    /// <summary>The infrastructure emit is deterministic — two runs are byte-identical.</summary>
    [Fact]
    public void Infrastructure_emit_is_deterministic()
    {
        TestSupport.Render(Emit(Fixture)).ShouldBe(TestSupport.Render(Emit(Fixture)));
    }
}
