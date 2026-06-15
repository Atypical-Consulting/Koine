using System.Reflection;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>Epic R11 — Identity Strategies, Repositories &amp; Optimistic Concurrency.</summary>
public class R11IdentityRepositoryTests
{
    private static IReadOnlyList<Diagnostic> Diagnose(string source) => new KoineCompiler().Diagnose(source);

    private static (Assembly Asm, IReadOnlyList<Koine.Compiler.Emit.EmittedFile> Files) Build(string source)
    {
        var result = new KoineCompiler().Compile(source, new CSharpEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var (asm, errors) = TestSupport.Compile(result.Files);
        Assert.True(asm is not null, "generated C# failed to compile:\n" + string.Join("\n", errors));
        return (asm!, result.Files);
    }

    private static string FileContents(IEnumerable<Koine.Compiler.Emit.EmittedFile> files, string path) =>
        files.Single(f => f.RelativePath == path).Contents;

    // ---- R11.1 — identity strategies --------------------------------------

    private const string ThreeStrategies = """
        context Catalog {
          entity Product identified by Sku       as natural(String) { name: String }
          entity Invoice identified by InvoiceNo as sequence        { amount: Int }
          entity Order   identified by OrderId                      { customer: CustomerId }
        }
        """;

    [Fact]
    public void All_three_identity_strategies_compile()
    {
        Assert.Empty(Diagnose(ThreeStrategies));
        Build(ThreeStrategies);
    }

    [Fact]
    public void Guid_identity_is_unchanged_and_keeps_New()
    {
        var (asm, files) = Build(ThreeStrategies);
        var src = FileContents(files, "Catalog/OrderId.cs");
        Assert.Contains("public Guid Value { get; }", src);
        Assert.Contains("public static OrderId New() => new(Guid.NewGuid());", src);

        var orderId = asm.GetType("Catalog.OrderId")!;
        Assert.NotNull(orderId.GetMethod("New", BindingFlags.Public | BindingFlags.Static));
    }

    [Fact]
    public void Natural_string_identity_wraps_string_validates_and_has_no_New()
    {
        var (asm, files) = Build(ThreeStrategies);
        var src = FileContents(files, "Catalog/Sku.cs");
        Assert.Contains("public string Value { get; }", src);
        Assert.DoesNotContain("New()", src);

        var sku = asm.GetType("Catalog.Sku")!;
        Assert.Null(sku.GetMethod("New", BindingFlags.Public | BindingFlags.Static));

        // Value equality on the wrapped string.
        var a = Activator.CreateInstance(sku, "ABC-1")!;
        var b = Activator.CreateInstance(sku, "ABC-1")!;
        Assert.Equal(a, b);

        // A blank natural key is rejected at construction.
        var ex = Assert.Throws<TargetInvocationException>(() => Activator.CreateInstance(sku, "   "));
        Assert.Equal("DomainInvariantViolationException", ex.InnerException!.GetType().Name);
    }

    [Fact]
    public void Sequence_identity_wraps_long_and_has_no_New()
    {
        var (asm, files) = Build(ThreeStrategies);
        var src = FileContents(files, "Catalog/InvoiceNo.cs");
        Assert.Contains("public long Value { get; }", src);
        Assert.DoesNotContain("New()", src);

        var inv = asm.GetType("Catalog.InvoiceNo")!;
        Assert.Null(inv.GetMethod("New", BindingFlags.Public | BindingFlags.Static));
        var id = Activator.CreateInstance(inv, 42L)!;
        Assert.Equal(42L, inv.GetProperty("Value")!.GetValue(id));
    }

    [Fact]
    public void Natural_int_identity_wraps_int()
    {
        const string src = "context C {\n  entity E identified by EKey as natural(Int) { n: Int }\n}\n";
        Assert.Empty(Diagnose(src));
        var (_, files) = Build(src);
        Assert.Contains("public int Value { get; }", FileContents(files, "C/EKey.cs"));
    }

    [Fact]
    public void Natural_with_unsupported_backing_type_is_reported()
    {
        const string src = "context C {\n  entity E identified by EKey as natural(Decimal) { n: Int }\n}\n";
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.NaturalIdBackingType);
    }

    // ---- R11.2 / R11.3 — repository interface ------------------------------

    private const string OrderAggregate = """
        context Sales {
          value OrderLine { product: ProductId  quantity: Int }
          aggregate Order root Order {
            entity Order identified by OrderId {
              customer: CustomerId
              lines:    List<OrderLine>
            }
          }
        }
        """;

    [Fact]
    public void Aggregate_root_emits_a_repository_interface_keyed_on_its_id()
    {
        var (asm, files) = Build(OrderAggregate);
        var src = FileContents(files, "Sales/IOrderRepository.cs");
        Assert.Contains("public interface IOrderRepository", src);
        Assert.Contains("Task<Order?> GetByIdAsync(OrderId id, CancellationToken ct = default);", src);
        Assert.Contains("Task AddAsync(Order aggregate, CancellationToken ct = default);", src);
        Assert.NotNull(asm.GetType("Sales.IOrderRepository"));
    }

    [Fact]
    public void Default_repository_exposes_the_full_mutating_set()
    {
        var (_, files) = Build(OrderAggregate);
        var src = FileContents(files, "Sales/IOrderRepository.cs");
        Assert.Contains("UpdateAsync(", src);
        Assert.Contains("RemoveAsync(", src);
    }

    [Fact]
    public void Non_root_and_standalone_entities_get_no_repository()
    {
        const string src = """
            context Sales {
              entity Customer identified by CustomerId { name: String }
              aggregate Order root Order {
                entity Order identified by OrderId { customer: CustomerId }
                entity OrderLine identified by OrderLineId { quantity: Int }
              }
            }
            """;
        var (_, files) = Build(src);
        Assert.Single(files, f => f.RelativePath.EndsWith("Repository.cs"));
        Assert.DoesNotContain(files, f => f.RelativePath == "Sales/ICustomerRepository.cs");
        Assert.DoesNotContain(files, f => f.RelativePath == "Sales/IOrderLineRepository.cs");
    }

    [Fact]
    public void List_finder_returns_a_read_only_list_and_single_finder_a_nullable()
    {
        const string src = """
            context Sales {
              value OrderLine { product: ProductId  quantity: Int }
              aggregate Order root Order {
                repository {
                  find byCustomer(customer: CustomerId): List<Order>
                  find mostRecent(customer: CustomerId): Order
                }
                entity Order identified by OrderId { customer: CustomerId  lines: List<OrderLine> }
              }
            }
            """;
        Assert.Empty(Diagnose(src));
        var (_, files) = Build(src);
        var repo = FileContents(files, "Sales/IOrderRepository.cs");
        Assert.Contains("Task<IReadOnlyList<Order>> ByCustomerAsync(CustomerId customer, CancellationToken ct = default);", repo);
        Assert.Contains("Task<Order?> MostRecentAsync(CustomerId customer, CancellationToken ct = default);", repo);
    }

    [Fact]
    public void Operations_clause_restricts_the_mutating_set()
    {
        const string src = """
            context Audit {
              aggregate AuditLog root AuditEntry {
                repository {
                  operations: add, getById
                  find byMessage(message: String): List<AuditEntry>
                }
                entity AuditEntry identified by AuditEntryId { message: String }
              }
            }
            """;
        Assert.Empty(Diagnose(src));
        var (_, files) = Build(src);
        var repo = FileContents(files, "Audit/IAuditEntryRepository.cs");
        Assert.Contains("GetByIdAsync(", repo);
        Assert.Contains("AddAsync(", repo);
        Assert.DoesNotContain("UpdateAsync(", repo);
        Assert.DoesNotContain("RemoveAsync(", repo);
        Assert.Contains("ByMessageAsync(", repo);
    }

    [Fact]
    public void Unknown_repository_operation_is_reported()
    {
        const string src = """
            context Audit {
              aggregate AuditLog root AuditEntry {
                repository { operations: add, purge }
                entity AuditEntry identified by AuditEntryId { message: String }
              }
            }
            """;
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.UnknownRepositoryOperation);
    }

    [Fact]
    public void Finder_with_a_non_aggregate_result_type_is_reported()
    {
        const string src = """
            context Sales {
              aggregate Order root Order {
                repository { find byCustomer(customer: CustomerId): List<CustomerId> }
                entity Order identified by OrderId { customer: CustomerId }
              }
            }
            """;
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.FinderResultType);
    }

    [Fact]
    public void Finder_parameter_named_ct_is_rejected()
    {
        // `ct` collides with the generated `CancellationToken ct` trailing parameter.
        const string src = """
            context Sales {
              aggregate Order root Order {
                repository { find byCt(ct: CustomerId): Order }
                entity Order identified by OrderId { customer: CustomerId }
              }
            }
            """;
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.ReservedFinderParameter);
    }

    [Fact]
    public void Finder_named_like_a_builtin_operation_is_rejected()
    {
        // `find getById(...)` would emit a second GetByIdAsync alongside the built-in (CS0111).
        const string src = """
            context Sales {
              aggregate Order root Order {
                repository { find getById(id: OrderId): Order }
                entity Order identified by OrderId { customer: CustomerId }
              }
            }
            """;
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.FinderNameCollision);
    }

    [Fact]
    public void Finder_with_duplicate_parameter_names_is_reported()
    {
        const string src = """
            context Sales {
              aggregate Order root Order {
                repository { find f(x: CustomerId, x: CustomerId): Order }
                entity Order identified by OrderId { customer: CustomerId }
              }
            }
            """;
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.DuplicateParameter);
    }

    [Fact]
    public void Versioned_root_member_colliding_with_version_is_rejected()
    {
        // The synthetic `Version` token would clash with a member named `version` (CS0102).
        const string src = """
            context Sales {
              aggregate Order root Order versioned {
                entity Order identified by OrderId { version: Int }
              }
            }
            """;
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.ReservedVersionMember);
    }

    [Fact]
    public void Duplicate_finder_name_is_reported()
    {
        const string src = """
            context Sales {
              aggregate Order root Order {
                repository {
                  find byCustomer(customer: CustomerId): Order
                  find byCustomer(customer: CustomerId): Order
                }
                entity Order identified by OrderId { customer: CustomerId }
              }
            }
            """;
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.DuplicateFinder);
    }

    // ---- R11.4 — optimistic concurrency -----------------------------------

    private const string VersionedAggregate = """
        context Sales {
          aggregate Order root Order versioned {
            entity Order identified by OrderId { customer: CustomerId }
          }
        }
        """;

    [Fact]
    public void Versioned_aggregate_and_its_repository_compile()
    {
        Assert.Empty(Diagnose(VersionedAggregate));
        var (asm, files) = Build(VersionedAggregate);

        Assert.Contains("public int Version { get; init; }", FileContents(files, "Sales/Order.cs"));
        Assert.NotNull(asm.GetType("Sales.Order")!.GetProperty("Version"));
        Assert.NotNull(asm.GetType("Koine.Runtime.ConcurrencyConflictException"));
        Assert.Contains(files, f => f.RelativePath == "Koine/Runtime/ConcurrencyConflictException.cs");
    }

    [Fact]
    public void Non_versioned_aggregate_has_no_version_property_or_concurrency_type()
    {
        var (_, files) = Build(OrderAggregate);
        Assert.DoesNotContain("Version", FileContents(files, "Sales/Order.cs"));
        Assert.DoesNotContain(files, f => f.RelativePath == "Koine/Runtime/ConcurrencyConflictException.cs");
    }

    // ---- soft keywords -----------------------------------------------------

    [Fact]
    public void New_keywords_remain_usable_as_field_names()
    {
        // `find`, `as`, `natural`, `sequence`, `versioned`, `repository`, `operations`,
        // `guid` are soft keywords: they may still name members.
        const string src = """
            context C {
              value V { find: Int  as: Int  natural: Int  sequence: Int  versioned: Int  repository: Int  operations: Int  guid: Int }
            }
            """;
        Assert.Empty(Diagnose(src));
    }
}
