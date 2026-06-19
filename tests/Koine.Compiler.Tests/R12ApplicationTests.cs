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
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
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
        Diagnose(Fixture).ShouldBeEmpty();
        Build(Fixture);
    }

    // ---- R12.1 — Unit of Work ---------------------------------------------

    [Fact]
    public void Context_with_an_aggregate_emits_a_unit_of_work()
    {
        var (asm, files) = Build(Fixture);
        var uow = FileContents(files, "Sales/Abstractions/IUnitOfWork.cs");
        uow.ShouldContain("public interface IUnitOfWork");
        uow.ShouldContain("IOrderRepository Orders { get; }");
        uow.ShouldContain("Task<int> SaveChangesAsync(CancellationToken ct = default);");
        asm.GetType("Sales.IUnitOfWork").ShouldNotBeNull();
    }

    [Fact]
    public void Unit_of_work_references_no_infrastructure_namespace()
    {
        var (_, files) = Build(Fixture);
        var uow = FileContents(files, "Sales/Abstractions/IUnitOfWork.cs");
        foreach (var banned in new[] { "EntityFrameworkCore", "System.Data", "Dapper", "MongoDB", "DbContext" })
        {
            uow.ShouldNotContain(banned);
        }
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
        var uow = FileContents(files, "Sales/Abstractions/IUnitOfWork.cs");
        uow.ShouldContain("IOrderRepository Orders { get; }");
        uow.ShouldContain("IShipmentRepository Shipments { get; }");
        (uow.IndexOf("Orders", StringComparison.Ordinal) < uow.IndexOf("Shipments", StringComparison.Ordinal)).ShouldBeTrue();
        asm.GetType("Sales.IUnitOfWork").ShouldNotBeNull();
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
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.UnknownAggregateRoot);
    }

    [Fact]
    public void Context_without_aggregates_emits_no_unit_of_work()
    {
        const string src = "context C {\n  value V { n: Int }\n}\n";
        var (_, files) = Build(src);
        files.ShouldNotContain(f => f.RelativePath == "C/Abstractions/IUnitOfWork.cs");
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
        FileContents(files, "Library/Abstractions/IUnitOfWork.cs").ShouldContain("ICategoryRepository Categories { get; }");
    }

    // ---- R12.2 — application service interfaces ----------------------------

    [Fact]
    public void Use_cases_emit_an_application_service_interface()
    {
        var (asm, files) = Build(Fixture);
        var svc = FileContents(files, "Sales/Services/IOrderService.cs");
        svc.ShouldContain("public interface IOrderService");
        svc.ShouldContain("Task<OrderId> PlaceOrder(CustomerId customer, IReadOnlyList<OrderLine> lines, CancellationToken ct = default);");
        svc.ShouldContain("Task CancelOrder(OrderId order, CancellationToken ct = default);"); // void use case -> Task
        asm.GetType("Sales.IOrderService").ShouldNotBeNull();
    }

    [Fact]
    public void Service_with_only_use_cases_emits_no_domain_class()
    {
        var (_, files) = Build(Fixture);
        files.ShouldNotContain(f => f.RelativePath == "Sales/Services/OrderService.cs");
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
        files.ShouldContain(f => f.RelativePath == "Sales/Services/Pricing.cs");   // domain class (operation)
        files.ShouldContain(f => f.RelativePath == "Sales/Services/IPricing.cs");  // app interface (usecase)
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
        Diagnose(src).ShouldBeEmpty();
        var (_, files) = Build(src);
        var svc = FileContents(files, "Sales/Services/IQueries.cs");
        svc.ShouldContain("Task<OrderSummary> GetOrder(OrderId order, CancellationToken ct = default);");
        svc.ShouldContain("Task<IReadOnlyList<OrderSummary>> ListOrders(CancellationToken ct = default);");
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
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.DuplicateUseCase);
    }

    [Fact]
    public void Use_case_with_unknown_type_is_reported()
    {
        const string src = "context C {\n  service S {\n    usecase Do(n: Nope): Int\n  }\n}\n";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.UnknownType);
    }

    // ---- R12.3 — read models & projection mappers --------------------------

    [Fact]
    public void Read_model_emits_a_record_and_a_projection_mapper()
    {
        var (_, files) = Build(Fixture);
        var rm = FileContents(files, "Sales/ReadModels/OrderSummary.cs");
        rm.ShouldContain("public sealed record OrderSummary(");
        rm.ShouldContain("OrderId Id");
        rm.ShouldContain("OrderStatus Status");
        rm.ShouldContain("int LineCount");
        rm.ShouldContain("public static OrderSummary ToOrderSummary(this Order src)");
        rm.ShouldContain("new OrderSummary(src.Id, src.Customer, src.Status, src.Lines.Count)");
        rm.ShouldNotContain("IAggregateRoot");
        rm.ShouldNotContain("invariant");
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
        summaryT.GetProperty("Id")!.GetValue(summary).ShouldBe(id);
        summaryT.GetProperty("LineCount")!.GetValue(summary).ShouldBe(2); // lines.count
    }

    [Fact]
    public void Read_model_unknown_source_is_reported()
    {
        const string src = "context C {\n  readmodel R from Nope { a }\n}\n";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.ReadModelUnknownSource);
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
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.ReadModelUnknownField);
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
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.DuplicateReadModelField);
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
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.DuplicateReadModelField);
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
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.ReservedRecordMember);
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
        diags.ShouldContain(d => d.Code == DiagnosticCodes.DuplicateMember);
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
        Diagnose(src).ShouldBeEmpty();
        var (_, files) = Build(src);
        var rm = FileContents(files, "C/ReadModels/CartTotal.cs");
        rm.ShouldContain("using System.Linq;");
        rm.ShouldContain(".Sum(");
    }

    // ---- R12.4 — query objects --------------------------------------------

    [Fact]
    public void Queries_emit_dtos_and_a_shared_handler_interface()
    {
        var (asm, files) = Build(Fixture);
        FileContents(files, "Sales/Queries/OrdersByStatus.cs").ShouldContain("public sealed record OrdersByStatus(OrderStatus Status);");
        FileContents(files, "Sales/Queries/OrderById.cs").ShouldContain("public sealed record OrderById(OrderId Id);");

        var handler = FileContents(files, "Koine/Runtime/IQueryHandler.cs");
        handler.ShouldContain("public interface IQueryHandler<TQuery, TResult>");
        handler.ShouldContain("Task<TResult> HandleAsync(TQuery query, CancellationToken ct = default);");
        asm.GetType("Sales.OrdersByStatus").ShouldNotBeNull();
        asm.GetType("Koine.Runtime.IQueryHandler`2").ShouldNotBeNull();
    }

    [Fact]
    public void Query_handler_runtime_type_is_emitted_once()
    {
        var (_, files) = Build(Fixture);
        files.Where(f => f.RelativePath == "Koine/Runtime/IQueryHandler.cs").ShouldHaveSingleItem();
    }

    [Fact]
    public void Model_without_queries_emits_no_query_handler()
    {
        const string src = "context C {\n  value V { n: Int }\n}\n";
        var (_, files) = Build(src);
        files.ShouldNotContain(f => f.RelativePath == "Koine/Runtime/IQueryHandler.cs");
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
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.QueryResultNotReadModel);
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
        Diagnose(src).ShouldBeEmpty();
    }
}
