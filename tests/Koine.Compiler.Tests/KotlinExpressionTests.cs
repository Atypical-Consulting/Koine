using Koine.Compiler.Ast;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// The Kotlin expression translator (issue #1066, Task 4): the pure Koine expression sublanguage lowered to
/// Kotlin 2.x expression text. Kotlin is more permissive than the Java sibling — <c>==</c> is structural for
/// every type (so <c>String</c>/enum/value-object equality needs no <c>Objects.equals</c>), coalesce is the
/// elvis <c>?:</c>, and <c>if</c> is an expression — with the one type-aware wrinkle being
/// <c>java.math.BigDecimal</c>, whose scale-sensitive <c>==</c> forces a <c>compareTo</c> lowering. These
/// tests pin those lowerings so the value-object / entity emitters (Tasks 5-8) get an operator-correct
/// translator to call.
/// </summary>
public class KotlinExpressionTests
{
    // A model index over an empty model — primitives (String/Int/Decimal/Bool/Instant) classify without any
    // declaration, which is all the type-directed operator lowering needs.
    private static readonly ModelIndex Index = new(new KoineModel(Array.Empty<ContextNode>()));

    // Representative typed members exercising every operator-vs-method decision the translator makes.
    private static readonly IReadOnlyList<Member> Members = new List<Member>
    {
        new("amount", new TypeRef("Decimal"), null),
        new("price", new TypeRef("Decimal"), null),
        new("tax", new TypeRef("Decimal"), null),
        new("quantity", new TypeRef("Int"), null),
        new("minimum", new TypeRef("Int"), null),
        new("active", new TypeRef("Bool"), null),
        new("currency", new TypeRef("String"), null),
        new("email", new TypeRef("String"), null),
        new("code", new TypeRef("String"), null),
        new("name", new TypeRef("String"), null),
        new("description", new TypeRef("String", IsOptional: true), null),
        new("discount", new TypeRef("Int", IsOptional: true), null),
        new("amounts", new TypeRef("List", new TypeRef("Int")), null),
    };

    private static KotlinExpressionTranslator NewTranslator() => new(Index, Members, new KotlinTypeMapper(Index));

    private static ModelIndex CompileIndex(string source)
    {
        var result = new KoineCompiler().Compile(source, new CSharpEmitter());
        return new SemanticModel(result.Model!).Index;
    }

    private static IdentifierExpr Id(string name) => new(name);

    private static LiteralExpr Int(string text) => new(LiteralKind.Int, text);

    [Fact]
    public void Decimal_comparison_and_null_check()
    {
        // amount > 0 && currency != null  (amount: Decimal, currency: String)
        var expr = new BinaryExpr(
            BinaryOp.And,
            new BinaryExpr(BinaryOp.Gt, Id("amount"), Int("0")),
            new BinaryExpr(BinaryOp.Neq, Id("currency"), Id("null")));

        // The Decimal `> 0` lowers to compareTo against BigDecimal.ZERO; the `!= null` stays a Kotlin null
        // check (structural `!=` is null-safe).
        NewTranslator().Translate(expr)
            .ShouldBe("amount.compareTo(java.math.BigDecimal.ZERO) > 0 && currency != null");
    }

    [Fact]
    public void Matches_lowers_to_an_unanchored_Regex_containsMatchIn()
    {
        // email matches /^[^@]+@[^@]+$/ -> Kotlin unanchored search (NOT full-anchored `.matches()`). The
        // `$` end-anchor is escaped (`\$`) so Kotlin reads it literally rather than as a string template.
        NewTranslator().Translate(new MatchExpr(Id("email"), "^[^@]+@[^@]+$"))
            .ShouldBe("Regex(\"^[^@]+@[^@]+\\$\").containsMatchIn(email)");
    }

    [Fact]
    public void Long_comparison_stays_a_plain_operator()
    {
        // quantity > minimum  (both Int -> Long)
        NewTranslator().Translate(new BinaryExpr(BinaryOp.Gt, Id("quantity"), Id("minimum")))
            .ShouldBe("quantity > minimum");
    }

    [Fact]
    public void Decimal_addition_lowers_to_the_add_method()
    {
        // price + tax  (both Decimal)
        NewTranslator().Translate(new BinaryExpr(BinaryOp.Add, Id("price"), Id("tax")))
            .ShouldBe("price.add(tax)");
    }

    [Fact]
    public void Decimal_equality_lowers_to_a_compareTo_equality()
    {
        // price == amount  (both Decimal) -> value equality via compareTo, NOT the scale-sensitive
        // BigDecimal.equals that Kotlin `==` would call.
        NewTranslator().Translate(new BinaryExpr(BinaryOp.Eq, Id("price"), Id("amount")))
            .ShouldBe("price.compareTo(amount) == 0");
    }

    [Fact]
    public void String_equality_is_structural_kotlin_equals()
    {
        // currency == email  (both String) -> Kotlin `==` is content equality; no Objects.equals ceremony.
        NewTranslator().Translate(new BinaryExpr(BinaryOp.Eq, Id("currency"), Id("email")))
            .ShouldBe("currency == email");
    }

    [Fact]
    public void Property_mode_reads_members_as_properties_without_parentheses()
    {
        // In an entity method / computed-property body a member reads as `this.name` — no accessor `()`.
        var expr = new BinaryExpr(BinaryOp.Gt, Id("amount"), Int("0"));

        NewTranslator().Translate(expr, KotlinExpressionTranslator.NameMode.Property)
            .ShouldBe("this.amount.compareTo(java.math.BigDecimal.ZERO) > 0");
    }

    [Fact]
    public void Decimal_int_operand_is_coerced_with_BigDecimal_valueOf()
    {
        // amount + quantity  (Decimal + Int) -> the Int side is widened to BigDecimal via valueOf.
        NewTranslator().Translate(new BinaryExpr(BinaryOp.Add, Id("amount"), Id("quantity")))
            .ShouldBe("amount.add(java.math.BigDecimal.valueOf(quantity))");
    }

    [Fact]
    public void Coalesce_lowers_to_the_elvis_operator()
    {
        // description ?? name  (description: String?) -> Kotlin elvis.
        NewTranslator().Translate(new CoalesceExpr(Id("description"), Id("name")))
            .ShouldBe("description ?: name");
    }

    [Fact]
    public void Conditional_lowers_to_a_kotlin_if_expression()
    {
        // if active then quantity else minimum
        NewTranslator().Translate(new ConditionalExpr(Id("active"), Id("quantity"), Id("minimum")))
            .ShouldBe("if (active) quantity else minimum");
    }

    [Fact]
    public void Member_access_string_ops_lower_to_kotlin_stdlib()
    {
        // code.trim.length > 0 -> `.trim()`, `.length.toLong()`, and a Long literal `0L`.
        var trimLength = new MemberAccessExpr(new MemberAccessExpr(Id("code"), "trim"), "length");

        NewTranslator().Translate(new BinaryExpr(BinaryOp.Gt, trimLength, Int("0")))
            .ShouldBe("code.trim().length.toLong() > 0L");
    }

    // --- Precedence: Kotlin's low-precedence lowerings must parenthesize as sub-expressions (code-review) ---

    [Fact]
    public void Coalesce_as_a_binary_operand_is_parenthesized()
    {
        // (discount ?? 0) * quantity — elvis `?:` is lower precedence than `*`, so the coalesce must be
        // parenthesized or Kotlin parses it as `discount ?: (0 * quantity)`.
        var expr = new BinaryExpr(BinaryOp.Mul, new CoalesceExpr(Id("discount"), Int("0")), Id("quantity"));

        NewTranslator().Translate(expr).ShouldBe("(discount ?: 0L) * quantity");
    }

    [Fact]
    public void Conditional_as_a_binary_operand_is_parenthesized()
    {
        // (if active then 2 else 1) * quantity — an `if/else` expression greedily extends its else-branch,
        // so it must be parenthesized as an operand.
        var expr = new BinaryExpr(BinaryOp.Mul, new ConditionalExpr(Id("active"), Int("2"), Int("1")), Id("quantity"));

        NewTranslator().Translate(expr).ShouldBe("(if (active) 2L else 1L) * quantity");
    }

    [Fact]
    public void Min_and_max_folds_as_binary_operands_are_parenthesized()
    {
        // amounts.max(x => x) - amounts.min(x => x) — each fold lowers to `… ?: throw …` (low precedence),
        // so both operands of the subtraction must be parenthesized to group correctly.
        var expr = new BinaryExpr(
            BinaryOp.Sub,
            new CallExpr(Id("amounts"), "max", new Expr[] { new LambdaExpr("x", Id("x")) }),
            new CallExpr(Id("amounts"), "min", new Expr[] { new LambdaExpr("x", Id("x")) }));

        var kotlin = NewTranslator().Translate(expr);
        kotlin.ShouldStartWith("(amounts.map { x -> x }.maxOrNull() ?: throw ");
        kotlin.ShouldContain(") - (amounts.map { x -> x }.minOrNull() ?: throw ");
        kotlin.ShouldEndWith(")");
    }

    [Fact]
    public void Coalesce_at_top_level_is_not_parenthesized()
    {
        // A top-level coalesce (e.g. a derived-member body) needs no wrapping — the fix only parenthesizes
        // a coalesce that is a SUB-expression.
        NewTranslator().Translate(new CoalesceExpr(Id("description"), Id("name"))).ShouldBe("description ?: name");
    }

    [Fact]
    public void Value_object_times_scalar_lowers_to_the_times_method()
    {
        // unitPrice * quantity  where unitPrice is a value object and quantity a scalar Int.
        var index = CompileIndex("context C { value Money { amount: Decimal } }");
        var members = new List<Member>
        {
            new("unitPrice", new TypeRef("Money"), null),
            new("quantity", new TypeRef("Int"), null),
        };
        var translator = new KotlinExpressionTranslator(index, members, new KotlinTypeMapper(index), context: "C");

        translator.Translate(new BinaryExpr(BinaryOp.Mul, Id("unitPrice"), Id("quantity")))
            .ShouldBe("unitPrice.times(quantity)");
    }
}
