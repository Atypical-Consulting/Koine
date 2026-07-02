using Koine.Compiler.Ast;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Guards the scoping contract of <see cref="MemberAnalysis.ReferencedIdentifiers"/> — the
/// invariant the <c>ExprWalker</c> migration must preserve exactly: lambda parameters and
/// let-bound names are bound variables, not free references.
/// </summary>
public class AstVisitorTests
{
    private static IdentifierExpr Id(string name) => new(name);

    [Fact]
    public void ReferencedIdentifiers_excludes_lambda_parameter()
    {
        // lines.all(l => l.quantity > threshold)
        var expr = new CallExpr(
            Id("lines"),
            "all",
            new Expr[]
            {
                new LambdaExpr("l",
                    new BinaryExpr(BinaryOp.Gt,
                        new MemberAccessExpr(Id("l"), "quantity"),
                        Id("threshold")))
            });

        var free = MemberAnalysis.ReferencedIdentifiers(expr).ToHashSet();

        free.ShouldContain("lines");
        free.ShouldContain("threshold");
        free.ShouldNotContain("l"); // the lambda parameter is bound, not free
    }

    [Fact]
    public void ReferencedIdentifiers_let_binding_value_sees_only_earlier_bindings()
    {
        // let x = a, y = x + b in x + y
        var expr = new LetExpr(
            new[]
            {
                new LetBinding("x", Id("a")),
                new LetBinding("y", new BinaryExpr(BinaryOp.Add, Id("x"), Id("b")))
            },
            new BinaryExpr(BinaryOp.Add, Id("x"), Id("y")));

        var free = MemberAnalysis.ReferencedIdentifiers(expr).ToHashSet();

        free.ShouldBe(new HashSet<string> { "a", "b" });
        free.ShouldNotContain("x"); // bound by the let
        free.ShouldNotContain("y"); // bound by the let
    }

    [Fact]
    public void ReferencedIdentifiers_let_binding_value_cannot_see_its_own_name()
    {
        // let x = x in x  — the binding value's `x` is FREE (the binding is not yet in scope);
        // the body's `x` is bound.
        var expr = new LetExpr(
            new[] { new LetBinding("x", Id("x")) },
            Id("x"));

        var free = MemberAnalysis.ReferencedIdentifiers(expr).ToList();

        free.ShouldBe(new[] { "x" }); // exactly one free occurrence: the binding value
    }

    /// <summary>
    /// Regression: a LINQ-backed op (<c>any</c>) hidden inside a <c>let</c> must still be detected,
    /// so the generated file imports <c>System.Linq</c>. Before the exhaustive-visitor migration,
    /// the using-detection switch dropped <see cref="LetExpr"/> (and <see cref="CoalesceExpr"/>)
    /// via a silent <c>_ =&gt; false</c> fallback, so the emitted code failed to compile.
    /// </summary>
    [Fact]
    public void Linq_op_hidden_inside_let_still_imports_System_Linq()
    {
        const string src = """
            context LinqLet {
              value Bag {
                items: List<Int>
                hasPositive: Bool = let found = items.any(i => i > 0) in found
              }
            }
            """;

        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        result.Files.ShouldContain(f => f.Contents.Contains("using System.Linq;"));

        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
    }
}
