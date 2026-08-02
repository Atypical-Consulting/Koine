using System.Reflection;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>Epic R11 — Identity Strategies, Repositories &amp; Optimistic Concurrency.</summary>
public class R11IdentityRepositoryTests
{
    private static IReadOnlyList<Diagnostic> Diagnose(string source) => new KoineCompiler().Diagnose(source);

    private static (Assembly Asm, IReadOnlyList<Emit.EmittedFile> Files) Build(string source)
    {
        var result = new KoineCompiler().Compile(source, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        return (asm, result.Files);
    }

    private static string FileContents(IEnumerable<Emit.EmittedFile> files, string path) =>
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
        Diagnose(ThreeStrategies).ShouldBeEmpty();
        Build(ThreeStrategies);
    }

    [Fact]
    public void Guid_identity_is_unchanged_and_keeps_New()
    {
        var (asm, files) = Build(ThreeStrategies);
        var src = FileContents(files, "Catalog/ValueObjects/OrderId.cs");
        src.ShouldContain("public Guid Value { get; }");
        src.ShouldContain("public static OrderId New()\n        => new(Guid.NewGuid());");

        var orderId = asm.GetType("Catalog.OrderId")!;
        orderId.GetMethod("New", BindingFlags.Public | BindingFlags.Static).ShouldNotBeNull();
    }

    [Fact]
    public void Natural_string_identity_wraps_string_validates_and_has_no_New()
    {
        var (asm, files) = Build(ThreeStrategies);
        var src = FileContents(files, "Catalog/ValueObjects/Sku.cs");
        src.ShouldContain("public string Value { get; }");
        src.ShouldNotContain("New()");

        var sku = asm.GetType("Catalog.Sku")!;
        sku.GetMethod("New", BindingFlags.Public | BindingFlags.Static).ShouldBeNull();

        // Value equality on the wrapped string.
        var a = Activator.CreateInstance(sku, "ABC-1")!;
        var b = Activator.CreateInstance(sku, "ABC-1")!;
        b.ShouldBe(a);

        // A blank natural key is rejected at construction.
        var ex = Should.Throw<TargetInvocationException>(() => Activator.CreateInstance(sku, "   "));
        ex.InnerException!.GetType().Name.ShouldBe("DomainInvariantViolationException");
    }

    [Fact]
    public void Sequence_identity_wraps_long_and_has_no_New()
    {
        var (asm, files) = Build(ThreeStrategies);
        var src = FileContents(files, "Catalog/ValueObjects/InvoiceNo.cs");
        src.ShouldContain("public long Value { get; }");
        src.ShouldNotContain("New()");

        var inv = asm.GetType("Catalog.InvoiceNo")!;
        inv.GetMethod("New", BindingFlags.Public | BindingFlags.Static).ShouldBeNull();
        var id = Activator.CreateInstance(inv, 42L)!;
        inv.GetProperty("Value")!.GetValue(id).ShouldBe(42L);
    }

    [Fact]
    public void Natural_int_identity_wraps_int()
    {
        const string src = "context C {\n  entity E identified by EKey as natural(Int) { n: Int }\n}\n";
        Diagnose(src).ShouldBeEmpty();
        var (_, files) = Build(src);
        FileContents(files, "C/ValueObjects/EKey.cs").ShouldContain("public int Value { get; }");
    }

    [Fact]
    public void Natural_with_unsupported_backing_type_is_reported()
    {
        const string src = "context C {\n  entity E identified by EKey as natural(Decimal) { n: Int }\n}\n";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.NaturalIdBackingType);
    }

    // ---- A declared identity value object must be hash-compatible (#1873, following #1848) ----

    [Fact]
    public void Declared_identity_with_a_collection_field_is_reported()
    {
        const string src = """
            context Ordering {
              value Tag { text: String }
              value OrderId { tags: List<Tag> }

              aggregate Sales root Order {
                entity Order identified by OrderId {
                  shipped: Bool = false
                }
              }
            }
            """;

        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.IdentityNotHashCompatible);
    }

    [Fact]
    public void Declared_identity_with_a_collection_nested_two_levels_deep_is_reported()
    {
        // The collection is not a direct field of the identity itself — it is reached only by
        // recursing through an intermediate, otherwise-clean nested value object.
        const string src = """
            context Ordering {
              value Tag { text: String }
              value ProductCode { tags: List<Tag> }
              value OrderId { code: ProductCode }

              aggregate Sales root Order {
                entity Order identified by OrderId {
                  shipped: Bool = false
                }
              }
            }
            """;

        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.IdentityNotHashCompatible);
    }

    [Fact]
    public void Declared_identity_backed_only_by_primitives_is_not_reported()
    {
        const string src = """
            context Ordering {
              value OrderId { code: String  revision: Int }

              aggregate Sales root Order {
                entity Order identified by OrderId {
                  shipped: Bool = false
                }
              }
            }
            """;

        Diagnose(src).ShouldBeEmpty();
    }

    [Fact]
    public void Declared_identity_with_a_transitively_hashable_nested_value_object_is_not_reported()
    {
        const string src = """
            context Ordering {
              value ProductCode { code: String }
              value OrderId { code: ProductCode }

              aggregate Sales root Order {
                entity Order identified by OrderId {
                  shipped: Bool = false
                }
              }
            }
            """;

        Diagnose(src).ShouldBeEmpty();
    }

    [Fact]
    public void Declared_identity_with_an_enum_field_is_not_reported()
    {
        const string src = """
            context Ordering {
              enum Region { North South }
              value OrderId { code: String  region: Region }

              aggregate Sales root Order {
                entity Order identified by OrderId {
                  shipped: Bool = false
                }
              }
            }
            """;

        Diagnose(src).ShouldBeEmpty();
    }

    [Fact]
    public void Declared_identity_shaped_as_a_quantity_is_not_reported()
    {
        // A quantity (numeric amount + enum unit) is exactly the shape the issue calls out as an
        // edge case that must keep passing.
        const string src = """
            context Ordering {
              enum WeightUnit { Kg Lb }
              quantity OrderId { amount: Decimal  unit: WeightUnit }

              aggregate Sales root Order {
                entity Order identified by OrderId {
                  shipped: Bool = false
                }
              }
            }
            """;

        Diagnose(src).ShouldBeEmpty();
    }

    [Fact]
    public void Synthesized_identity_is_never_reported()
    {
        // No `value OrderId { … }` declaration at all — the identity is synthesized (always a
        // primitive Guid wrapper), so the check must not even look at it.
        const string src = """
            context Ordering {
              aggregate Sales root Order {
                entity Order identified by OrderId {
                  shipped: Bool = false
                }
              }
            }
            """;

        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.IdentityNotHashCompatible);
    }

    [Fact]
    public async Task Mutually_recursive_declared_identity_graph_does_not_hang()
    {
        // A self-referential/mutually-recursive value-object graph must not send the recursive
        // hash-compatibility walk into infinite recursion — it must terminate (bounded by a
        // path-scoped visited set), whatever it concludes about hashability.
        const string src = """
            context Ordering {
              value A { b: B }
              value B { a: A }
              value OrderId { a: A }

              aggregate Sales root Order {
                entity Order identified by OrderId {
                  shipped: Bool = false
                }
              }
            }
            """;

        var run = Task.Run(() => Diagnose(src));
        var finished = await Task.WhenAny(run, Task.Delay(TimeSpan.FromSeconds(10)));
        finished.ShouldBeSameAs(run, "the hash-compatibility check must terminate on a recursive value-object graph");
    }

    // ---- Identity value objects emit TryParse for ASP.NET Core query/route binding (#1649) --

    [Fact]
    public void Guid_identity_emits_TryParse_that_round_trips_a_guid_string()
    {
        var (asm, files) = Build(ThreeStrategies);
        var src = FileContents(files, "Catalog/ValueObjects/OrderId.cs");
        src.ShouldContain("public static bool TryParse(string? value, [NotNullWhen(true)] out OrderId? result)");

        var orderId = asm.GetType("Catalog.OrderId")!;
        var tryParse = orderId.GetMethod("TryParse", BindingFlags.Public | BindingFlags.Static)!;

        var guid = Guid.NewGuid();
        var okArgs = new object?[] { guid.ToString(), null };
        ((bool)tryParse.Invoke(null, okArgs)!).ShouldBeTrue();
        okArgs[1].ShouldNotBeNull();
        orderId.GetProperty("Value")!.GetValue(okArgs[1]).ShouldBe(guid);

        var badArgs = new object?[] { "not-a-guid", null };
        ((bool)tryParse.Invoke(null, badArgs)!).ShouldBeFalse();
        badArgs[1].ShouldBeNull();
    }

    [Fact]
    public void Natural_string_identity_TryParse_rejects_blank_and_null()
    {
        var (asm, files) = Build(ThreeStrategies);
        var src = FileContents(files, "Catalog/ValueObjects/Sku.cs");
        src.ShouldContain("public static bool TryParse(string? value, [NotNullWhen(true)] out Sku? result)");

        var sku = asm.GetType("Catalog.Sku")!;
        var tryParse = sku.GetMethod("TryParse", BindingFlags.Public | BindingFlags.Static)!;

        var okArgs = new object?[] { "ABC-1", null };
        ((bool)tryParse.Invoke(null, okArgs)!).ShouldBeTrue();
        sku.GetProperty("Value")!.GetValue(okArgs[1]).ShouldBe("ABC-1");

        var blankArgs = new object?[] { "   ", null };
        ((bool)tryParse.Invoke(null, blankArgs)!).ShouldBeFalse();
        blankArgs[1].ShouldBeNull();

        var nullArgs = new object?[] { null, null };
        ((bool)tryParse.Invoke(null, nullArgs)!).ShouldBeFalse();
        nullArgs[1].ShouldBeNull();
    }

    [Fact]
    public void Sequence_identity_TryParse_parses_long()
    {
        var (asm, files) = Build(ThreeStrategies);
        var src = FileContents(files, "Catalog/ValueObjects/InvoiceNo.cs");
        src.ShouldContain("public static bool TryParse(string? value, [NotNullWhen(true)] out InvoiceNo? result)");

        var inv = asm.GetType("Catalog.InvoiceNo")!;
        var tryParse = inv.GetMethod("TryParse", BindingFlags.Public | BindingFlags.Static)!;

        var okArgs = new object?[] { "42", null };
        ((bool)tryParse.Invoke(null, okArgs)!).ShouldBeTrue();
        inv.GetProperty("Value")!.GetValue(okArgs[1]).ShouldBe(42L);

        var badArgs = new object?[] { "not-a-number", null };
        ((bool)tryParse.Invoke(null, badArgs)!).ShouldBeFalse();
        badArgs[1].ShouldBeNull();
    }

    [Fact]
    public void Natural_int_identity_TryParse_parses_int()
    {
        const string src = "context C {\n  entity E identified by EKey as natural(Int) { n: Int }\n}\n";
        var (asm, files) = Build(src);
        FileContents(files, "C/ValueObjects/EKey.cs")
            .ShouldContain("public static bool TryParse(string? value, [NotNullWhen(true)] out EKey? result)");

        var eKey = asm.GetType("C.EKey")!;
        var tryParse = eKey.GetMethod("TryParse", BindingFlags.Public | BindingFlags.Static)!;

        var okArgs = new object?[] { "7", null };
        ((bool)tryParse.Invoke(null, okArgs)!).ShouldBeTrue();
        eKey.GetProperty("Value")!.GetValue(okArgs[1]).ShouldBe(7);

        var badArgs = new object?[] { "nope", null };
        ((bool)tryParse.Invoke(null, badArgs)!).ShouldBeFalse();
        badArgs[1].ShouldBeNull();
    }

    // ---- R11.2 / R11.3 — repository interface ------------------------------

    private const string OrderAggregate = """
        context Sales {
          value OrderLine { product: ProductId  quantity: Int }
          aggregate Sales root Order {
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
        var src = FileContents(files, "Sales/Repositories/IOrderRepository.cs");
        src.ShouldContain("public interface IOrderRepository");
        src.ShouldContain("Task<Order?> GetByIdAsync(OrderId id, CancellationToken ct = default);");
        src.ShouldContain("Task AddAsync(Order aggregate, CancellationToken ct = default);");
        asm.GetType("Sales.IOrderRepository").ShouldNotBeNull();
    }

    [Fact]
    public void Default_repository_exposes_the_full_mutating_set()
    {
        var (_, files) = Build(OrderAggregate);
        var src = FileContents(files, "Sales/Repositories/IOrderRepository.cs");
        src.ShouldContain("UpdateAsync(");
        src.ShouldContain("RemoveAsync(");
    }

    [Fact]
    public void Non_root_and_standalone_entities_get_no_repository()
    {
        const string src = """
            context Sales {
              entity Customer identified by CustomerId { name: String }
              aggregate Sales root Order {
                entity Order identified by OrderId { customer: CustomerId }
                entity OrderLine identified by OrderLineId { quantity: Int }
              }
            }
            """;
        var (_, files) = Build(src);
        files.Where(f => f.RelativePath.EndsWith("Repository.cs")).ShouldHaveSingleItem();
        files.ShouldNotContain(f => f.RelativePath == "Sales/Repositories/ICustomerRepository.cs");
        files.ShouldNotContain(f => f.RelativePath == "Sales/Repositories/IOrderLineRepository.cs");
    }

    [Fact]
    public void List_finder_returns_a_read_only_list_and_single_finder_a_nullable()
    {
        const string src = """
            context Sales {
              value OrderLine { product: ProductId  quantity: Int }
              aggregate Sales root Order {
                repository {
                  find byCustomer(customer: CustomerId): List<Order>
                  find mostRecent(customer: CustomerId): Order
                }
                entity Order identified by OrderId { customer: CustomerId  lines: List<OrderLine> }
              }
            }
            """;
        Diagnose(src).ShouldBeEmpty();
        var (_, files) = Build(src);
        var repo = FileContents(files, "Sales/Repositories/IOrderRepository.cs");
        repo.ShouldContain("Task<IReadOnlyList<Order>> ByCustomerAsync(CustomerId customer, CancellationToken ct = default);");
        repo.ShouldContain("Task<Order?> MostRecentAsync(CustomerId customer, CancellationToken ct = default);");
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
        Diagnose(src).ShouldBeEmpty();
        var (_, files) = Build(src);
        var repo = FileContents(files, "Audit/Repositories/IAuditEntryRepository.cs");
        repo.ShouldContain("GetByIdAsync(");
        repo.ShouldContain("AddAsync(");
        repo.ShouldNotContain("UpdateAsync(");
        repo.ShouldNotContain("RemoveAsync(");
        repo.ShouldContain("ByMessageAsync(");
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
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.UnknownRepositoryOperation);
    }

    [Fact]
    public void Finder_with_a_non_aggregate_result_type_is_reported()
    {
        const string src = """
            context Sales {
              aggregate Sales root Order {
                repository { find byCustomer(customer: CustomerId): List<CustomerId> }
                entity Order identified by OrderId { customer: CustomerId }
              }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.FinderResultType);
    }

    [Fact]
    public void Finder_parameter_named_ct_is_rejected()
    {
        // `ct` collides with the generated `CancellationToken ct` trailing parameter.
        const string src = """
            context Sales {
              aggregate Sales root Order {
                repository { find byCt(ct: CustomerId): Order }
                entity Order identified by OrderId { customer: CustomerId }
              }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.ReservedFinderParameter);
    }

    [Fact]
    public void Finder_named_like_a_builtin_operation_is_rejected()
    {
        // `find getById(...)` would emit a second GetByIdAsync alongside the built-in (CS0111).
        const string src = """
            context Sales {
              aggregate Sales root Order {
                repository { find getById(id: OrderId): Order }
                entity Order identified by OrderId { customer: CustomerId }
              }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.FinderNameCollision);
    }

    [Fact]
    public void Finder_with_duplicate_parameter_names_is_reported()
    {
        const string src = """
            context Sales {
              aggregate Sales root Order {
                repository { find f(x: CustomerId, x: CustomerId): Order }
                entity Order identified by OrderId { customer: CustomerId }
              }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.DuplicateParameter);
    }

    [Fact]
    public void Versioned_root_member_colliding_with_version_is_rejected()
    {
        // The synthetic `Version` token would clash with a member named `version` (CS0102).
        const string src = """
            context Sales {
              aggregate Sales root Order versioned {
                entity Order identified by OrderId { version: Int }
              }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.ReservedVersionMember);
    }

    [Fact]
    public void Duplicate_finder_name_is_reported()
    {
        const string src = """
            context Sales {
              aggregate Sales root Order {
                repository {
                  find byCustomer(customer: CustomerId): Order
                  find byCustomer(customer: CustomerId): Order
                }
                entity Order identified by OrderId { customer: CustomerId }
              }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.DuplicateFinder);
    }

    // ---- R11.4 — optimistic concurrency -----------------------------------

    private const string VersionedAggregate = """
        context Sales {
          aggregate Sales root Order versioned {
            entity Order identified by OrderId { customer: CustomerId }
          }
        }
        """;

    [Fact]
    public void Versioned_aggregate_and_its_repository_compile()
    {
        Diagnose(VersionedAggregate).ShouldBeEmpty();
        var (asm, files) = Build(VersionedAggregate);

        FileContents(files, "Sales/Order.cs").ShouldContain("public int Version { get; init; }");
        asm.GetType("Sales.Order")!.GetProperty("Version").ShouldNotBeNull();
        asm.GetType("Koine.Runtime.ConcurrencyConflictException").ShouldNotBeNull();
        files.ShouldContain(f => f.RelativePath == "Koine/Runtime/ConcurrencyConflictException.cs");
    }

    [Fact]
    public void Non_versioned_aggregate_has_no_version_property_or_concurrency_type()
    {
        var (_, files) = Build(OrderAggregate);
        FileContents(files, "Sales/Order.cs").ShouldNotContain("Version");
        files.ShouldNotContain(f => f.RelativePath == "Koine/Runtime/ConcurrencyConflictException.cs");
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
        Diagnose(src).ShouldBeEmpty();
    }
}
