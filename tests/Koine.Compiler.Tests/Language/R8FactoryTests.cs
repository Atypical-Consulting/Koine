using System.Collections;
using System.Reflection;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>Epic R8 — Factories &amp; Lifecycle Creation.</summary>
public class R8FactoryTests
{
    private const string Fixture = """
        context Sales {
          value OrderLine { product: ProductId  quantity: Int }
          enum OrderStatus { Draft, Placed, Shipped, Cancelled }
          aggregate Sales root Order {
            entity Order identified by OrderId {
              customer: CustomerId
              lines:    List<OrderLine>
              status:   OrderStatus = Draft

              create forCustomer(customer: CustomerId, lines: List<OrderLine>) {
                requires !lines.isEmpty "cannot open an empty order"
                customer -> customer
                lines    -> lines
                emit OrderOpened(orderId: id, customer: customer, lineCount: lines.count)
              }
            }
            event OrderOpened {
              orderId:   OrderId
              customer:  CustomerId
              lineCount: Int
            }
          }
        }
        """;

    private static IReadOnlyList<Diagnostic> Diagnose(string source) => new KoineCompiler().Diagnose(source);

    private static Assembly Compile(string source = Fixture)
    {
        var result = new KoineCompiler().Compile(source, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        return asm;
    }

    private static object NewLine(Assembly asm)
    {
        var line = asm.GetType("Sales.OrderLine")!;
        var productId = asm.GetType("Sales.ProductId")!;
        return Activator.CreateInstance(line, productId.GetMethod("New")!.Invoke(null, null), 1)!;
    }

    private static IList Lines(Assembly asm, int count)
    {
        var line = asm.GetType("Sales.OrderLine")!;
        var list = (IList)Activator.CreateInstance(typeof(List<>).MakeGenericType(line))!;
        for (var i = 0; i < count; i++)
        {
            list.Add(NewLine(asm));
        }

        return list;
    }

    private static object InvokeFactory(Assembly asm, IList lines)
    {
        var order = asm.GetType("Sales.Order")!;
        var customerId = asm.GetType("Sales.CustomerId")!;
        var customer = customerId.GetMethod("New")!.Invoke(null, null);
        return order.GetMethod("ForCustomer")!.Invoke(null, new[] { customer, lines })!;
    }

    // ---- happy path --------------------------------------------------------

    [Fact]
    public void Fixture_is_valid_and_compiles()
    {
        Diagnose(Fixture).ShouldBeEmpty();
        Compile();
    }

    [Fact]
    public void Factory_produces_a_valid_aggregate_with_generated_identity()
    {
        var asm = Compile();
        var order = asm.GetType("Sales.Order")!;

        var o = InvokeFactory(asm, Lines(asm, 2));

        order.GetProperty("Id")!.GetValue(o).ShouldNotBeNull();
        TestSupport.EnumValue(asm.GetType("Sales.OrderStatus")!, "Draft")
            .Equals(order.GetProperty("Status")!.GetValue(o)).ShouldBeTrue();
        var lines = (IEnumerable)order.GetProperty("Lines")!.GetValue(o)!;
        lines.Cast<object>().Count().ShouldBe(2);
    }

    [Fact]
    public void Factory_generates_a_distinct_identity_each_call()
    {
        var asm = Compile();
        var order = asm.GetType("Sales.Order")!;

        var a = order.GetProperty("Id")!.GetValue(InvokeFactory(asm, Lines(asm, 1)));
        var b = order.GetProperty("Id")!.GetValue(InvokeFactory(asm, Lines(asm, 1)));
        b.ShouldNotBe(a);
    }

    [Fact]
    public void Factory_records_the_creation_event()
    {
        var asm = Compile();
        var order = asm.GetType("Sales.Order")!;

        var o = InvokeFactory(asm, Lines(asm, 3));

        var events = (IEnumerable)order.GetProperty("DomainEvents")!.GetValue(o)!;
        var list = events.Cast<object>().ToList();
        var evt = list.ShouldHaveSingleItem();
        evt.GetType().Name.ShouldBe("OrderOpened");
        evt.GetType().GetProperty("LineCount")!.GetValue(evt).ShouldBe(3);
    }

    [Fact]
    public void Factory_rejects_invalid_arguments_before_constructing()
    {
        var asm = Compile();

        var ex = Should.Throw<TargetInvocationException>(() => InvokeFactory(asm, Lines(asm, 0)));
        ex.InnerException!.GetType().Name.ShouldBe("DomainInvariantViolationException");
    }

    [Fact]
    public void Constructor_is_private_when_a_factory_exists()
    {
        var result = new KoineCompiler().Compile(Fixture, new CSharpEmitter());
        var order = result.Files.Single(f => f.RelativePath == "Sales/Order.cs").Contents;
        order.ShouldContain("private Order(");
        order.ShouldNotContain("public Order(");
        order.ShouldContain("public static Order ForCustomer(");
    }

    [Fact]
    public void Constructor_stays_public_without_a_factory()
    {
        const string src = "context C {\n  entity E identified by EId {\n    n: Int\n  }\n}\n";
        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        var e = result.Files.Single(f => f.RelativePath == "C/Entities/E.cs").Contents;
        e.ShouldContain("public E(");
        e.ShouldNotContain("private E(");
    }

    [Fact]
    public void Field_initialization_uses_named_constructor_arguments()
    {
        var result = new KoineCompiler().Compile(Fixture, new CSharpEmitter());
        var order = result.Files.Single(f => f.RelativePath == "Sales/Order.cs").Contents;
        order.ShouldContain("var id = OrderId.New();");
        order.ShouldContain("customer: customer");
        order.ShouldContain("lines: ");
        order.ShouldContain("return instance;");
    }

    // ---- diagnostics -------------------------------------------------------

    private const string Head = "context C {\n  entity E identified by EId {\n    n: Int\n";

    [Fact]
    public void Initialization_to_unknown_field_is_reported()
    {
        var src = Head + "    create make { bogus -> 1 }\n  }\n}\n";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.InvalidInitializationTarget);
    }

    [Fact]
    public void Initialization_of_derived_field_is_reported()
    {
        const string src =
            "context C {\n  entity E identified by EId {\n    n: Int\n    doubled: Int = n + n\n" +
            "    create make(v: Int) { n -> v  doubled -> 5 }\n  }\n}\n";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.InvalidInitializationTarget);
    }

    [Fact]
    public void Initialization_with_incompatible_type_is_reported()
    {
        var src = Head + "    create make { n -> \"x\" }\n  }\n}\n";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.InitializationTypeMismatch);
    }

    [Fact]
    public void Duplicate_initialization_is_reported()
    {
        var src = Head + "    create make(v: Int) { n -> v  n -> v }\n  }\n}\n";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.DuplicateInitialization);
    }

    [Fact]
    public void Duplicate_factory_name_is_reported()
    {
        var src = Head + "    create make(v: Int) { n -> v }\n    create make(v: Int) { n -> v }\n  }\n}\n";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.DuplicateFactory);
    }

    [Fact]
    public void Factory_colliding_with_a_property_is_reported()
    {
        var src = Head + "    create n(v: Int) { n -> v }\n  }\n}\n";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.FactoryNameCollision);
    }

    [Fact]
    public void Factory_colliding_with_a_command_is_reported()
    {
        var src = Head + "    command go { n -> 1 }\n    create go(v: Int) { n -> v }\n  }\n}\n";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.FactoryNameCollision);
    }

    [Fact]
    public void Uninitialized_required_field_is_warned()
    {
        // `name` is required (no default, not optional) and the factory never sets it.
        const string src =
            "context C {\n  entity E identified by EId {\n    n: Int\n    name: String\n" +
            "    create make(v: Int) { n -> v }\n  }\n}\n";
        var diags = Diagnose(src);
        diags.ShouldContain(d => d.Code == DiagnosticCodes.UninitializedFactoryField
            && d.Severity == DiagnosticSeverity.Warning);
    }

    [Fact]
    public void Required_field_initialized_by_factory_is_not_warned()
    {
        const string src =
            "context C {\n  entity E identified by EId {\n    n: Int\n    name: String\n" +
            "    create make(v: Int, label: String) { n -> v  name -> label }\n  }\n}\n";
        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.UninitializedFactoryField);
    }

    [Fact]
    public void Factory_parameter_is_resolvable_in_requires_and_initialization()
    {
        const string src =
            "context C {\n  entity E identified by EId {\n    n: Int\n" +
            "    create make(v: Int) {\n      requires v > 0 \"positive\"\n      n -> v\n    }\n  }\n}\n";
        Diagnose(src).ShouldBeEmpty();

        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
    }

    [Fact]
    public void Create_is_usable_as_a_field_name()
    {
        const string src = "context C {\n  value V {\n    create: Int\n  }\n}\n";
        Diagnose(src).ShouldBeEmpty();
    }

    // ---- regressions found by the R8 review --------------------------------

    [Fact]
    public void Factory_parameter_named_id_is_rejected()
    {
        // `id` collides with the auto-generated identity local in the emitted method.
        var src = Head + "    create make(id: Int) { n -> id }\n  }\n}\n";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.ReservedFactoryParameter);
    }

    [Fact]
    public void Factory_colliding_with_GetHashCode_is_reported()
    {
        // `create getHashCode` would emit `public static E GetHashCode()` alongside the
        // generated `public override int GetHashCode()` (CS0111).
        var src = Head + "    create getHashCode { n -> 1 }\n  }\n}\n";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.FactoryNameCollision);
    }

    [Fact]
    public void Same_named_parameter_auto_initializes_a_required_field()
    {
        // The canonical R8.1 example: a `customer` parameter populates the `customer`
        // field without an explicit `customer -> customer`, and no warning fires.
        const string src = """
            context Sales {
              value OrderLine { product: ProductId  quantity: Int }
              enum OrderStatus { Draft, Placed }
              aggregate Sales root Order {
                entity Order identified by OrderId {
                  customer: CustomerId
                  lines:    List<OrderLine>
                  status:   OrderStatus = Draft
                  create forCustomer(customer: CustomerId, lines: List<OrderLine>) {
                    emit OrderOpened(orderId: id, customer: customer, lineCount: lines.count)
                  }
                }
                event OrderOpened { orderId: OrderId  customer: CustomerId  lineCount: Int }
              }
            }
            """;
        Diagnose(src).ShouldBeEmpty();

        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        var order = result.Files.Single(f => f.RelativePath == "Sales/Order.cs").Contents;
        order.ShouldContain("customer: customer");   // auto-bound
        order.ShouldContain("lines: lines");         // auto-bound

        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));

        var orderType = asm.GetType("Sales.Order")!;
        var customerId = asm.GetType("Sales.CustomerId")!;
        var lineT = asm.GetType("Sales.OrderLine")!;
        var productId = asm.GetType("Sales.ProductId")!;
        var lines = (IList)Activator.CreateInstance(typeof(List<>).MakeGenericType(lineT))!;
        lines.Add(Activator.CreateInstance(lineT, productId.GetMethod("New")!.Invoke(null, null), 1));
        var o = orderType.GetMethod("ForCustomer")!.Invoke(null,
            new[] { customerId.GetMethod("New")!.Invoke(null, null), lines });

        orderType.GetProperty("Customer")!.GetValue(o).ShouldNotBeNull(); // not default!/null
    }

    [Fact]
    public void Value_object_sum_over_a_parameter_collection_compiles()
    {
        // `lines` is a PARAMETER, so the translator must know its element type to fold
        // a value-object sum with operator+ rather than emit a numeric .Sum().
        const string src = """
            context Sales {
              value Money  { amount: Decimal }
              value Line   { price: Money }
              aggregate Checkout root Cart {
                entity Cart identified by CartId {
                  total: Money
                  create forLines(lines: List<Line>) {
                    total -> lines.sum(l => l.price)
                  }
                }
              }
            }
            """;
        Diagnose(src).ShouldBeEmpty();

        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        var cart = result.Files.Single(f => f.RelativePath == "Sales/Cart.cs").Contents;
        cart.ShouldContain(".Aggregate((a, b) => a + b)"); // value-object fold, not .Sum
        cart.ShouldNotContain(".Sum(");

        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
    }

    [Fact]
    public void Empty_factory_body_parses_and_compiles()
    {
        // A factory with no statements still constructs (fields rely on defaults).
        const string src =
            "context C {\n  enum S { A, B }\n  entity E identified by EId {\n    s: S = A\n" +
            "    create make { }\n  }\n}\n";
        Diagnose(src).ShouldBeEmpty();

        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
    }

    // ---- arrow unification: `<-` merged into `->` --------------------------

    [Fact]
    public void Factory_initialization_uses_the_RARROW_arrow()
    {
        // After unifying the arrows, factory field init spells `field -> expr`, the same
        // `->` as a command transition; the create {} block disambiguates init from mutate.
        var src = Head + "    create make(v: Int) { n -> v }\n  }\n}\n";
        Diagnose(src).ShouldBeEmpty();

        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
    }

    [Fact]
    public void Old_LARROW_init_arrow_is_no_longer_a_valid_token()
    {
        // `<-` has been removed from the lexer; the legacy spelling must now be rejected.
        var src = Head + "    create make(v: Int) { n <- v }\n  }\n}\n";
        Diagnose(src).ShouldNotBeEmpty();
    }
}
