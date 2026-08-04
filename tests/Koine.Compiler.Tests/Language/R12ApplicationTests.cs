using System.Collections;
using System.Reflection;
using Koine.Compiler.Diagnostics;
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
          aggregate Sales root Order {
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
              aggregate Sales root Order {
                entity Order identified by OrderId { customer: CustomerId }
              }
              aggregate Dispatch root Shipment {
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
              aggregate Sales root Order {
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
              aggregate Checkout root Cart {
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

    // ---- R12.3 — read-model field types under a cross-context name collision (#1715) ----

    // `Status` is declared in BOTH contexts, with DIFFERENT kinds: an ENUM in `Ordering` (where the
    // read model lives) and a VALUE OBJECT in `Shipping`. R13.2 makes that legal — type-name
    // uniqueness is enforced per context, not globally — but the index's flat, context-blind type
    // table keeps one slot per simple name (last write wins), so `Shipping.Status`, declared second,
    // owns the global slot. The KOI1204 field-type gate must judge `label` against ORDERING's
    // `Status` all the same: neither silently skipped nor spuriously raised.
    private const string ShadowedStatusMatching = """
        context Ordering {
          enum Status { Open Closed }
          value Order { total: Int  state: Status }
          readmodel OrderView from Order { label: Status = state }
        }
        context Shipping {
          value Status { code: Int }
        }
        """;

    // Same collision; the projection is a genuine mismatch (`total` is an Int, the field is declared
    // `Status`), so the gate must still fire.
    private const string ShadowedStatusMismatching = """
        context Ordering {
          enum Status { Open Closed }
          value Order { total: Int  state: Status }
          readmodel OrderView from Order { label: Status = total }
        }
        context Shipping {
          value Status { code: Int }
        }
        """;

    [Fact]
    public void Read_model_field_typed_by_a_context_shadowed_name_is_accepted()
    {
        // The field's declared `Status` resolves to Ordering's enum, which is exactly what the
        // projection yields — no KOI1204, even though a differently-kinded `Shipping.Status` owns
        // the global name slot.
        // Regression pin: this passes on `main` too — the KOI1204 gate consumes only a boolean
        // (`IsKnownType`) whose value provably can't diverge between the two Classify overloads, and
        // `MemberAnalysis.IsAssignable` is pure name-shape matching. The diff-sensitive guards for
        // #1715 are R9ValueObjectTests' two `…_alongside_KOI0908` tests.
        Diagnose(ShadowedStatusMatching).ShouldNotContain(d => d.Code == DiagnosticCodes.ReadModelFieldTypeMismatch);
    }

    [Fact]
    public void Read_model_field_type_mismatch_is_reported_under_a_context_shadowed_name()
    {
        // The KOI1204 gate is guarded by `IsKnownType(<declared type>)`: the mismatch is only
        // reported when the declared type resolves. A cross-context collision on `Status` must not
        // suppress it.
        // Regression pin: this passes on `main` too — the gate consumes only that boolean, whose
        // value provably can't diverge between the two Classify overloads, and the mismatch itself is
        // decided by `MemberAnalysis.IsAssignable`, pure name-shape matching that is wholly
        // context-insensitive. The diff-sensitive guards for #1715 are R9ValueObjectTests' two
        // `…_alongside_KOI0908` tests.
        Diagnose(ShadowedStatusMismatching).ShouldContain(d => d.Code == DiagnosticCodes.ReadModelFieldTypeMismatch);
    }

    // ---- R12.3 — a read model's BARE ENUM MEMBER projection (#1886) --------

    // `Active` is declared by TWO enums. `TypeResolver.VisitIdentifier` used to resolve a bare enum
    // member through the flat, last-write-wins `ModelIndex.EnumMemberToType`, so whichever enum was
    // parsed LAST owned the global `Active` slot — and the KOI1204 gate then reported the mismatch it
    // had just manufactured. The field's own declared type (`Status`) and its bounded context both
    // disambiguate it; every fixture below therefore ships in BOTH context declaration orders, since a
    // single-order assertion proves luck rather than correctness.
    private const string AlphaBareMemberProjection = """
        context Alpha {
          enum Status { Draft Active }
          value Item { lifecycle: Status }
          readmodel ItemView from Item { stage: Status = Active }
        }
        """;

    private const string ZetaSharingActive = """
        context Zeta {
          enum Phase { Idle Active }
        }
        """;

    /// <summary>Assembles the model with the colliding sibling context declared first or last.</summary>
    private static string BareMemberModel(string alpha, bool zetaLast, string zeta = ZetaSharingActive) =>
        zetaLast ? alpha + "\n\n" + zeta : zeta + "\n\n" + alpha;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Read_model_projecting_a_bare_enum_member_resolves_it_in_its_own_context(bool zetaLast)
    {
        // `Alpha.Status` declares `Active`; `Zeta.Phase` declares an unrelated `Active` in ANOTHER
        // context, which R13.2 permits. The projection is legal under either declaration order.
        Diagnose(BareMemberModel(AlphaBareMemberProjection, zetaLast))
            .ShouldNotContain(d => d.Code == DiagnosticCodes.ReadModelFieldTypeMismatch);
    }

    // Both enums live in the SAME context, so context-scoping alone can't separate them — only the
    // field's DECLARED type can. This is the half of #1886 that a context-scoped index does not fix.
    private const string SameContextAmbiguousMember = """
        context Alpha {
          enum Status { Draft Active }
          enum Phase { Idle Active }
          value Item { lifecycle: Status }
          readmodel ItemView from Item { stage: Status = Active }
        }
        """;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Read_model_projecting_a_bare_member_shared_within_one_context_is_disambiguated_by_the_declared_type(
        bool zetaLast)
    {
        Diagnose(BareMemberModel(SameContextAmbiguousMember, zetaLast))
            .ShouldNotContain(d => d.Code == DiagnosticCodes.ReadModelFieldTypeMismatch);
    }

    // Validator and EMITTER must agree, or a model the validator newly accepts emits code that does not
    // compile — the producer/consumer split behind #1796/#1870. Two fields project the SAME bare member
    // `Active` under DIFFERENT declared types, which no single global answer can satisfy: the flat map
    // has one slot for `Active` and would have to name one enum for both. `Build` Roslyn-compiles the
    // emitted C#, so this asserts the emitter reaches the same per-field answer the validator did.
    private const string SameContextMemberProjectedUnderBothEnums = """
        context Alpha {
          enum Status { Draft Active }
          enum Phase { Idle Active }
          value Item { lifecycle: Status }
          readmodel ItemView from Item {
            stage: Status = Active
            step: Phase = Active
          }
        }
        """;

    [Fact]
    public void Read_model_emits_each_shared_bare_member_under_its_own_declared_enum()
    {
        var (_, files) = Build(SameContextMemberProjectedUnderBothEnums);

        string view = FileContents(files, "Alpha/ReadModels/ItemView.cs");
        view.ShouldContain("Status Stage");
        view.ShouldContain("Phase Step");
        view.ShouldContain("new ItemView(Status.Active, Phase.Active)");
    }

    // The false-NEGATIVE guard: `Busy` belongs to a sibling enum in the SAME context and `Status` does
    // NOT declare it, so this is a genuine declared/projected mismatch. Honouring the declared type as
    // a hint must never be allowed to launder a real mismatch into silence.
    private const string SameContextGenuineMismatch = """
        context Alpha {
          enum Status { Draft Active }
          enum Phase { Idle Busy }
          value Item { lifecycle: Status }
          readmodel ItemView from Item { stage: Status = Busy }
        }
        """;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Read_model_projecting_a_bare_member_its_declared_enum_does_not_declare_still_reports_KOI1204(
        bool zetaLast)
    {
        Diagnose(BareMemberModel(SameContextGenuineMismatch, zetaLast))
            .ShouldContain(d => d.Code == DiagnosticCodes.ReadModelFieldTypeMismatch);
    }

    // The cross-context false-negative guard: `Idle` is declared ONLY by `Zeta.Phase`, invisible from
    // `Alpha`. The declared-type hint must not manufacture a match for a member `Status` never declares.
    private const string CrossContextGenuineMismatch = """
        context Alpha {
          enum Status { Draft Active }
          value Item { lifecycle: Status }
          readmodel ItemView from Item { stage: Status = Idle }
        }
        """;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Read_model_projecting_a_foreign_contexts_bare_member_still_reports_KOI1204(bool zetaLast)
    {
        Diagnose(BareMemberModel(CrossContextGenuineMismatch, zetaLast))
            .ShouldContain(d => d.Code == DiagnosticCodes.ReadModelFieldTypeMismatch);
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

    [Fact]
    public void Query_result_type_resolves_against_its_own_context_when_a_later_context_reuses_the_type_name()
    {
        // #1711 sibling: ValidateQuery's `index.Classify(resultName)` was flat and context-blind.
        // Other's later, differently-kinded "Summary" was overwriting Sales's own read model
        // "Summary" in ModelIndex's flat lookup, falsely rejecting a genuinely valid query.
        const string src = """
            context Sales {
              value Order { n: Int }
              readmodel Summary from Order { n }
              query Q(n: Int): Summary
            }

            context Other {
              value Summary { code: Int }
            }
            """;
        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.QueryResultNotReadModel);
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
