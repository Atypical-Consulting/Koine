using System.Reflection;
using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Expression-local bindings: <c>let x = e (, y = e)* in body</c>. The whole form
/// is an expression, so it nests anywhere a value is expected. Covered end-to-end:
/// parsing (AST shape), semantics (sequential scope, unknown-field, duplicates),
/// and emit (the lowered IIFE compiles with Roslyn and computes the right value).
/// </summary>
public class LetBindingTests
{
    private static IReadOnlyList<Diagnostic> Diagnose(string source) =>
        new KoineCompiler().Diagnose(source);

    private static Member SingleDerivedMember(string source, string typeName, string memberName)
    {
        var (model, diagnostics) = new KoineCompiler().Parse(source);
        diagnostics.ShouldBeEmpty();
        model.ShouldNotBeNull();
        var vo = model!.Contexts[0].Types.OfType<ValueObjectDecl>().Single(t => t.Name == typeName);
        return vo.Members.Single(m => m.Name == memberName);
    }

    // ---- Parsing -----------------------------------------------------------

    [Fact]
    public void Let_parses_into_a_LetExpr_with_bindings_and_body()
    {
        const string src = """
            context C {
              value V {
                unitPrice: Decimal
                quantity:  Int
                total: Decimal = let lineTotal = unitPrice * quantity in lineTotal
              }
            }
            """;

        var member = SingleDerivedMember(src, "V", "total");
        var let = member.Initializer.ShouldBeOfType<LetExpr>();
        var binding = let.Bindings.ShouldHaveSingleItem();
        binding.Name.ShouldBe("lineTotal");
        let.Body.ShouldBeOfType<IdentifierExpr>();
    }

    [Fact]
    public void Let_parses_multiple_comma_separated_bindings()
    {
        const string src = """
            context C {
              value V {
                a: Int
                b: Int
                result: Int = let x = a, y = b in x + y
              }
            }
            """;

        var member = SingleDerivedMember(src, "V", "result");
        var let = member.Initializer.ShouldBeOfType<LetExpr>();
        let.Bindings.Count.ShouldBe(2);
        let.Bindings.Select(b => b.Name).ShouldBe(new[] { "x", "y" });
    }

    [Fact]
    public void Let_is_an_expression_and_nests_in_a_parenthesized_conditional_branch()
    {
        // `let` is the lowest-precedence layer, so to sit inside a higher layer (a
        // conditional branch) it is parenthesized — `(...)` reduces back to a primary.
        const string src = """
            context C {
              value V {
                a: Int
                result: Int = if a > 0 then (let x = a in x + 1) else 0
              }
            }
            """;

        var member = SingleDerivedMember(src, "V", "result");
        var cond = member.Initializer.ShouldBeOfType<ConditionalExpr>();
        cond.Then.ShouldBeOfType<LetExpr>();
    }

    [Fact]
    public void Let_and_in_remain_usable_as_member_names()
    {
        // `let` / `in` are only reserved as a LEADING expression token; they stay
        // legal as field names (they are in declKeyword / softName).
        const string src = """
            context C {
              value V {
                let: Int
                in:  Int
              }
            }
            """;

        Diagnose(src).ShouldBeEmpty();
    }

    // ---- Semantics ---------------------------------------------------------

    [Fact]
    public void Binding_value_sees_earlier_bindings()
    {
        const string src = """
            context C {
              value V {
                a: Int
                result: Int = let x = a, y = x + 1 in y
              }
            }
            """;

        Diagnose(src).ShouldBeEmpty();
    }

    [Fact]
    public void Unknown_field_in_binding_value_is_reported()
    {
        const string src = """
            context C {
              value V {
                a: Int
                result: Int = let x = nope in x
              }
            }
            """;

        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.UnknownField);
    }

    [Fact]
    public void Binding_name_does_not_leak_out_of_the_let()
    {
        // `y` is only in scope inside the let body; using it outside is unknown.
        const string src = """
            context C {
              value V {
                a: Int
                result: Int = (let y = a in y) + y
              }
            }
            """;

        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.UnknownField);
    }

    [Fact]
    public void Duplicate_binding_name_is_reported()
    {
        const string src = """
            context C {
              value V {
                a: Int
                result: Int = let x = a, x = a in x
              }
            }
            """;

        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.DuplicateLetBinding);
    }

    [Fact]
    public void Body_is_type_checked_in_the_extended_scope()
    {
        // `x` is bound to an Int; a string op on it must still be rejected.
        const string src = """
            context C {
              value V {
                a: Int
                result: String = let x = a in x.trim
              }
            }
            """;

        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.StringOperationOnNonString);
    }

    // ---- Emit / Roslyn -----------------------------------------------------

    private const string EmitFixture = """
        context Let {
          value Pricing {
            unitPrice: Decimal
            quantity:  Int
            taxRate:   Decimal
            total: Decimal = let lineTotal = unitPrice * quantity, tax = lineTotal * taxRate in lineTotal + tax
          }
        }
        """;

    private static Assembly CompileEmitFixture()
    {
        var result = new KoineCompiler().Compile(EmitFixture, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        return asm!;
    }

    [Fact]
    public void Let_fixture_is_valid_and_compiles()
    {
        Diagnose(EmitFixture).ShouldBeEmpty();
        CompileEmitFixture();
    }

    [Fact]
    public void Let_lowering_computes_the_right_value_at_runtime()
    {
        var asm = CompileEmitFixture();
        var pricing = asm.GetType("Let.Pricing")!;

        // unitPrice 10, quantity 3 => lineTotal 30; taxRate 0.1 => tax 3 => total 33.
        var p = Activator.CreateInstance(pricing, 10m, 3, 0.1m);
        var total = pricing.GetProperty("Total")!.GetValue(p);
        ((decimal)total!).ShouldBe(33m);
    }

    [Fact]
    public void Let_preserves_sequential_evaluation_order()
    {
        // The second binding consumes the first; the runtime must honour the order.
        var asm = CompileEmitFixture();
        var pricing = asm.GetType("Let.Pricing")!;

        var p = Activator.CreateInstance(pricing, 4m, 5, 0.5m); // line 20, tax 10 => 30
        var total = pricing.GetProperty("Total")!.GetValue(p);
        ((decimal)total!).ShouldBe(30m);
    }
}
