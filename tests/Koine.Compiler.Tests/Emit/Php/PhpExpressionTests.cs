using Koine.Compiler.Ast;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Unit tests for <see cref="PhpExpressionTranslator"/> — the pure translation of the
/// target-agnostic <see cref="Expr"/> sublanguage into PHP expression source. PHP uses
/// NATIVE operators (<c>+ - * / &lt; &lt;= === …</c> and <c>&amp;&amp;</c>/<c>||</c>/<c>!</c>)
/// throughout. Member identifiers render as <c>$this-&gt;camelProp</c> (Property mode) or bare
/// <c>$camelParam</c> (Parameter mode). Decimal literals construct via the runtime class.
/// </summary>
public class PhpExpressionTests
{
    // A model exercising a Decimal collection (for sum/min/max), a string, a list, and an enum,
    // so the translator's type-driven branches are reachable.
    private const string Source =
        """
        context Shop {
          enum OrderStatus { Draft, Placed, Cancelled }
          enum MassUnit { Gram, Kilogram }

          value Money {
            amount: Decimal
            discount: Decimal?
          }

          quantity Weight {
            amount: Decimal
            unit:   MassUnit
          }

          value Order {
            code: String
            quantity: Int
            status: OrderStatus
            note: String?
            price: Decimal
            limit: Decimal
            weight: Weight
            otherWeight: Weight
            prices: List<Decimal>
            lines: List<Money>
            tags: List<String>
            counts: List<Int>
          }

          aggregate Cart root Basket {
            entity CartLine identified by CartLineId {
              sku: String
              qty: Int
            }
            entity Basket identified by BasketId {
              items: List<CartLine>
            }
          }
        }
        """;

    private static PhpExpressionTranslator Make()
    {
        var result = new KoineCompiler().Compile(Source, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var model = result.Model!;
        var semantic = new SemanticModel(model);
        ModelIndex index = semantic.Index;

        var order = model.Contexts
            .SelectMany(c => c.AllTypeDecls())
            .OfType<ValueObjectDecl>()
            .First(v => v.Name == "Order");

        var translator = new PhpExpressionTranslator(
            index, order.Members, index.EnumMemberToType, context: "Shop");
        return translator;
    }

    private static string Translate(Expr expr)
    {
        var t = Make();
        return t.Translate(expr);
    }

    // A translator carrying the neutral RegexMatchTimeoutMs author intent (#812). PHP can't honor a
    // wall-clock timeout, so a `matches` guard annotates the emitted preg_match with the PCRE substitute.
    private static PhpExpressionTranslator MakeWithTimeout(int milliseconds)
    {
        var result = new KoineCompiler().Compile(Source, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var model = result.Model!;
        var semantic = new SemanticModel(model);
        ModelIndex index = semantic.Index;

        var order = model.Contexts
            .SelectMany(c => c.AllTypeDecls())
            .OfType<ValueObjectDecl>()
            .First(v => v.Name == "Order");

        return new PhpExpressionTranslator(
            index, order.Members, index.EnumMemberToType, context: "Shop", regexMatchTimeoutMs: milliseconds);
    }

    // A translator whose member scope is an entity (rather than the Order value object), so a
    // selector projecting to an entity type — e.g. distinctBy(i => i) over List<CartLine> — is
    // reachable. CartLine/Basket are child/root entities of the Cart aggregate above.
    private static PhpExpressionTranslator MakeForEntity(string entityName)
    {
        var result = new KoineCompiler().Compile(Source, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var model = result.Model!;
        var semantic = new SemanticModel(model);
        ModelIndex index = semantic.Index;

        var entity = model.Contexts
            .SelectMany(c => c.AllTypeDecls())
            .OfType<EntityDecl>()
            .First(e => e.Name == entityName);

        return new PhpExpressionTranslator(
            index, entity.Members, index.EnumMemberToType, context: "Shop");
    }

    private static IdentifierExpr Id(string name) => new(name);
    private static MemberAccessExpr Member(string target, string member) => new(Id(target), member);
    private static LiteralExpr Int(string text) => new(LiteralKind.Int, text);
    private static LiteralExpr Decimal(string text) => new(LiteralKind.Decimal, text);
    private static LiteralExpr Bool(bool b) => new(LiteralKind.Bool, b ? "true" : "false");

    // =========================================================================
    // Boolean operators
    // =========================================================================

    [Fact]
    public void And_lowers_to_php_and()
    {
        var expr = new BinaryExpr(BinaryOp.And, Id("a"), Id("b"));
        // `a`/`b` are not members, so they fall through to bare camelCase identifiers with $ prefix.
        Translate(expr).ShouldBe("($a && $b)");
    }

    [Fact]
    public void Or_lowers_to_php_or()
    {
        var expr = new BinaryExpr(BinaryOp.Or, Id("a"), Id("b"));
        Translate(expr).ShouldBe("($a || $b)");
    }

    [Fact]
    public void Not_lowers_to_php_bang()
    {
        var expr = new UnaryExpr(UnaryOp.Not, Id("a"));
        Translate(expr).ShouldBe("!($a)");
    }

    // =========================================================================
    // Comparison — native operators, member as $this->camelProp
    // =========================================================================

    [Fact]
    public void Comparison_member_renders_this_arrow_property()
    {
        var expr = new BinaryExpr(BinaryOp.Ge, Id("quantity"), Int("1"));
        Translate(expr).ShouldBe("($this->quantity >= 1)");
    }

    [Fact]
    public void Comparison_member_in_parameter_mode_is_dollar_var()
    {
        var t = Make();
        var expr = new BinaryExpr(BinaryOp.Ge, Id("quantity"), Int("1"));
        t.Translate(expr, PhpExpressionTranslator.NameMode.Parameter).ShouldBe("($quantity >= 1)");
    }

    [Fact]
    public void Equality_uses_strict_triple_equals()
    {
        var expr = new BinaryExpr(BinaryOp.Eq, Id("quantity"), Int("0"));
        Translate(expr).ShouldBe("($this->quantity === 0)");
    }

    [Fact]
    public void Inequality_uses_strict_not_equals()
    {
        var expr = new BinaryExpr(BinaryOp.Neq, Id("quantity"), Int("0"));
        Translate(expr).ShouldBe("($this->quantity !== 0)");
    }

    // =========================================================================
    // Decimal operands — PHP has no operator overloading, so native operators on a
    // runtime Decimal are invalid; comparisons go through compareTo()/equals() and
    // arithmetic through add()/sub()/mul()/div(). A non-Decimal operand is wrapped.
    // =========================================================================

    [Fact]
    public void Decimal_comparison_against_int_literal_lowers_to_compareTo()
    {
        // `price >= 0` where price is Decimal -> price->compareTo(new Decimal('0')) >= 0
        var expr = new BinaryExpr(BinaryOp.Ge, Id("price"), Int("0"));
        Translate(expr).ShouldBe("($this->price->compareTo((new \\Koine\\Runtime\\Decimal('0'))) >= 0)");
    }

    [Fact]
    public void Decimal_less_than_lowers_to_compareTo()
    {
        var expr = new BinaryExpr(BinaryOp.Lt, Id("price"), Int("0"));
        Translate(expr).ShouldBe("($this->price->compareTo((new \\Koine\\Runtime\\Decimal('0'))) < 0)");
    }

    [Fact]
    public void Decimal_comparison_against_decimal_operand_uses_it_directly()
    {
        // `price < limit` where both are Decimal -> no wrapping of the right operand.
        var expr = new BinaryExpr(BinaryOp.Lt, Id("price"), Id("limit"));
        Translate(expr).ShouldBe("($this->price->compareTo($this->limit) < 0)");
    }

    [Fact]
    public void Decimal_equality_lowers_to_equals()
    {
        // The Decimal-literal argument to `equals(...)` is parenthesised — `(new \…\Decimal('0'))` —
        // uniformly, matching the int-literal argument to `compareTo(...)` above (#907 brings the
        // IsDecimal-early-return arm in line with #815/#849's uniform wrap). Parens in argument
        // position are harmless valid PHP; only the receiver position actually requires them.
        var eq = new BinaryExpr(BinaryOp.Eq, Id("price"), Decimal("0"));
        var ne = new BinaryExpr(BinaryOp.Neq, Id("price"), Decimal("0"));
        Translate(eq).ShouldBe("$this->price->equals((new \\Koine\\Runtime\\Decimal('0')))");
        Translate(ne).ShouldBe("!$this->price->equals((new \\Koine\\Runtime\\Decimal('0')))");
    }

    [Fact]
    public void Decimal_arithmetic_lowers_to_method_calls()
    {
        Translate(new BinaryExpr(BinaryOp.Add, Id("price"), Id("limit"))).ShouldBe("$this->price->add($this->limit)");
        Translate(new BinaryExpr(BinaryOp.Sub, Id("price"), Id("limit"))).ShouldBe("$this->price->sub($this->limit)");
        Translate(new BinaryExpr(BinaryOp.Mul, Id("price"), Id("limit"))).ShouldBe("$this->price->mul($this->limit)");
        Translate(new BinaryExpr(BinaryOp.Div, Id("price"), Id("limit"))).ShouldBe("$this->price->div($this->limit)");
    }

    [Fact]
    public void Int_literal_left_of_Decimal_arithmetic_parenthesises_new_chaining()
    {
        // When an int literal is on the LEFT of Decimal arithmetic, WriteAsDecimal wraps it in
        // `new \Koine\Runtime\Decimal('n')` which then becomes the method RECEIVER.
        // Without surrounding parentheses, bare `new X(...)->m()` is PHP 8.4+-only syntax;
        // the emitter targets PHP 8.1+, so the construction must be parenthesised.
        // All four arithmetic operators go through the same code path — verify all.
        Translate(new BinaryExpr(BinaryOp.Add, Int("5"), Id("price")))
            .ShouldBe("(new \\Koine\\Runtime\\Decimal('5'))->add($this->price)");
        Translate(new BinaryExpr(BinaryOp.Sub, Int("5"), Id("price")))
            .ShouldBe("(new \\Koine\\Runtime\\Decimal('5'))->sub($this->price)");
        Translate(new BinaryExpr(BinaryOp.Mul, Int("5"), Id("price")))
            .ShouldBe("(new \\Koine\\Runtime\\Decimal('5'))->mul($this->price)");
        Translate(new BinaryExpr(BinaryOp.Div, Int("5"), Id("price")))
            .ShouldBe("(new \\Koine\\Runtime\\Decimal('5'))->div($this->price)");
    }

    [Fact]
    public void Decimal_arithmetic_wraps_int_operand_in_decimal()
    {
        // `price * quantity` (Decimal * Int) -> wrap the Int operand as a Decimal expression. The
        // wrapper is now parenthesised uniformly (#849) even here, in argument position, where the
        // parens are harmless — only the receiver position (see below) actually requires them.
        var expr = new BinaryExpr(BinaryOp.Mul, Id("price"), Id("quantity"));
        Translate(expr).ShouldBe("$this->price->mul((new \\Koine\\Runtime\\Decimal($this->quantity)))");
    }

    [Fact]
    public void Int_member_left_of_Decimal_arithmetic_parenthesises_new_chaining()
    {
        // When an Int MEMBER (not a literal) is on the LEFT of Decimal arithmetic, WriteAsDecimal's
        // fallthrough arm wraps it in `new \Koine\Runtime\Decimal($this->quantity)` which then becomes
        // the method RECEIVER. Without surrounding parentheses, bare `new X(...)->m()` is
        // PHP 8.4+-only syntax; the emitter targets PHP 8.1+, so the construction must be parenthesised
        // (issue #849 — the fallthrough-arm sibling of #815/#844's int-literal fix).
        var expr = new BinaryExpr(BinaryOp.Add, Id("quantity"), Id("price"));
        Translate(expr).ShouldBe("(new \\Koine\\Runtime\\Decimal($this->quantity))->add($this->price)");
    }

    [Fact]
    public void Decimal_literal_left_of_arithmetic_parenthesises_new_chaining()
    {
        // When a Decimal LITERAL (not an int literal, not a member) is on the LEFT of arithmetic,
        // WriteAsDecimal's IsDecimal(t) early-return arm writes it as-is via WriteLiteral, which emits
        // a bare `new \Koine\Runtime\Decimal('5')`. That literal then becomes the method RECEIVER, so
        // without surrounding parentheses the emitted `new X(...)->m()` is PHP 8.4+-only syntax; the
        // emitter targets PHP 8.1+, so the construction must be parenthesised (issue #907 — the
        // IsDecimal-early-return sibling of #815/#844's int-literal fix and #849's fallthrough fix).
        var expr = new BinaryExpr(BinaryOp.Add, Decimal("5"), Id("quantity"));
        Translate(expr).ShouldBe("(new \\Koine\\Runtime\\Decimal('5'))->add((new \\Koine\\Runtime\\Decimal($this->quantity)))");
    }

    [Fact]
    public void Decimal_negated_comparison_flips_via_compareTo()
    {
        // The invariant-guard path: `price >= 0` negated must still use compareTo, not `<`.
        var t = Make();
        var expr = new BinaryExpr(BinaryOp.Ge, Id("price"), Int("0"));
        t.TranslateNegated(expr).ShouldBe("$this->price->compareTo((new \\Koine\\Runtime\\Decimal('0'))) < 0");
    }

    // =========================================================================
    // Quantity / value-object operands — use the VO's generated methods.
    // =========================================================================

    [Fact]
    public void Quantity_times_scalar_lowers_to_multipliedBy()
    {
        // `weight * quantity` (Weight quantity * Int) -> weight->multipliedBy(new Decimal(quantity)).
        // The wrapper is parenthesised uniformly (#849); harmless here in argument position.
        var expr = new BinaryExpr(BinaryOp.Mul, Id("weight"), Id("quantity"));
        Translate(expr).ShouldBe("$this->weight->multipliedBy((new \\Koine\\Runtime\\Decimal($this->quantity)))");
    }

    [Fact]
    public void Quantity_divided_by_scalar_lowers_to_dividedBy()
    {
        var expr = new BinaryExpr(BinaryOp.Div, Id("weight"), Id("quantity"));
        Translate(expr).ShouldBe("$this->weight->dividedBy((new \\Koine\\Runtime\\Decimal($this->quantity)))");
    }

    [Fact]
    public void Quantity_plus_quantity_lowers_to_add()
    {
        var expr = new BinaryExpr(BinaryOp.Add, Id("weight"), Id("otherWeight"));
        Translate(expr).ShouldBe("$this->weight->add($this->otherWeight)");
    }

    [Fact]
    public void Quantity_minus_quantity_lowers_to_subtract()
    {
        var expr = new BinaryExpr(BinaryOp.Sub, Id("weight"), Id("otherWeight"));
        Translate(expr).ShouldBe("$this->weight->subtract($this->otherWeight)");
    }

    [Fact]
    public void Value_object_add_with_vo_on_the_right_uses_the_vo_as_receiver()
    {
        // The VO is the RIGHT operand; the receiver must be the value object (not the literal),
        // otherwise we emit `1->add(...)` which is a fatal PHP error. The other operand is the arg.
        var expr = new BinaryExpr(BinaryOp.Add, Int("1"), Id("weight"));
        Translate(expr).ShouldBe("$this->weight->add(1)");
    }

    [Fact]
    public void Value_object_subtract_with_vo_on_the_right_uses_the_vo_as_receiver()
    {
        var expr = new BinaryExpr(BinaryOp.Sub, Int("1"), Id("weight"));
        Translate(expr).ShouldBe("$this->weight->subtract(1)");
    }

    [Fact]
    public void Value_object_equality_lowers_to_equals()
    {
        var eq = new BinaryExpr(BinaryOp.Eq, Id("weight"), Id("otherWeight"));
        var ne = new BinaryExpr(BinaryOp.Neq, Id("weight"), Id("otherWeight"));
        Translate(eq).ShouldBe("$this->weight->equals($this->otherWeight)");
        Translate(ne).ShouldBe("!$this->weight->equals($this->otherWeight)");
    }

    [Fact]
    public void Value_object_comparison_compares_underlying_amount()
    {
        // No generated VO comparison method, so compare the underlying Decimal amount accessor.
        var expr = new BinaryExpr(BinaryOp.Lt, Id("weight"), Id("otherWeight"));
        Translate(expr).ShouldBe("($this->weight->amount->compareTo($this->otherWeight->amount) < 0)");
    }

    // =========================================================================
    // Collection / string members
    // =========================================================================

    [Fact]
    public void IsEmpty_lowers_to_count_zero()
    {
        var expr = Member("lines", "isEmpty");
        Translate(expr).ShouldBe("count($this->lines) === 0");
    }

    [Fact]
    public void IsNotEmpty_lowers_to_count_not_zero()
    {
        var expr = Member("lines", "isNotEmpty");
        Translate(expr).ShouldBe("count($this->lines) !== 0");
    }

    [Fact]
    public void Length_lowers_to_strlen_for_strings_and_count_for_lists()
    {
        // `tags` is List<String>, so uses count()
        var expr = Member("tags", "length");
        Translate(expr).ShouldBe("count($this->tags)");
    }

    [Fact]
    public void String_length_member_lowers_to_strlen()
    {
        // `code` is String, so uses strlen()
        var expr = Member("code", "length");
        Translate(expr).ShouldBe("strlen($this->code)");
    }

    [Fact]
    public void Count_lowers_to_count()
    {
        var expr = Member("lines", "count");
        Translate(expr).ShouldBe("count($this->lines)");
    }

    [Fact]
    public void StringOps_lower_to_php_functions()
    {
        Translate(Member("code", "trim")).ShouldBe("trim($this->code)");
        Translate(Member("code", "lower")).ShouldBe("strtolower($this->code)");
        Translate(Member("code", "upper")).ShouldBe("strtoupper($this->code)");
        Translate(Member("code", "isBlank")).ShouldBe("(trim($this->code) === '')");
    }

    [Fact]
    public void OptionalOps_lower_to_null_checks()
    {
        Translate(Member("note", "isPresent")).ShouldBe("$this->note !== null");
        Translate(Member("note", "isNone")).ShouldBe("$this->note === null");
    }

    // =========================================================================
    // Coalesce / ternary
    // =========================================================================

    [Fact]
    public void Coalesce_lowers_to_null_coalescing_operator()
    {
        var expr = new CoalesceExpr(Id("note"), new LiteralExpr(LiteralKind.String, "n/a"));
        Translate(expr).ShouldBe("($this->note ?? 'n/a')");
    }

    [Fact]
    public void Ternary_lowers_to_php_ternary()
    {
        var expr = new ConditionalExpr(
            new BinaryExpr(BinaryOp.Ge, Id("quantity"), Int("1")),
            Int("10"),
            Int("0"));
        Translate(expr).ShouldBe("(($this->quantity >= 1) ? 10 : 0)");
    }

    [Fact]
    public void Ternary_with_bool_literals_simplifies()
    {
        var cond = new BinaryExpr(BinaryOp.Ge, Id("quantity"), Int("1"));
        Translate(new ConditionalExpr(cond, Bool(true), Bool(false))).ShouldBe("($this->quantity >= 1)");
        Translate(new ConditionalExpr(cond, Bool(false), Bool(true))).ShouldBe("!(($this->quantity >= 1))");
    }

    // =========================================================================
    // Calls
    // =========================================================================

    [Fact]
    public void Contains_on_string_lowers_to_str_contains()
    {
        var expr = new CallExpr(Id("code"), "contains", new Expr[] { new LiteralExpr(LiteralKind.String, "x") });
        Translate(expr).ShouldBe("str_contains($this->code, 'x')");
    }

    [Fact]
    public void Contains_on_list_lowers_to_in_array()
    {
        var expr = new CallExpr(Id("tags"), "contains", new Expr[] { new LiteralExpr(LiteralKind.String, "x") });
        Translate(expr).ShouldBe("in_array('x', $this->tags, true)");
    }

    [Fact]
    public void StartsWith_endsWith_lower_to_php_functions()
    {
        var sw = new CallExpr(Id("code"), "startsWith", new Expr[] { new LiteralExpr(LiteralKind.String, "X") });
        var ew = new CallExpr(Id("code"), "endsWith", new Expr[] { new LiteralExpr(LiteralKind.String, "Y") });
        Translate(sw).ShouldBe("str_starts_with($this->code, 'X')");
        Translate(ew).ShouldBe("str_ends_with($this->code, 'Y')");
    }

    [Fact]
    public void All_any_none_lower_to_array_comprehensions()
    {
        // `m.amount > 0` is a Decimal compared with an Int literal: PHP has no operator overloading,
        // so it lowers to compareTo() with the literal wrapped as a Decimal.
        var pred = new BinaryExpr(BinaryOp.Gt, new MemberAccessExpr(Id("m"), "amount"), Int("0"));
        var all = new CallExpr(Id("lines"), "all", new Expr[] { new LambdaExpr("m", pred) });
        var any = new CallExpr(Id("lines"), "any", new Expr[] { new LambdaExpr("m", pred) });
        var none = new CallExpr(Id("lines"), "none", new Expr[] { new LambdaExpr("m", pred) });
        const string cmp = "($m->amount->compareTo((new \\Koine\\Runtime\\Decimal('0'))) > 0)";
        Translate(all).ShouldBe($"array_reduce($this->lines, fn($carry, $m) => $carry && {cmp}, true)");
        Translate(any).ShouldBe($"array_reduce($this->lines, fn($carry, $m) => $carry || {cmp}, false)");
        Translate(none).ShouldBe($"!array_reduce($this->lines, fn($carry, $m) => $carry || {cmp}, false)");
    }

    // =========================================================================
    // Decimal-safe reductions
    // =========================================================================

    [Fact]
    public void Sum_of_Int_projection_uses_array_sum()
    {
        // Int projection: builtin array_sum should work
        var selector = new LambdaExpr("c", Id("c"));
        var expr = new CallExpr(Id("counts"), "sum", new Expr[] { selector });
        Translate(expr).ShouldBe("array_sum(array_map(fn($c) => $c, $this->counts))");
    }

    [Fact]
    public void Sum_of_Decimal_projection_uses_koine_sum()
    {
        // Decimal projection: empty collection has no zero, so must raise — keep koine_sum.
        var selector = new LambdaExpr("p", Id("p"));
        var expr = new CallExpr(Id("prices"), "sum", new Expr[] { selector });
        Translate(expr).ShouldBe("\\Koine\\Runtime\\Decimal::sum(array_map(fn($p) => $p, $this->prices))");
    }

    [Fact]
    public void Sum_of_value_object_projection_uses_koine_sum()
    {
        // Value-object (Money) projection: no zero value — keep runtime sum.
        var selector = new LambdaExpr("m", new MemberAccessExpr(Id("m"), "amount"));
        var expr = new CallExpr(Id("lines"), "sum", new Expr[] { selector });
        Translate(expr).ShouldBe("\\Koine\\Runtime\\Decimal::sum(array_map(fn($m) => $m->amount, $this->lines))");
    }

    [Fact]
    public void Min_max_use_runtime_helpers()
    {
        var selector = new LambdaExpr("p", new MemberAccessExpr(Id("p"), "amount"));
        var min = new CallExpr(Id("lines"), "min", new Expr[] { selector });
        var max = new CallExpr(Id("lines"), "max", new Expr[] { selector });
        Translate(min).ShouldBe("\\Koine\\Runtime\\Decimal::min(array_map(fn($p) => $p->amount, $this->lines))");
        Translate(max).ShouldBe("\\Koine\\Runtime\\Decimal::max(array_map(fn($p) => $p->amount, $this->lines))");
    }

    [Fact]
    public void Min_of_Int_projection_uses_guarded_builtin_min()
    {
        // Int projection: PHP's builtin min() is integer-exact (parity with array_sum for sum) — the
        // Decimal helper would call compareTo() on raw ints. The empty-guard raises the same
        // DomainInvariantViolationException the Decimal/C# paths use AND narrows the array to
        // non-empty so phpstan --level max types min() as int (a bare min(array<int>) is int|false).
        var selector = new LambdaExpr("c", Id("c"));
        var expr = new CallExpr(Id("counts"), "min", new Expr[] { selector });
        Translate(expr).ShouldBe(
            "(fn($__xs) => $__xs === [] ? throw new \\Koine\\Runtime\\DomainInvariantViolationException('collection', 'cannot take min of an empty collection (no value)') : min($__xs))(array_map(fn($c) => $c, $this->counts))");
    }

    [Fact]
    public void Max_of_Int_projection_uses_guarded_builtin_max()
    {
        // Symmetric to min: an Int projection lowers to the guarded builtin max(), not Decimal::max.
        var selector = new LambdaExpr("c", Id("c"));
        var expr = new CallExpr(Id("counts"), "max", new Expr[] { selector });
        Translate(expr).ShouldBe(
            "(fn($__xs) => $__xs === [] ? throw new \\Koine\\Runtime\\DomainInvariantViolationException('collection', 'cannot take max of an empty collection (no value)') : max($__xs))(array_map(fn($c) => $c, $this->counts))");
    }

    [Fact]
    public void DistinctBy_with_primitive_selector_lowers_to_unique_count_comparison()
    {
        // String projection: PHP `array_unique` (SORT_STRING) dedupes scalars by value correctly,
        // so the primitive selector keeps the fast `array_unique` path.
        var selector = new LambdaExpr("t", Id("t"));
        var expr = new CallExpr(Id("tags"), "distinctBy", new Expr[] { selector });
        Translate(expr).ShouldBe("count(array_unique(array_map(fn($t) => $t, $this->tags))) === count($this->tags)");
    }

    [Fact]
    public void DistinctBy_with_value_object_selector_dedupes_structurally()
    {
        // Value-object projection (Money): `array_unique` would string-cast each object — fatal on a
        // VO with no __toString. Dedupe structurally via the generated `equals()`, matching C#'s
        // `.Distinct()` and the TS fix in #609. No `array_unique` in the emitted form.
        var selector = new LambdaExpr("m", Id("m"));
        var expr = new CallExpr(Id("lines"), "distinctBy", new Expr[] { selector });
        Translate(expr).ShouldBe(
            "(fn($__xs) => count(array_filter($__xs, fn($__x, $__i) => " +
            "array_key_first(array_filter($__xs, fn($__y) => $__y->equals($__x))) === $__i, " +
            "ARRAY_FILTER_USE_BOTH)) === count($__xs))(array_map(fn($m) => $m, $this->lines))");
    }

    [Fact]
    public void DistinctBy_with_decimal_selector_dedupes_structurally()
    {
        // Decimal projection: `array_unique` happens to work (runtime Decimal has __toString), but for
        // parity with C#/TS and the value-object branch a Decimal selector also dedupes via `equals()`.
        var selector = new LambdaExpr("m", new MemberAccessExpr(Id("m"), "amount"));
        var expr = new CallExpr(Id("lines"), "distinctBy", new Expr[] { selector });
        Translate(expr).ShouldBe(
            "(fn($__xs) => count(array_filter($__xs, fn($__x, $__i) => " +
            "array_key_first(array_filter($__xs, fn($__y) => $__y->equals($__x))) === $__i, " +
            "ARRAY_FILTER_USE_BOTH)) === count($__xs))(array_map(fn($m) => $m->amount, $this->lines))");
    }

    [Fact]
    public void DistinctBy_with_optional_value_like_selector_is_null_safe()
    {
        // Optional projection (Decimal?): the mapped array can hold PHP `null`s, and the generated
        // `equals(self $other)` is non-nullable — so the structural fold guards null first (two nulls
        // are equal; null vs. a value are not), matching C#'s `.Distinct()` null semantics instead of
        // crashing. Without the guard `$__y->equals($__x)` would fatal on a null element.
        var selector = new LambdaExpr("m", new MemberAccessExpr(Id("m"), "discount"));
        var expr = new CallExpr(Id("lines"), "distinctBy", new Expr[] { selector });
        Translate(expr).ShouldBe(
            "(fn($__xs) => count(array_filter($__xs, fn($__x, $__i) => " +
            "array_key_first(array_filter($__xs, fn($__y) => $__x === null ? $__y === null : " +
            "($__y !== null && $__y->equals($__x)))) === $__i, " +
            "ARRAY_FILTER_USE_BOTH)) === count($__xs))(array_map(fn($m) => $m->discount, $this->lines))");
    }

    [Fact]
    public void DistinctBy_with_entity_selector_dedupes_structurally()
    {
        // Entity projection (CartLine): like a value object, an entity is emitted as a class with no
        // __toString, so `array_unique` (SORT_STRING) would string-cast each element and fatal at
        // runtime (issue #687, the entity counterpart of the #676/#681 value-object fix). Entities
        // carry the same generated `equals(self $other)`, so an entity selector dedupes structurally
        // via `equals()` exactly like a value object, matching C#'s `.Distinct()`. No `array_unique`.
        var t = MakeForEntity("Basket");
        var selector = new LambdaExpr("i", Id("i"));
        var expr = new CallExpr(Id("items"), "distinctBy", new Expr[] { selector });
        t.Translate(expr).ShouldBe(
            "(fn($__xs) => count(array_filter($__xs, fn($__x, $__i) => " +
            "array_key_first(array_filter($__xs, fn($__y) => $__y->equals($__x))) === $__i, " +
            "ARRAY_FILTER_USE_BOTH)) === count($__xs))(array_map(fn($i) => $i, $this->items))");
    }

    // =========================================================================
    // Regex match
    // =========================================================================

    [Fact]
    public void Matches_lowers_to_preg_match()
    {
        var expr = new MatchExpr(Id("code"), "[A-Z]{3}");
        Translate(expr).ShouldBe("(bool)preg_match('/[A-Z]{3}/', $this->code)");
    }

    [Fact]
    public void Matches_with_timeout_annotates_the_pcre_limit_substitute()
    {
        // Key set (#812): PHP has no per-call wall-clock timeout, so the budget is surfaced as a PCRE-limit
        // note on the preg_match (no silent drop). Match behavior — the `(bool)preg_match(...)` — is unchanged.
        var expr = new MatchExpr(Id("code"), "[A-Z]{3}");
        MakeWithTimeout(250).Translate(expr).ShouldBe(
            "(bool)preg_match('/[A-Z]{3}/', $this->code /* regexMatchTimeoutMs=250ms: PHP has no per-call "
            + "wall-clock match timeout; matching is bounded via PCRE pcre.backtrack_limit/pcre.recursion_limit */)");
    }

    [Fact]
    public void Matches_invariant_with_timeout_keeps_the_match_call_unchanged_aside_from_the_note()
    {
        // End-to-end through PhpEmitterOptions: the emitted Email class still calls preg_match exactly;
        // only the PCRE-substitute note is added, surfacing the author's budget.
        const string src =
            "context C {\n  value Email {\n    raw: String\n" +
            "    invariant raw matches /^[^@]+@[^@]+$/  \"invalid email address\"\n  }\n}\n";
        var emitter = new PhpEmitter(PhpEmitterOptions.Empty with { RegexMatchTimeoutMs = 250 });
        var result = new KoineCompiler().Compile(src, emitter);
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var email = result.Files.Single(f => f.RelativePath.EndsWith("Email.php")).Contents;
        email.ShouldContain("preg_match('/^[^@]+@[^@]+$/'");
        email.ShouldContain("regexMatchTimeoutMs=250ms");
        email.ShouldContain("pcre.backtrack_limit");
    }

    [Fact]
    public void Matches_escapes_a_slash_in_the_pattern()
    {
        // A `/` in the pattern would otherwise close the PCRE `/.../` delimiter early — emitting a
        // broken regex that preg_match rejects (warning + always-false). It must be escaped to `\/`.
        var expr = new MatchExpr(Id("code"), "a/b");
        Translate(expr).ShouldBe("(bool)preg_match('/a\\/b/', $this->code)");
    }

    // =========================================================================
    // Let — closure application
    // =========================================================================

    [Fact]
    public void Let_lowers_to_immediately_invoked_closures()
    {
        var bindings = new[]
        {
            new LetBinding("x", Int("1")),
            new LetBinding("y", Int("2")),
        };
        var body = new BinaryExpr(BinaryOp.Add, Id("x"), Id("y"));
        var expr = new LetExpr(bindings, body);
        Translate(expr).ShouldBe("(fn($x) => (fn($y) => ($x + $y))(2))(1)");
    }

    // =========================================================================
    // Enum access & literals
    // =========================================================================

    [Fact]
    public void Qualified_enum_access_renders_class_constant()
    {
        var expr = new MemberAccessExpr(Id("OrderStatus"), "Cancelled");
        Translate(expr).ShouldBe("OrderStatus::CANCELLED");
    }

    [Fact]
    public void Decimal_literal_renders_runtime_decimal_constructor()
    {
        var expr = new LiteralExpr(LiteralKind.Decimal, "9.99");
        Translate(expr).ShouldBe("new \\Koine\\Runtime\\Decimal('9.99')");
    }

    [Fact]
    public void Bool_literals_render_php_lowercase()
    {
        Translate(Bool(true)).ShouldBe("true");
        Translate(Bool(false)).ShouldBe("false");
    }

    // --- #655: expression string literals must be emitted as single-quoted PHP
    // literals. PHP interpolates "$word" inside double-quoted strings, so an
    // expression literal containing a '$' (e.g. `name != "$admin"`) was being turned
    // into a reference to an undefined variable (wrong runtime value + phpstan
    // level-max failure). Single quotes reproduce the literal verbatim and match the
    // convention already used by the Decimal/regex arms, the runtime, and #616's
    // RuleLiteral fix for invariant/requires messages. ---

    [Fact]
    public void String_literal_is_single_quoted_and_escaped()
    {
        // input chars: a " b \ c — only `\` is escaped (doubled); `"` is verbatim
        // inside single quotes, so it is NOT escaped.
        var expr = new LiteralExpr(LiteralKind.String, "a\"b\\c");
        Translate(expr).ShouldBe("'a\"b\\\\c'");
    }

    [Fact]
    public void String_literal_with_dollar_is_single_quoted_not_interpolated()
    {
        var expr = new LiteralExpr(LiteralKind.String, "$admin");
        // single-quoted → PHP reproduces "$admin" verbatim, no variable interpolation
        Translate(expr).ShouldBe("'$admin'");
    }

    [Fact]
    public void String_literal_with_single_quote_is_escaped()
    {
        var expr = new LiteralExpr(LiteralKind.String, "it's");
        // inside a single-quoted PHP literal a literal apostrophe is written as \'
        Translate(expr).ShouldBe("'it\\'s'");
    }

    [Fact]
    public void String_literal_with_backslash_is_escaped()
    {
        // the model already holds the single backslash "a\b"; the PHP single-quoted
        // literal must double it back to stay verbatim.
        var expr = new LiteralExpr(LiteralKind.String, "a\\b");
        Translate(expr).ShouldBe("'a\\\\b'");
    }

    [Fact]
    public void String_literal_with_newline_round_trips()
    {
        // the Koine lexer already unescaped "\n" to a real newline before the model;
        // a real newline is valid and verbatim inside a single-quoted PHP literal.
        var expr = new LiteralExpr(LiteralKind.String, "x\ny");
        Translate(expr).ShouldBe("'x\ny'");
    }

    [Fact]
    public void Empty_string_literal_is_empty_single_quotes()
    {
        var expr = new LiteralExpr(LiteralKind.String, "");
        Translate(expr).ShouldBe("''");
    }

    [Fact]
    public void Invariant_condition_with_dollar_literal_is_single_quoted_not_interpolated()
    {
        // End-to-end: an invariant whose *condition* compares against "$admin" must
        // emit the literal single-quoted in the generated guard, so PHP does not
        // interpolate $admin as an undefined variable (the #655 bug).
        var result = new KoineCompiler().Compile(
            "context C { value V { name: String\n"
            + "  invariant name != \"$admin\" \"name cannot be admin\" } }",
            new PhpEmitter());
        result.Model.ShouldNotBeNull(
            string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var php = string.Concat(result.Files.Select(f => f.Contents));

        php.ShouldContain("'$admin'");
        // the buggy double-quoted form let PHP interpolate the undefined $admin
        php.ShouldNotContain("\"$admin\"");
    }

    // =========================================================================
    // TranslateNegated
    // =========================================================================

    [Fact]
    public void TranslateNegated_flips_comparison()
    {
        var t = Make();
        var expr = new BinaryExpr(BinaryOp.Ge, Id("quantity"), Int("1"));
        t.TranslateNegated(expr).ShouldBe("$this->quantity < 1");
    }

    [Fact]
    public void TranslateNegated_peels_not()
    {
        var t = Make();
        var expr = new UnaryExpr(UnaryOp.Not, Id("a"));
        t.TranslateNegated(expr).ShouldBe("$a");
    }

    [Fact]
    public void TranslateNegated_wraps_other_expressions()
    {
        var t = Make();
        var expr = Member("lines", "isEmpty");
        t.TranslateNegated(expr).ShouldBe("!(count($this->lines) === 0)");
    }

    [Fact]
    public void User_field_named_after_member_op_emits_property_access_not_op_form()
    {
        // #672 (follow-up to #605): a user field named after an UNSAFE built-in member-op
        // (isEmpty/trim/…) must emit a plain property access, mirroring the #605 semantic
        // resolution — not the op form (`count($this->inner) === 0` / `trim($this->inner)`),
        // which targets a receiver that has no such op and is therefore wrong PHP.
        const string src =
            """
            context Demo {
              value Inner {
                isEmpty: Bool
                trim:    String
              }
              value Outer {
                inner: Inner
                flag: Bool   = inner.isEmpty
                name: String = inner.trim
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var source = string.Join("\n", result.Files.Select(f => f.Contents));
        source.ShouldContain("$this->inner->isEmpty");
        source.ShouldContain("$this->inner->trim");
        source.ShouldNotContain("count($this->inner)");
        source.ShouldNotContain("trim($this->inner)");
    }
}
