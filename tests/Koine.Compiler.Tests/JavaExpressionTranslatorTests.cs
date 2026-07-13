using Koine.Compiler.Ast;
using Koine.Compiler.Services;

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
    private const string NoToolchainNotice =
        "No usable JDK 17+ toolchain (javac >= 17) available; javac not run. " +
        "Install a JDK 17+ (or set KOINE_JAVAC to a javac >= 17) — CI runs this for real.";

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

    // ---------------------------------------------------------------------------------------------
    // #1497 — local-binding shadow tracking (the Java half of the #1370 PopLocal-eviction bug class).
    // ---------------------------------------------------------------------------------------------

    /// <summary>
    /// A <c>let</c> that shadows a same-named MEMBER, with a second <c>let</c> shadowing it again:
    /// popping the inner binding must restore the OUTER LOCAL, not evict it.
    /// <para>
    /// The old flat <c>_locals</c>/<c>_localTypes</c> pair could only evict, so after the inner
    /// <c>let n = 20</c> popped, <c>n</c> stopped being a local at all — and the trailing <c>+ n</c>
    /// silently re-bound to the MEMBER, emitting the accessor call <c>this.n()</c>: the getter returned
    /// <c>base + 20 + this.n</c> instead of <c>base + 20 + 10</c>.
    /// </para>
    /// <para>
    /// Java's <c>WriteLambdaBody</c> had already hand-rolled a save/restore of both
    /// <c>wasPresent</c> and <c>hadType</c>, so its lambda path was mostly right — but it never applied
    /// the same care to <c>WriteLet</c>, and it still leaked when a name was bound with NO known type
    /// (neither restore branch fires). The shared <see cref="LocalScopeStack"/> makes both correct by
    /// construction, and that manual dance collapses to a plain push/pop.
    /// </para>
    /// <para>
    /// <b>Now asserted through a real <c>javac</c>, like the other four targets.</b> At the time this test
    /// was written Java — alone among the targets — forbade a lambda body from redeclaring a local of the
    /// enclosing scope, so this exact nested same-name <c>let</c> lowered to a <c>var n</c> that javac
    /// rejected outright ("variable n is already defined") no matter which binding the trailing <c>n</c>
    /// resolved to; a distinct, pre-existing lowering defect orthogonal to this local-tracking fix, tracked
    /// separately as #1536 and now fixed — the inner binding alpha-renames to <c>n$1</c> so both
    /// declarations are legal Java.
    /// </para>
    /// </summary>
    [Fact]
    public void NestedLetShadowingAMember_RestoresTheOuterLocal_NotTheMember()
    {
        const string src =
            """
            context Shop {
              value Money {
                n:    String
                base: Int
                calc: Int = base + (let n = 10 in (let n = 20 in n) + n)
              }
            }
            """;

        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var money = result.Files.Single(f => f.RelativePath.EndsWith("Money.java")).Contents;

        // The outer `n` must still resolve to the LOCAL `var n = 10L`, never to the member accessor, and
        // the inner binding now alpha-renames to `n$1` so both `var`s are legal Java (#1536).
        money.ShouldContain("var n$1 = 20L; return n$1; })).get() + n;");
        money.ShouldNotContain("+ this.n()");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    // ---------------------------------------------------------------------------------------------
    // #1536 — a nested same-name `let` (or one colliding with a command parameter) must alpha-rename
    // the inner binding so the emitted Java compiles: a lambda body may not redeclare a local of the
    // enclosing method (JLS §6.4), so two `var n` declarations are a hard javac error, not a shadow.
    // ---------------------------------------------------------------------------------------------

    /// <summary>
    /// A <c>let</c> whose name collides with a COMMAND PARAMETER hits the same javac redeclaration rule
    /// as the nested-<c>let</c> case, from a different collision source (#1536's second edge case): the
    /// parameter and the lambda-local share the method's declaration scope.
    /// </summary>
    [Fact]
    public void LetCollidingWithACommandParameter_AlphaRenamesTheLetBinding()
    {
        const string src =
            """
            context Shop {
              entity Order identified by OrderId {
                total: Int
                command adjust(n: Int) {
                  requires (let n = n + 1 in n) > 0 "n must stay positive"
                  total -> total + n
                }
              }
            }
            """;

        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var order = result.Files.Single(f => f.RelativePath.EndsWith("Order.java")).Contents;

        // The `let n = …` shadowing the `n` parameter must alpha-rename to `n$1`; its own value
        // expression (n + 1) still refers to the PARAMETER `n`, and its body echoes the renamed local.
        order.ShouldContain("var n$1 = n + 1L; return n$1; })).get() > 0L");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// A LAMBDA PARAMETER (a collection-op selector, e.g. <c>.any(n =&gt; …)</c>) is a local exactly like a
    /// <c>let</c> binding or a command parameter — so it must alpha-rename when it collides with an
    /// already-open outer local too, not only when a <c>let</c> collides with another <c>let</c>.
    /// </summary>
    [Fact]
    public void LambdaParameterCollidingWithAnOuterLet_AlphaRenamesTheLambdaParameter()
    {
        const string src =
            """
            context Shop {
              value Basket {
                items: List<Int>
                threshold: Int
                hasAboveThreshold: Bool = let n = threshold in items.any(n => n > 0) && n > 0
              }
            }
            """;

        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var basket = result.Files.Single(f => f.RelativePath.EndsWith("Basket.java")).Contents;

        // The lambda parameter `n` shadowing the outer `let n = threshold` must alpha-rename to `n$1`;
        // the trailing `n > 0` outside the lambda still refers to the OUTER let-bound `n`.
        basket.ShouldContain(".anyMatch(n$1 -> n$1 > 0L)");
        basket.ShouldContain(") && n > 0L");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Java's local-variable scope begins at its OWN initializer (JLS §6.3), so a <c>let</c> binding whose
    /// VALUE expression itself contains an unrelated nested <c>let</c> of the same name collides too — even
    /// though, in Koine's own scoping, the inner binding's scope never touches the outer one (it's fully
    /// confined to its own body, entirely inside the outer's value position).
    /// </summary>
    [Fact]
    public void LetWhoseOwnValueContainsANestedSameNameLet_AlphaRenamesTheInnerBinding()
    {
        const string src =
            """
            context Shop {
              value Money {
                base: Int
                calc: Int = let n = (let n = 10 in n) in base + n
              }
            }
            """;

        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var money = result.Files.Single(f => f.RelativePath.EndsWith("Money.java")).Contents;

        // The inner `let n = 10` — nested inside the OUTER `n`'s own value expression — must alpha-rename
        // to `n$1`; the outer `n` keeps its plain spelling.
        money.ShouldContain("var n$1 = 10L; return n$1;");
        money.ShouldContain("var n = ((java.util.function.Supplier<Long>)(() -> { var n$1 = 10L; return n$1; })).get();");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// A collision is a RENDERED-identifier collision, not a raw-Koine-name one: Koine identifiers are
    /// case-sensitive (<c>n</c> and <c>N</c> are distinct locals — <see cref="LocalScopeStackTests.NamesAreMatchedOrdinally"/>),
    /// but <see cref="JavaNaming.Member"/> folds a leading-uppercase name to the same camelCase spelling as
    /// its lowercase counterpart, so a nested <c>let N = …</c> under an outer <c>let n = …</c> renders the
    /// SAME Java identifier unless the collision check keys off the RENDERED name.
    /// </summary>
    [Fact]
    public void LetCollidingOnlyAfterJavaCasing_AlphaRenamesTheInnerBinding()
    {
        const string src =
            """
            context Shop {
              value Money {
                base: Int
                calc: Int = base + (let n = 10 in (let N = 20 in N) + n)
              }
            }
            """;

        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var money = result.Files.Single(f => f.RelativePath.EndsWith("Money.java")).Contents;

        // `N` renders to the same Java identifier `n` as the outer `let n = 10`, so it must alpha-rename
        // to `n$1` even though `n` and `N` are DIFFERENT Koine locals.
        money.ShouldContain("var n$1 = 20L; return n$1; })).get() + n;");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// A value object's COMPACT CONSTRUCTOR implicitly parameterizes over its own stored components (a
    /// record's components are bare parameters inside <c>public Money { ... }</c>), so an invariant's
    /// <c>let</c> binding that collides with a component name must alpha-rename exactly like it would
    /// against a command parameter — a collision source the initial fix missed (only command/factory
    /// parameters were reserved, not a value object's own record components).
    /// </summary>
    [Fact]
    public void LetCollidingWithAValueObjectsOwnComponent_AlphaRenamesTheLetBinding()
    {
        const string src =
            """
            context Shop {
              value Money {
                amount: Int
                invariant (let amount = 5 in amount) > 0 "must be positive"
              }
            }
            """;

        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var money = result.Files.Single(f => f.RelativePath.EndsWith("Money.java")).Contents;

        money.ShouldContain("var amount$1 = 5L; return amount$1;");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// An entity's DEFAULTED-MEMBER initializer translates inside the validating constructor
    /// (<c>NameMode.Parameter</c>, so it reads the constructor's own "id"/required-member parameters
    /// bare) — a <c>let</c> binding that collides with one of those parameters must alpha-rename, the
    /// same collision source as the value-object compact constructor, missed by the initial fix.
    /// </summary>
    [Fact]
    public void LetCollidingWithAnEntityConstructorParameter_AlphaRenamesTheLetBinding()
    {
        const string src =
            """
            context Shop {
              entity Order identified by OrderId {
                total: Int
                fee: Int = let total = 5 in total + 1
              }
            }
            """;

        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var order = result.Files.Single(f => f.RelativePath.EndsWith("Order.java")).Contents;

        order.ShouldContain("var total$1 = 5L; return total$1 + 1L;");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }
}
