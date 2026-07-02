using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Snapshot + behavioral coverage for the TypeScript Infrastructure layer (issue #241): concrete
/// repositories over an in-memory <c>AggregateStore</c>, a concrete unit of work, and (for a publishing
/// context) a transactional outbox + dispatcher, validation/transaction behaviors and a composition-root
/// factory. The Verify snapshot locks the per-context infrastructure files for a two-aggregate context
/// (one carrying a declarative finder → a concrete in-memory query); the explicit assertions pin the
/// gate, determinism, and the key shapes independently of the exact bytes.
/// </summary>
public class TypeScriptInfrastructureSnapshotTests
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

    internal static readonly TsEmitterOptions InfraOptions = new()
    {
        Layers = new HashSet<TsLayer> { TsLayer.Domain, TsLayer.Infrastructure },
    };

    private static IReadOnlyList<EmittedFile> Emit(string source) =>
        new KoineCompiler().Compile(source, new TypeScriptEmitter(InfraOptions)).Files;

    /// <summary>The per-context infrastructure files (repository + unit of work) must match the snapshot.</summary>
    [Fact]
    public Task TypeScript_infrastructure_repository_and_unit_of_work_emit_expected_typescript()
    {
        var result = new KoineCompiler().Compile(Fixture, new TypeScriptEmitter(InfraOptions));
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var infraFiles = result.Files
            .Where(f => f.RelativePath.Contains("/infrastructure/", StringComparison.Ordinal)
                && (f.RelativePath.EndsWith("Repository.ts", StringComparison.Ordinal)
                    || f.RelativePath.EndsWith("UnitOfWork.ts", StringComparison.Ordinal)))
            .ToList();

        return Verify(TestSupport.Render(infraFiles))
            .UseDirectory("Snapshots");
    }

    /// <summary>The concrete repository implements the emitted interface over the in-memory store seam.</summary>
    [Fact]
    public void Repository_impl_implements_the_contract_over_the_store()
    {
        var repo = Emit(Fixture).Single(f => f.RelativePath == "Sales/infrastructure/OrderRepository.ts").Contents;

        repo.ShouldContain("export class OrderRepository implements IOrderRepository");
        repo.ShouldContain("AggregateStore<OrderId, Order> = new InMemoryStore<OrderId, Order>((entity) => entity.id)");
        repo.ShouldContain("getById(id: OrderId): Promise<Order | undefined>");
        // The declarative finder lowers to a concrete in-memory query keyed on the matching root property.
        repo.ShouldContain("async byCustomer(customer: CustomerId): Promise<readonly Order[]>");
        repo.ShouldContain("return all.filter((entity) => structuralEquals(entity.customer, customer));");
    }

    /// <summary>The concrete unit of work realizes the contract, defaulting each repository property.</summary>
    [Fact]
    public void Unit_of_work_impl_wires_each_repository()
    {
        var uow = Emit(Fixture).Single(f => f.RelativePath == "Sales/infrastructure/UnitOfWork.ts").Contents;

        uow.ShouldContain("export class UnitOfWork implements IUnitOfWork");
        uow.ShouldContain("readonly orders: IOrderRepository = new OrderRepository()");
        uow.ShouldContain("readonly customers: ICustomerRepository = new CustomerRepository()");
        uow.ShouldContain("saveChangesAsync(): Promise<void>");
    }

    /// <summary>The per-context outbox dispatcher (publishing context only) must match the snapshot.</summary>
    [Fact]
    public Task TypeScript_infrastructure_outbox_dispatcher_emits_expected_typescript()
    {
        var result = new KoineCompiler().Compile(PublishingFixture, new TypeScriptEmitter(InfraOptions));
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var infraFiles = result.Files
            .Where(f => f.RelativePath.Contains("/infrastructure/", StringComparison.Ordinal)
                && (f.RelativePath.EndsWith("IntegrationEventDispatcher.ts", StringComparison.Ordinal)
                    || f.RelativePath.EndsWith("UnitOfWork.ts", StringComparison.Ordinal)))
            .ToList();

        return Verify(TestSupport.Render(infraFiles))
            .UseDirectory("Snapshots");
    }

    /// <summary>A publishing context emits the dispatcher and a unit of work that enqueues to the outbox.</summary>
    [Fact]
    public void Publishing_context_emits_outbox_dispatcher_and_enqueue()
    {
        var files = Emit(PublishingFixture);

        var dispatcher = files.Single(f => f.RelativePath == "Ordering/infrastructure/IntegrationEventDispatcher.ts").Contents;
        dispatcher.ShouldContain("export class IntegrationEventDispatcher");
        dispatcher.ShouldContain("const pending = await this.outbox.unprocessed();");
        dispatcher.ShouldContain("await this.handler.handle(message);");

        var uow = files.Single(f => f.RelativePath == "Ordering/infrastructure/UnitOfWork.ts").Contents;
        uow.ShouldContain("enqueue(integrationEvent: object): void");
        uow.ShouldContain("await this.outbox.add(OutboxMessage.from(integrationEvent));");
    }

    /// <summary>A subscribe-only / event-free context emits no outbox dispatcher.</summary>
    [Fact]
    public void Non_publishing_context_emits_no_dispatcher()
    {
        Emit(Fixture).ShouldNotContain(f => f.RelativePath.EndsWith("IntegrationEventDispatcher.ts", StringComparison.Ordinal));
    }

    /// <summary>The pipeline behaviors + composition-root factory must match the snapshot.</summary>
    [Fact]
    public Task TypeScript_infrastructure_behaviors_and_composition_root_emit_expected_typescript()
    {
        var result = new KoineCompiler().Compile(Fixture, new TypeScriptEmitter(InfraOptions));
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var infraFiles = result.Files
            .Where(f => f.RelativePath.Contains("/infrastructure/", StringComparison.Ordinal)
                && (f.RelativePath.EndsWith("Behaviors.ts", StringComparison.Ordinal)
                    || f.RelativePath.EndsWith("Infrastructure.ts", StringComparison.Ordinal)))
            .ToList();

        return Verify(TestSupport.Render(infraFiles))
            .UseDirectory("Snapshots");
    }

    /// <summary>The behaviors are emitted as validation + transaction pipeline-behavior factories.</summary>
    [Fact]
    public void Behaviors_are_emitted_as_validation_and_transaction_factories()
    {
        var behaviors = Emit(Fixture).Single(f => f.RelativePath == "Sales/infrastructure/Behaviors.ts").Contents;

        behaviors.ShouldContain("export function validationBehavior<TRequest, TResponse>(");
        behaviors.ShouldContain("return Promise.reject(new ValidationError(errors));");
        behaviors.ShouldContain("export function transactionBehavior<TRequest, TResponse>(");
        behaviors.ShouldContain("next().then((response) => unitOfWork.saveChangesAsync().then(() => response));");
    }

    /// <summary>The composition root assembles repositories, the unit of work and the behaviors.</summary>
    [Fact]
    public void Composition_root_assembles_the_infrastructure()
    {
        var root = Emit(Fixture).Single(f => f.RelativePath == "Sales/infrastructure/SalesInfrastructure.ts").Contents;

        root.ShouldContain("export function createSalesInfrastructure(): SalesInfrastructure");
        root.ShouldContain("const unitOfWork = new UnitOfWork(orders, customers);");
        root.ShouldContain("validationBehavior(),");
        root.ShouldContain("transactionBehavior(unitOfWork),");
    }

    /// <summary>A publishing context's composition root wires the outbox dispatcher and takes a handler.</summary>
    [Fact]
    public void Publishing_composition_root_wires_the_dispatcher()
    {
        var root = Emit(PublishingFixture).Single(f => f.RelativePath == "Ordering/infrastructure/OrderingInfrastructure.ts").Contents;

        root.ShouldContain("export function createOrderingInfrastructure(handler: IntegrationEventHandler): OrderingInfrastructure");
        root.ShouldContain("const dispatcher = new IntegrationEventDispatcher(outbox, handler);");
        root.ShouldContain("readonly dispatcher: IntegrationEventDispatcher;");
    }

    /// <summary>The shared infrastructure-runtime module is emitted once at the output root.</summary>
    [Fact]
    public void Shared_infrastructure_runtime_is_emitted_once()
    {
        Emit(Fixture).Count(f => f.RelativePath == "infrastructure-runtime.ts").ShouldBe(1);
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
