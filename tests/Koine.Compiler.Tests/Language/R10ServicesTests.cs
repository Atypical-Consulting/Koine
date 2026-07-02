using System.Reflection;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>Epic R10 — Specifications, Domain Services &amp; Policies.</summary>
public class R10ServicesTests
{
    private static IReadOnlyList<Diagnostic> Diagnose(string source) => new KoineCompiler().Diagnose(source);

    private static (Assembly Asm, string Files) Compile(string source)
    {
        var result = new KoineCompiler().Compile(source, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        return (asm, TestSupport.Render(result.Files));
    }

    // ======================================================================
    // R10.1 — Specifications
    // ======================================================================

    private const string SpecSrc = """
        context Shop {
          value Order {
            lineCount: Int
            total:     Int
          }
          spec IsLarge on Order = lineCount > 10 || total > 1000
        }
        """;

    [Fact]
    public void Spec_emits_a_reusable_predicate_that_evaluates()
    {
        var (asm, files) = Compile(SpecSrc);
        files.ShouldContain("Shop/Specifications/ShopSpecifications.cs");

        var specs = asm.GetType("Shop.ShopSpecifications")!;
        var order = asm.GetType("Shop.Order")!;
        var isLarge = specs.GetMethod("IsLarge")!;

        var big = Activator.CreateInstance(order, 5, 2000);   // total > 1000
        var small = Activator.CreateInstance(order, 1, 1);
        ((bool)isLarge.Invoke(null, new[] { big })!).ShouldBeTrue();
        ((bool)isLarge.Invoke(null, new[] { small })!).ShouldBeFalse();
    }

    [Fact]
    public void Spec_referenced_in_an_invariant_is_enforced()
    {
        const string src = """
            context Shop {
              value Order {
                lineCount: Int
                total:     Int
                invariant IsLarge  "order must be large"
              }
              spec IsLarge on Order = lineCount > 10 || total > 1000
            }
            """;
        Diagnose(src).ShouldBeEmpty();
        var (asm, _) = Compile(src);
        var order = asm.GetType("Shop.Order")!;

        Activator.CreateInstance(order, 20, 1); // satisfies IsLarge
        var ex = Should.Throw<TargetInvocationException>(() => Activator.CreateInstance(order, 1, 1));
        ex.InnerException!.GetType().Name.ShouldBe("DomainInvariantViolationException");
    }

    [Fact]
    public void Specs_compose_by_name()
    {
        const string src = """
            context Shop {
              value Order { lineCount: Int  total: Int }
              spec HasLines  on Order = lineCount > 0
              spec IsBig     on Order = HasLines && total > 1000
            }
            """;
        Diagnose(src).ShouldBeEmpty();
        var (asm, _) = Compile(src);
        var specs = asm.GetType("Shop.ShopSpecifications")!;
        var order = asm.GetType("Shop.Order")!;
        var isBig = specs.GetMethod("IsBig")!;

        ((bool)isBig.Invoke(null, new[] { Activator.CreateInstance(order, 1, 2000) })!).ShouldBeTrue();
        ((bool)isBig.Invoke(null, new[] { Activator.CreateInstance(order, 0, 2000) })!).ShouldBeFalse(); // HasLines fails
    }

    [Fact]
    public void Spec_on_unknown_target_is_reported()
    {
        Diagnose("context C { spec X on Bogus = true }").ShouldContain(d => d.Code == DiagnosticCodes.SpecUnknownTarget);
    }

    [Fact]
    public void Non_boolean_spec_is_reported()
    {
        Diagnose("context C { value V { n: Int }  spec X on V = n }").ShouldContain(d => d.Code == DiagnosticCodes.SpecNotBoolean);
    }

    [Fact]
    public void Spec_cycle_is_reported()
    {
        const string src = "context C { value V { n: Int }  spec A on V = B  spec B on V = A }";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.SpecCycle);
    }

    [Fact]
    public void Self_referential_spec_is_reported()
    {
        Diagnose("context C { value V { n: Int }  spec A on V = A && n > 0 }").ShouldContain(d => d.Code == DiagnosticCodes.SpecCycle);
    }

    [Fact]
    public void Spec_colliding_with_a_member_is_reported()
    {
        Diagnose("context C { value V { active: Bool }  spec active on V = active }").ShouldContain(d => d.Code == DiagnosticCodes.DuplicateSpec);
    }

    // ======================================================================
    // R10.2 — Domain services
    // ======================================================================

    [Fact]
    public void Pure_operation_computes_its_result()
    {
        const string src = """
            context Fx {
              value Money { amount: Decimal }
              service ExchangeRateService {
                operation convert(amount: Money, rate: Decimal): Money = amount * rate
              }
            }
            """;
        Diagnose(src).ShouldBeEmpty();
        var (asm, _) = Compile(src);

        var svcType = asm.GetType("Fx.ExchangeRateService")!;
        var money = asm.GetType("Fx.Money")!;
        var svc = Activator.CreateInstance(svcType);
        var result = svcType.GetMethod("Convert")!.Invoke(svc, new[] { Activator.CreateInstance(money, 2.0m), 3.0m });
        money.GetProperty("Amount")!.GetValue(result).ShouldBe(6.0m);
    }

    private const string SpecInOperationSrc = """
        context Sales {
          value Order { lineCount: Int  total: Decimal }
          spec IsLarge on Order = lineCount > 10 || total > 1000
          service OrderRouting {
            operation isPriority(o: Order): Bool = o.IsLarge()
          }
        }
        """;

    [Fact]
    public void Spec_call_in_operation_body_emits_a_real_call()
    {
        // A service operation may invoke a declared spec on a parameter of the spec's
        // target type; it must translate to the generated extension-method call, not the
        // `/* unsupported call */` fallback — and the predicate must actually run.
        Diagnose(SpecInOperationSrc).ShouldBeEmpty();
        var (asm, files) = Compile(SpecInOperationSrc);
        files.ShouldContain("o.IsLarge()");
        files.ShouldNotContain("/* unsupported call");

        var svcType = asm.GetType("Sales.OrderRouting")!;
        var order = asm.GetType("Sales.Order")!;
        var svc = Activator.CreateInstance(svcType);
        var isPriority = svcType.GetMethod("IsPriority")!;

        var big = Activator.CreateInstance(order, 5, 2000m);   // total > 1000 -> IsLarge
        var small = Activator.CreateInstance(order, 1, 1m);
        ((bool)isPriority.Invoke(svc, new[] { big })!).ShouldBeTrue();
        ((bool)isPriority.Invoke(svc, new[] { small })!).ShouldBeFalse();
    }

    [Fact]
    public Task Spec_call_in_operation_body_emits_expected_csharp()
    {
        var result = new KoineCompiler().Compile(SpecInOperationSrc, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        return Verify(TestSupport.Render(result.Files))
            .UseDirectory("Snapshots");
    }

    [Fact]
    public void Spec_call_on_wrong_receiver_type_is_reported()
    {
        // `IsLarge` is a spec on Order; calling it on a Customer parameter must be flagged,
        // not silently accepted or reported as a generic unknown operation.
        const string src = """
            context Sales {
              value Order { lineCount: Int }
              value Customer { name: String }
              spec IsLarge on Order = lineCount > 10
              service OrderRouting {
                operation isPriority(c: Customer): Bool = c.IsLarge()
              }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.SpecCallTargetMismatch);
    }

    [Fact]
    public void Spec_call_on_a_lambda_parameter_emits_a_real_call()
    {
        // The receiver of a spec call may be a lambda parameter (os.any(o => o.IsLarge())); the
        // emitter must resolve its type the same way the validator does and emit the real call —
        // not the `/* unsupported call */` fallback (which would be invalid inside the lambda).
        const string src = """
            context Sales {
              value Order { lineCount: Int  total: Decimal }
              spec IsLarge on Order = lineCount > 10 || total > 1000
              service OrderRouting {
                operation anyPriority(os: List<Order>): Bool = os.any(o => o.IsLarge())
              }
            }
            """;
        Diagnose(src).ShouldBeEmpty();
        var (asm, files) = Compile(src);
        files.ShouldContain("o.IsLarge()");
        files.ShouldNotContain("/* unsupported call");

        var svcType = asm.GetType("Sales.OrderRouting")!;
        var order = asm.GetType("Sales.Order")!;
        var anyPriority = svcType.GetMethod("AnyPriority")!;
        var listType = typeof(List<>).MakeGenericType(order);

        var withBig = (System.Collections.IList)Activator.CreateInstance(listType)!;
        withBig.Add(Activator.CreateInstance(order, 5, 2000m));
        var allSmall = (System.Collections.IList)Activator.CreateInstance(listType)!;
        allSmall.Add(Activator.CreateInstance(order, 1, 1m));

        ((bool)anyPriority.Invoke(Activator.CreateInstance(svcType), new object?[] { withBig })!).ShouldBeTrue();
        ((bool)anyPriority.Invoke(Activator.CreateInstance(svcType), new object?[] { allSmall })!).ShouldBeFalse();
    }

    [Fact]
    public void Spec_call_as_a_let_body_compiles_and_runs()
    {
        // A spec call carries its Bool type, so a position that consumes the call's own type —
        // here a `let` body, emitted as an IIFE — generates compiling C# (not `Func<object>`).
        const string src = """
            context Sales {
              value Order { lineCount: Int  total: Decimal }
              spec IsLarge on Order = lineCount > 10 || total > 1000
              service OrderRouting {
                operation prio(o: Order): Bool = let x = o in x.IsLarge()
              }
            }
            """;
        Diagnose(src).ShouldBeEmpty();
        var (asm, files) = Compile(src); // Compile asserts the generated C# compiles
        files.ShouldNotContain("/* unsupported call");
        files.ShouldNotContain("Func<object>");

        var svcType = asm.GetType("Sales.OrderRouting")!;
        var order = asm.GetType("Sales.Order")!;
        var prio = svcType.GetMethod("Prio")!;
        ((bool)prio.Invoke(Activator.CreateInstance(svcType), new[] { Activator.CreateInstance(order, 20, 1m) })!).ShouldBeTrue();
        ((bool)prio.Invoke(Activator.CreateInstance(svcType), new[] { Activator.CreateInstance(order, 1, 1m) })!).ShouldBeFalse();
    }

    [Fact]
    public void Spec_call_with_a_wrong_return_type_is_reported()
    {
        // A spec call is Bool; declaring a non-Bool return type must be a return-type mismatch,
        // not silently accepted (which would have emitted non-compiling C#).
        const string src = """
            context Sales {
              value Order { lineCount: Int  total: Decimal }
              spec IsLarge on Order = lineCount > 10 || total > 1000
              service OrderRouting {
                operation isPriority(o: Order): Int = o.IsLarge()
              }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.ServiceReturnMismatch);
    }

    [Fact]
    public void Spec_call_on_an_entity_receiver_emits_a_real_call()
    {
        // Specs apply to entities too, not just value objects.
        const string src = """
            context Sales {
              entity Order identified by OrderId { lineCount: Int }
              spec IsLarge on Order = lineCount > 10
              service OrderRouting {
                operation isPriority(o: Order): Bool = o.IsLarge()
              }
            }
            """;
        Diagnose(src).ShouldBeEmpty();
        var (_, files) = Compile(src);
        files.ShouldContain("o.IsLarge()");
        files.ShouldNotContain("/* unsupported call");
    }

    [Fact]
    public void Spec_call_with_arguments_is_reported()
    {
        // A spec takes no arguments; calling one with args is an unknown operation, not a spec call.
        const string src = """
            context Sales {
              value Order { lineCount: Int }
              spec IsLarge on Order = lineCount > 10
              service OrderRouting {
                operation isPriority(o: Order): Bool = o.IsLarge(5)
              }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.UnknownOperation);
    }

    [Fact]
    public void Seam_operation_emits_an_abstract_class()
    {
        const string src = "context C { service Calc { operation run(a: Int): Int } }";
        Diagnose(src).ShouldBeEmpty();
        var (asm, files) = Compile(src);
        files.ShouldContain("public abstract class Calc");
        files.ShouldContain("public abstract int Run(int a);");
        asm.GetType("C.Calc")!.IsAbstract.ShouldBeTrue();
    }

    [Fact]
    public void Operation_return_type_mismatch_is_reported()
    {
        Diagnose("context C { service S { operation f(a: Int): String = a } }").ShouldContain(d => d.Code == DiagnosticCodes.ServiceReturnMismatch);
    }

    [Fact]
    public void Duplicate_operation_is_reported()
    {
        const string src = "context C { service S { operation f(a: Int): Int = a  operation f(b: Int): Int = b } }";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.DuplicateOperation);
    }

    [Fact]
    public void Service_is_usable_as_a_field_name()
    {
        Diagnose("context C { value V { service: Int  operation: Int } }").ShouldBeEmpty();
    }

    // ======================================================================
    // R10.3 — Policies
    // ======================================================================

    private const string PolicySrc = """
        context Sales {
          event OrderPlaced { orderId: OrderId }
          aggregate Stock root Inventory {
            entity Inventory identified by InventoryId {
              reserved: Int
              command reserve(order: OrderId) { reserved -> 1 }
            }
          }
          policy ReserveStock when OrderPlaced then Inventory.reserve(order: orderId)
        }
        """;

    [Fact]
    public void Policy_emits_a_handler_seam()
    {
        Diagnose(PolicySrc).ShouldBeEmpty();
        var (asm, files) = Compile(PolicySrc);

        files.ShouldContain("Sales/Policies/ReserveStockPolicy.cs");
        files.ShouldContain("public interface IReserveStockPolicy");
        files.ShouldContain("Task Handle(OrderPlaced e, CancellationToken ct = default);");
        files.ShouldContain("public abstract partial class ReserveStockPolicy : IReserveStockPolicy");
        files.ShouldContain("Inventory.reserve(order: e.OrderId)"); // intended-reaction sketch

        asm.GetType("Sales.IReserveStockPolicy")!.IsInterface.ShouldBeTrue();
        asm.GetType("Sales.ReserveStockPolicy")!.IsAbstract.ShouldBeTrue();
    }

    [Fact]
    public void Policy_on_unknown_event_is_reported()
    {
        const string src = """
            context Sales {
              aggregate Stock root Inventory {
                entity Inventory identified by InventoryId { n: Int  command reserve(order: OrderId) { n -> 1 } }
              }
              policy P when Nope then Inventory.reserve(order: orderId)
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.PolicyUnknownEvent);
    }

    [Fact]
    public void Policy_on_unknown_command_is_reported()
    {
        const string src = """
            context Sales {
              event OrderPlaced { orderId: OrderId }
              aggregate Stock root Inventory {
                entity Inventory identified by InventoryId { n: Int }
              }
              policy P when OrderPlaced then Inventory.bogus(order: orderId)
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.PolicyUnknownCommand);
    }

    [Fact]
    public void Policy_with_a_bad_argument_name_is_reported()
    {
        const string src = """
            context Sales {
              event OrderPlaced { orderId: OrderId }
              aggregate Stock root Inventory {
                entity Inventory identified by InventoryId { n: Int  command reserve(order: OrderId) { n -> 1 } }
              }
              policy P when OrderPlaced then Inventory.reserve(wrong: orderId)
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.PolicyArgMismatch);
    }

    [Fact]
    public void Duplicate_policy_is_reported()
    {
        const string src = """
            context Sales {
              event OrderPlaced { orderId: OrderId }
              aggregate Stock root Inventory {
                entity Inventory identified by InventoryId { n: Int  command reserve(order: OrderId) { n -> 1 } }
              }
              policy P when OrderPlaced then Inventory.reserve(order: orderId)
              policy P when OrderPlaced then Inventory.reserve(order: orderId)
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.DuplicatePolicy);
    }

    [Fact]
    public void Existing_fixtures_emit_no_R10_files()
    {
        // A spec/service/policy-free model produces no new files (back-compat).
        var (_, files) = Compile("context C { value V { n: Int } }");
        files.ShouldNotContain("Specifications.cs");
        files.ShouldNotContain("Policy.cs");
    }

    // ======================================================================
    // Regressions found by the R10 review
    // ======================================================================

    [Fact]
    public void Spec_with_a_collection_op_inlined_into_an_invariant_compiles()
    {
        // The inlined LINQ op must pull `using System.Linq;` into the value-object file.
        const string src = """
            context Shop {
              value Order {
                lines: List<Int>
                invariant AllPositive  "all lines must be positive"
              }
              spec AllPositive on Order = lines.all(l => l > 0)
            }
            """;
        Diagnose(src).ShouldBeEmpty();
        Compile(src); // asserts the generated C# compiles
    }

    [Fact]
    public void Spec_using_value_object_arithmetic_emits_the_operator()
    {
        // `price * quantity` inside a spec must make Money emit its scalar `*` operator.
        const string src = """
            context Sales {
              enum C { EUR }
              value Money { amount: Decimal  currency: C }
              value Line {
                price:    Money
                quantity: Int
                total:    Money
              }
              spec Consistent on Line = total == price * quantity
            }
            """;
        Diagnose(src).ShouldBeEmpty();
        Compile(src); // fails at C# compile if Money.operator* is missing
    }

    [Fact]
    public void Service_colliding_with_a_type_is_reported()
    {
        const string src = "context C { value Pricing { amount: Decimal }  service Pricing { operation noop(x: Decimal): Decimal = x } }";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.DuplicateType);
    }

    [Fact]
    public void Operation_named_like_its_service_is_reported()
    {
        const string src = "context C { service Tax { operation tax(x: Decimal): Decimal = x } }";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.DuplicateOperation);
    }

    [Fact]
    public void Spec_referenced_on_the_wrong_target_is_reported()
    {
        const string src = "context C { value A { n: Int  invariant IsB } value B { m: Int }  spec IsB on B = m > 0 }";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.SpecTargetMismatch);
    }
}
