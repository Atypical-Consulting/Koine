using Koine.Compiler.Ast;

namespace Koine.Compiler.Tests;

/// <summary>
/// The Java expression translator (issue #858, Task 3): the pure Koine expression sublanguage lowered to
/// Java 17 expression text. The Java-specific crux is that reference types have <b>no operators</b> — a
/// <c>Decimal</c> (<c>java.math.BigDecimal</c>) comparison lowers to <c>compareTo</c>, its arithmetic to
/// <c>add</c>/<c>subtract</c>/…, and object equality to <c>Objects.equals</c> — while <c>long</c>/<c>boolean</c>
/// keep plain Java operators. These tests pin those lowerings so the value-object / entity emitters
/// (Tasks 4/6) get an operator-correct translator to call.
/// </summary>
public class JavaExpressionTranslatorTests
{
    // A model index over an empty model — primitives (String/Int/Decimal/Bool/Instant) classify without
    // any declaration, which is all the type-directed operator lowering needs.
    private static readonly ModelIndex Index = new(new KoineModel(Array.Empty<ContextNode>()));

    // Representative typed members: two Decimals, two Ints, two Strings — enough to exercise every
    // operator-vs-method decision the translator makes.
    private static readonly IReadOnlyList<Member> Members = new List<Member>
    {
        new("amount", new TypeRef("Decimal"), null),
        new("price", new TypeRef("Decimal"), null),
        new("tax", new TypeRef("Decimal"), null),
        new("quantity", new TypeRef("Int"), null),
        new("minimum", new TypeRef("Int"), null),
        new("currency", new TypeRef("String"), null),
        new("email", new TypeRef("String"), null),
    };

    private static JavaExpressionTranslator NewTranslator() => new(Index, Members, new JavaTypeMapper(Index));

    private static IdentifierExpr Id(string name) => new(name);

    private static LiteralExpr Int(string text) => new(LiteralKind.Int, text);

    [Fact]
    public void Decimal_comparison_and_null_check_lower_to_compareTo_and_reference_inequality()
    {
        // amount > 0 && currency != null  (amount: Decimal, currency: String)
        var expr = new BinaryExpr(
            BinaryOp.And,
            new BinaryExpr(BinaryOp.Gt, Id("amount"), Int("0")),
            new BinaryExpr(BinaryOp.Neq, Id("currency"), Id("null")));

        var java = NewTranslator().Translate(expr, JavaExpressionTranslator.NameMode.Parameter);

        // The Decimal `> 0` lowers to compareTo against BigDecimal.ZERO; the `!= null` stays reference
        // inequality (comparing a reference to the null literal is correct in Java).
        java.ShouldBe("amount.compareTo(java.math.BigDecimal.ZERO) > 0 && currency != null");
    }

    [Fact]
    public void Matches_lowers_to_an_unanchored_Pattern_find()
    {
        // email matches /^[^@]+@[^@]+$/
        var expr = new MatchExpr(Id("email"), "^[^@]+@[^@]+$");

        var java = NewTranslator().Translate(expr, JavaExpressionTranslator.NameMode.Parameter);

        java.ShouldBe("java.util.regex.Pattern.compile(\"^[^@]+@[^@]+$\").matcher(email).find()");
    }

    [Fact]
    public void Long_comparison_stays_a_plain_operator()
    {
        // quantity > minimum  (both Int -> long)
        var expr = new BinaryExpr(BinaryOp.Gt, Id("quantity"), Id("minimum"));

        var java = NewTranslator().Translate(expr, JavaExpressionTranslator.NameMode.Parameter);

        java.ShouldBe("quantity > minimum");
    }

    [Fact]
    public void Decimal_addition_lowers_to_the_add_method()
    {
        // price + tax  (both Decimal)
        var expr = new BinaryExpr(BinaryOp.Add, Id("price"), Id("tax"));

        var java = NewTranslator().Translate(expr, JavaExpressionTranslator.NameMode.Parameter);

        java.ShouldBe("price.add(tax)");
    }

    [Fact]
    public void Decimal_equality_lowers_to_a_compareTo_equality()
    {
        // price == amount  (both Decimal) -> value equality via compareTo, NOT BigDecimal.equals
        // (BigDecimal.equals is scale-sensitive; compareTo == 0 is the money-safe comparison).
        var expr = new BinaryExpr(BinaryOp.Eq, Id("price"), Id("amount"));

        var java = NewTranslator().Translate(expr, JavaExpressionTranslator.NameMode.Parameter);

        java.ShouldBe("price.compareTo(amount) == 0");
    }

    [Fact]
    public void String_equality_between_two_references_lowers_to_Objects_equals()
    {
        // currency == email  (both String, neither is the null literal) -> null-safe Objects.equals,
        // never reference `==` (which would be a bug on Java objects).
        var expr = new BinaryExpr(BinaryOp.Eq, Id("currency"), Id("email"));

        var java = NewTranslator().Translate(expr, JavaExpressionTranslator.NameMode.Parameter);

        java.ShouldBe("java.util.Objects.equals(currency, email)");
    }

    [Fact]
    public void Property_mode_renders_record_components_as_accessor_calls()
    {
        // In a record accessor / entity method the member is read through its accessor: this.amount().
        var translator = new JavaExpressionTranslator(
            Index, Members, new JavaTypeMapper(Index), context: null, memberReceiver: "this", membersAsAccessors: true);

        var expr = new BinaryExpr(BinaryOp.Gt, Id("amount"), Int("0"));

        var java = translator.Translate(expr, JavaExpressionTranslator.NameMode.Property);

        java.ShouldBe("this.amount().compareTo(java.math.BigDecimal.ZERO) > 0");
    }

    [Fact]
    public void Decimal_int_operand_is_coerced_with_BigDecimal_valueOf()
    {
        // amount + quantity  (Decimal + Int) -> the Int side is widened to BigDecimal via valueOf.
        var expr = new BinaryExpr(BinaryOp.Add, Id("amount"), Id("quantity"));

        var java = NewTranslator().Translate(expr, JavaExpressionTranslator.NameMode.Parameter);

        java.ShouldBe("amount.add(java.math.BigDecimal.valueOf(quantity))");
    }
}
