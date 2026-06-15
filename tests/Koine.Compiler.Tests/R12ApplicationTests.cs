using System.Collections;
using System.Reflection;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>Epic R12 — Application Services, Read Models &amp; CQRS.</summary>
public class R12ApplicationTests
{
    private static IReadOnlyList<Diagnostic> Diagnose(string source) => new KoineCompiler().Diagnose(source);

    private static (Assembly Asm, IReadOnlyList<Emit.EmittedFile> Files) Build(string source)
    {
        var result = new KoineCompiler().Compile(source, new CSharpEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var (asm, errors) = TestSupport.Compile(result.Files);
        Assert.True(asm is not null, "generated C# failed to compile:\n" + string.Join("\n", errors));
        return (asm, result.Files);
    }

    private static string FileContents(IEnumerable<Emit.EmittedFile> files, string path) =>
        files.Single(f => f.RelativePath == path).Contents;

    // A full read/write fixture exercising all four stories together.
    private const string Fixture = """
        context Sales {
          enum OrderStatus { Draft, Placed, Shipped }
          value OrderLine { product: ProductId  quantity: Int }
          aggregate Order root Order {
            entity Order identified by OrderId {
              customer: CustomerId
              lines:    List<OrderLine>
              status:   OrderStatus = Draft
            }
          }

          service OrderService {
            usecase PlaceOrder(customer: CustomerId, lines: List<OrderLine>): OrderId
            usecase CancelOrder(order: OrderId)
          }

          readmodel OrderSummary from Order {
            id
            customer
            status
            lineCount: Int = lines.count
          }

          query OrdersByStatus(status: OrderStatus): List<OrderSummary>
          query OrderById(id: OrderId): OrderSummary
        }
        """;

    [Fact]
    public void Full_fixture_is_valid_and_compiles()
    {
        Assert.Empty(Diagnose(Fixture));
        Build(Fixture);
    }

    // ---- R12.1 — Unit of Work ---------------------------------------------

    [Fact]
    public void Context_with_an_aggregate_emits_a_unit_of_work()
    {
        var (asm, files) = Build(Fixture);
        var uow = FileContents(files, "Sales/IUnitOfWork.cs");
        Assert.Contains("public interface IUnitOfWork", uow);
        Assert.Contains("IOrderRepository Orders { get; }", uow);
        Assert.Contains("Task<int> SaveChangesAsync(CancellationToken ct = default);", uow);
        Assert.NotNull(asm.GetType("Sales.IUnitOfWork"));
    }

    [Fact]
    public void Unit_of_work_references_no_infrastructure_namespace()
    {
        var (_, files) = Build(Fixture);
        var uow = FileContents(files, "Sales/IUnitOfWork.cs");
        foreach (var banned in new[] { "EntityFrameworkCore", "System.Data", "Dapper", "MongoDB", "DbContext" })
            Assert.DoesNotContain(banned, uow);
    }

    [Fact]
    public void Unit_of_work_lists_each_aggregate_in_declaration_order()
    {
        const string src = """
            context Sales {
              aggregate Order root Order {
                entity Order identified by OrderId { customer: CustomerId }
              }
              aggregate Shipment root Shipment {
                entity Shipment identified by ShipmentId { order: OrderId }
              }
            }
            """;
        var (asm, files) = Build(src);
        var uow = FileContents(files, "Sales/IUnitOfWork.cs");
        Assert.Contains("IOrderRepository Orders { get; }", uow);
        Assert.Contains("IShipmentRepository Shipments { get; }", uow);
        Assert.True(uow.IndexOf("Orders", StringComparison.Ordinal) < uow.IndexOf("Shipments", StringComparison.Ordinal));
        Assert.NotNull(asm.GetType("Sales.IUnitOfWork"));
    }

    [Fact]
    public void Aggregate_root_that_is_not_an_entity_is_reported()
    {
        const string src = """
            context C {
              aggregate A root Money {
                value Money { amount: Int }
              }
            }
            """;
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.UnknownAggregateRoot);
    }

    [Fact]
    public void Context_without_aggregates_emits_no_unit_of_work()
    {
        const string src = "context C {\n  value V { n: Int }\n}\n";
        var (_, files) = Build(src);
        Assert.DoesNotContain(files, f => f.RelativePath == "C/IUnitOfWork.cs");
    }

    [Fact]
    public void Repository_property_name_is_pluralized()
    {
        const string src = """
            context Library {
              aggregate Catalog root Category {
                entity Category identified by CategoryId { name: String }
              }
            }
            """;
        var (_, files) = Build(src);
        Assert.Contains("ICategoryRepository Categories { get; }", FileContents(files, "Library/IUnitOfWork.cs"));
    }

    // ---- R12.2 — application service interfaces ----------------------------

    [Fact]
    public void Use_cases_emit_an_application_service_interface()
    {
        var (asm, files) = Build(Fixture);
        var svc = FileContents(files, "Sales/IOrderService.cs");
        Assert.Contains("public interface IOrderService", svc);
        Assert.Contains("Task<OrderId> PlaceOrder(CustomerId customer, IReadOnlyList<OrderLine> lines);", svc);
        Assert.Contains("Task CancelOrder(OrderId order);", svc); // void use case -> Task
        Assert.NotNull(asm.GetType("Sales.IOrderService"));
    }

    [Fact]
    public void Service_with_only_use_cases_emits_no_domain_class()
    {
        var (_, files) = Build(Fixture);
        Assert.DoesNotContain(files, f => f.RelativePath == "Sales/OrderService.cs");
    }

    [Fact]
    public void Service_can_mix_operations_and_use_cases()
    {
        const string src = """
            context Sales {
              value Money { amount: Decimal }
              service Pricing {
                operation withTax(amount: Money, rate: Decimal): Money = amount * rate
                usecase Quote(amount: Money): Money
              }
            }
            """;
        var (_, files) = Build(src);
        Assert.Contains(files, f => f.RelativePath == "Sales/Pricing.cs");   // domain class (operation)
        Assert.Contains(files, f => f.RelativePath == "Sales/IPricing.cs");  // app interface (usecase)
    }

    [Fact]
    public void Query_style_use_case_returning_a_read_model_compiles()
    {
        // R12.2 AC: a query-style use case (returns a read model) maps its result type.
        const string src = """
            context Sales {
              aggregate Order root Order {
                entity Order identified by OrderId { customer: CustomerId }
              }
              readmodel OrderSummary from Order { id  customer }
              service Queries {
                usecase GetOrder(order: OrderId): OrderSummary
                usecase ListOrders(): List<OrderSummary>
              }
            }
            """;
        Assert.Empty(Diagnose(src));
        var (_, files) = Build(src);
        var svc = FileContents(files, "Sales/IQueries.cs");
        Assert.Contains("Task<OrderSummary> GetOrder(OrderId order);", svc);
        Assert.Contains("Task<IReadOnlyList<OrderSummary>> ListOrders();", svc);
    }

    [Fact]
    public void Duplicate_use_case_name_is_reported()
    {
        const string src = """
            context C {
              service S {
                usecase Do(n: Int): Int
                usecase Do(n: Int): Int
              }
            }
            """;
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.DuplicateUseCase);
    }

    [Fact]
    public void Use_case_with_unknown_type_is_reported()
    {
        const string src = "context C {\n  service S {\n    usecase Do(n: Nope): Int\n  }\n}\n";
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.UnknownType);
    }

    // ---- R12.3 — read models & projection mappers --------------------------

    [Fact]
    public void Read_model_emits_a_record_and_a_projection_mapper()
    {
        var (_, files) = Build(Fixture);
        var rm = FileContents(files, "Sales/OrderSummary.cs");
        Assert.Contains("public sealed record OrderSummary(", rm);
        Assert.Contains("OrderId Id", rm);
        Assert.Contains("OrderStatus Status", rm);
        Assert.Contains("int LineCount", rm);
        Assert.Contains("public static OrderSummary ToOrderSummary(this Order src)", rm);
        Assert.Contains("new OrderSummary(src.Id, src.Customer, src.Status, src.Lines.Count)", rm);
        Assert.DoesNotContain("IAggregateRoot", rm);
        Assert.DoesNotContain("invariant", rm);
    }

    [Fact]
    public void Projection_mapper_produces_the_expected_dto()
    {
        var (asm, _) = Build(Fixture);
        var orderT = asm.GetType("Sales.Order")!;
        var orderId = asm.GetType("Sales.OrderId")!;
        var customerId = asm.GetType("Sales.CustomerId")!;
        var lineT = asm.GetType("Sales.OrderLine")!;
        var productId = asm.GetType("Sales.ProductId")!;
        var status = TestSupport.EnumValue(asm.GetType("Sales.OrderStatus")!, "Draft");

        var lines = (IList)Activator.CreateInstance(typeof(List<>).MakeGenericType(lineT))!;
        lines.Add(Activator.CreateInstance(lineT, productId.GetMethod("New")!.Invoke(null, null), 2));
        lines.Add(Activator.CreateInstance(lineT, productId.GetMethod("New")!.Invoke(null, null), 5));
        var id = orderId.GetMethod("New")!.Invoke(null, null);
        var customer = customerId.GetMethod("New")!.Invoke(null, null);
        var order = Activator.CreateInstance(orderT, id, customer, lines, status)!;

        var mapper = asm.GetType("Sales.OrderSummaryProjection")!;
        var summary = mapper.GetMethod("ToOrderSummary")!.Invoke(null, new[] { order })!;
        var summaryT = summary.GetType();
        Assert.Equal(id, summaryT.GetProperty("Id")!.GetValue(summary));
        Assert.Equal(2, summaryT.GetProperty("LineCount")!.GetValue(summary)); // lines.count
    }

    [Fact]
    public void Read_model_unknown_source_is_reported()
    {
        const string src = "context C {\n  readmodel R from Nope { a }\n}\n";
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.ReadModelUnknownSource);
    }

    [Fact]
    public void Read_model_unknown_field_is_reported()
    {
        const string src = """
            context C {
              value V { a: Int }
              readmodel R from V { a  bogus }
            }
            """;
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.ReadModelUnknownField);
    }

    [Fact]
    public void Read_model_duplicate_field_is_reported()
    {
        const string src = """
            context C {
              value V { a: Int }
              readmodel R from V { a  a }
            }
            """;
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.DuplicateReadModelField);
    }

    [Fact]
    public void Read_model_fields_colliding_only_by_case_are_reported()
    {
        // `total` and `Total` both PascalCase to the record property `Total` (CS0102).
        const string src = """
            context C {
              value V { n: Int }
              readmodel R from V { total: Int = 1  Total: Int = 2 }
            }
            """;
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.DuplicateReadModelField);
    }

    [Fact]
    public void Read_model_field_colliding_with_a_record_member_is_reported()
    {
        const string src = """
            context C {
              value V { n: Int }
              readmodel R from V { equals: Int = 1 }
            }
            """;
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.ReservedRecordMember);
    }

    [Fact]
    public void Read_model_over_a_source_with_duplicate_members_does_not_crash()
    {
        // The validator builds a member map from the source; a source with duplicate
        // members (reported as KOI0103) must not throw an unhandled ArgumentException.
        const string src = """
            context C {
              value V { a: Int  a: Int }
              readmodel R from V { a }
            }
            """;
        var diags = Diagnose(src); // must return (not throw)
        Assert.Contains(diags, d => d.Code == DiagnosticCodes.DuplicateMember);
    }

    [Fact]
    public void Read_model_projection_using_a_linq_aggregate_compiles()
    {
        // `sum` emits a LINQ `.Sum(...)`, which needs `using System.Linq;` in the file.
        const string src = """
            context C {
              value Line { quantity: Int }
              aggregate Cart root Cart {
                entity Cart identified by CartId { lines: List<Line> }
              }
              readmodel CartTotal from Cart { units: Int = lines.sum(l => l.quantity) }
            }
            """;
        Assert.Empty(Diagnose(src));
        var (_, files) = Build(src);
        var rm = FileContents(files, "C/CartTotal.cs");
        Assert.Contains("using System.Linq;", rm);
        Assert.Contains(".Sum(", rm);
    }

    // ---- R12.4 — query objects --------------------------------------------

    [Fact]
    public void Queries_emit_dtos_and_a_shared_handler_interface()
    {
        var (asm, files) = Build(Fixture);
        Assert.Contains("public sealed record OrdersByStatus(OrderStatus Status);", FileContents(files, "Sales/OrdersByStatus.cs"));
        Assert.Contains("public sealed record OrderById(OrderId Id);", FileContents(files, "Sales/OrderById.cs"));

        var handler = FileContents(files, "Koine/Runtime/IQueryHandler.cs");
        Assert.Contains("public interface IQueryHandler<TQuery, TResult>", handler);
        Assert.Contains("Task<TResult> HandleAsync(TQuery query, CancellationToken ct = default);", handler);
        Assert.NotNull(asm.GetType("Sales.OrdersByStatus"));
        Assert.NotNull(asm.GetType("Koine.Runtime.IQueryHandler`2"));
    }

    [Fact]
    public void Query_handler_runtime_type_is_emitted_once()
    {
        var (_, files) = Build(Fixture);
        Assert.Single(files, f => f.RelativePath == "Koine/Runtime/IQueryHandler.cs");
    }

    [Fact]
    public void Model_without_queries_emits_no_query_handler()
    {
        const string src = "context C {\n  value V { n: Int }\n}\n";
        var (_, files) = Build(src);
        Assert.DoesNotContain(files, f => f.RelativePath == "Koine/Runtime/IQueryHandler.cs");
    }

    [Fact]
    public void Query_with_a_non_read_model_result_is_reported()
    {
        const string src = """
            context C {
              value V { n: Int }
              query Q(n: Int): V
            }
            """;
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.QueryResultNotReadModel);
    }

    // ---- soft keywords -----------------------------------------------------

    [Fact]
    public void New_keywords_remain_usable_as_field_names()
    {
        const string src = """
            context C {
              value V { usecase: Int  readmodel: Int  from: Int  query: Int }
            }
            """;
        Assert.Empty(Diagnose(src));
    }
}
