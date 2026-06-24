using Koine.Compiler.Emit;
using Koine.Compiler.Emit.TypeScript;
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
            .Where(f => f.RelativePath.Contains("/infrastructure/", StringComparison.Ordinal))
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
