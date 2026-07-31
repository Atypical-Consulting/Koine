namespace Koine.Compiler.Tests;

/// <summary>
/// C# source for an in-memory <c>IOrderRepository</c>/<c>IUnitOfWork</c> test double for
/// <see cref="R18CSharpApplicationTests.Fixture"/>'s <c>Order</c> aggregate (issue #1591). This can
/// only be a source string, not an ordinary compiled class in this project: <c>IOrderRepository</c>,
/// <c>IUnitOfWork</c>, <c>Order</c>, and <c>OrderId</c> are generated per test by the C# emitter and
/// exist only inside that test's dynamically Roslyn-compiled assembly (<see cref="TestSupport.Compile"/>),
/// so the fake is compiled alongside the emitted files as one more syntax tree rather than referenced
/// at this project's own compile time.
/// </summary>
internal static class FakeOrderRepositorySource
{
    public const string Source = """
        namespace Sales;

        internal sealed class FakeOrderRepository : IOrderRepository
        {
            private readonly System.Collections.Concurrent.ConcurrentDictionary<OrderId, Order> _orders = new();

            public System.Threading.Tasks.Task<Order?> GetByIdAsync(OrderId id, System.Threading.CancellationToken ct = default)
                => System.Threading.Tasks.Task.FromResult(_orders.TryGetValue(id, out var order) ? order : null);

            public System.Threading.Tasks.Task AddAsync(Order aggregate, System.Threading.CancellationToken ct = default)
            {
                _orders[aggregate.Id] = aggregate;
                return System.Threading.Tasks.Task.CompletedTask;
            }

            public System.Threading.Tasks.Task UpdateAsync(Order aggregate, System.Threading.CancellationToken ct = default)
            {
                _orders[aggregate.Id] = aggregate;
                return System.Threading.Tasks.Task.CompletedTask;
            }
        }

        internal sealed class FakeUnitOfWork : IUnitOfWork
        {
            public FakeUnitOfWork(IOrderRepository orders) => Orders = orders;

            public IOrderRepository Orders { get; }

            public System.Threading.Tasks.Task<int> SaveChangesAsync(System.Threading.CancellationToken ct = default)
                => System.Threading.Tasks.Task.FromResult(0);
        }
        """;
}
