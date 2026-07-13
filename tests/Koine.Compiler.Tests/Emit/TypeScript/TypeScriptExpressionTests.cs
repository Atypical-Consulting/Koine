using Koine.Compiler.Ast;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Unit tests for <see cref="TypeScriptExpressionTranslator"/> — the pure translation of the
/// target-agnostic <see cref="Expr"/> sublanguage into TypeScript expression source. The focus
/// here is on collection-op lowerings that must agree with the C# emitter's semantics: the numeric
/// <c>min</c>/<c>max</c> empty-collection guard (issue #610), and <c>distinctBy</c> (issue #609) —
/// which a JS <c>Set</c> cannot express for value-object/Id/<c>Decimal</c> selectors (it dedupes by
/// reference identity), so those route through the runtime's structural <c>structuralEquals</c>.
/// </summary>
public class TypeScriptExpressionTests
{
    // A value object whose lines carry a value-object field (Sku), a Decimal field, and primitive
    // fields, so the numeric min/max branch AND every distinctBy selector-type branch are reachable.
    private const string Source =
        """
        context Shop {
          value Sku { code: String }
          value Money { amount: Decimal }
          value Line {
            sku:    Sku
            amount: Decimal
            tag:    String
            qty:    Int
          }
          value Order {
            lines: List<Line>
            money: Money
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

    private static TypeScriptExpressionTranslator Make()
    {
        var result = new KoineCompiler().Compile(Source, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var model = result.Model!;
        var semantic = new SemanticModel(model);
        ModelIndex index = semantic.Index;

        var order = model.Contexts
            .SelectMany(c => c.AllTypeDecls())
            .OfType<ValueObjectDecl>()
            .First(v => v.Name == "Order");

        var typeMapper = new TypeScriptTypeMapper(index);
        return new TypeScriptExpressionTranslator(
            index, order.Members, index.EnumMemberToType, typeMapper, context: "Shop");
    }

    private static string Translate(Expr expr) => Make().Translate(expr);

    // A translator carrying the neutral RegexMatchTimeoutMs author intent (#812), so a `matches`
    // guard threads the budget into the runtime `regexMatch` seam's advisory `timeoutMs?` argument.
    private static TypeScriptExpressionTranslator MakeWithTimeout(int milliseconds)
    {
        var result = new KoineCompiler().Compile(Source, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var model = result.Model!;
        var semantic = new SemanticModel(model);
        ModelIndex index = semantic.Index;

        var order = model.Contexts
            .SelectMany(c => c.AllTypeDecls())
            .OfType<ValueObjectDecl>()
            .First(v => v.Name == "Order");

        var typeMapper = new TypeScriptTypeMapper(index);
        return new TypeScriptExpressionTranslator(
            index, order.Members, index.EnumMemberToType, typeMapper, context: "Shop",
            regexMatchTimeoutMs: milliseconds);
    }

    // A translator whose member scope is an entity (rather than the Order value object), so a
    // selector projecting to an entity type — e.g. distinctBy(i => i) over List<CartLine> — is
    // reachable. CartLine/Basket are child/root entities of the Cart aggregate above (issue #712).
    private static TypeScriptExpressionTranslator MakeForEntity(string entityName)
    {
        var result = new KoineCompiler().Compile(Source, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var model = result.Model!;
        var semantic = new SemanticModel(model);
        ModelIndex index = semantic.Index;

        var entity = model.Contexts
            .SelectMany(c => c.AllTypeDecls())
            .OfType<EntityDecl>()
            .First(e => e.Name == entityName);

        var typeMapper = new TypeScriptTypeMapper(index);
        return new TypeScriptExpressionTranslator(
            index, entity.Members, index.EnumMemberToType, typeMapper, context: "Shop");
    }

    private static IdentifierExpr Id(string name) => new(name);

    private static LiteralExpr Decimal(string text) => new(LiteralKind.Decimal, text);

    // =========================================================================
    // Reversed scalar * value-object (#788) — `0.9 * money` (scalar on the LEFT)
    // must normalize operand order so the value object is the receiver of its own
    // scalar multiply, byte-identical to the canonical `money * 0.9`. Mirrors the
    // merged PHP Bug-2 fix (#778): a value object exposes its own scalar multiply,
    // so it must win regardless of which side it is on — never the wrong
    // `new Decimal('0.9').multiply(this.money)`, which treats the value object as a
    // `Decimal | number` factor (a `tsc` type error and a wrong runtime value).
    // =========================================================================

    [Fact]
    public void Reversed_scalar_times_value_object_normalizes_operand_order()
    {
        // `0.9 * money` — scalar on the LEFT, value object on the RIGHT.
        var reversed = new BinaryExpr(BinaryOp.Mul, Decimal("0.9"), Id("money"));
        Translate(reversed).ShouldBe("this.money.multiply(0.9)");

        // The value object is the receiver, NOT the Decimal — the broken form treated `money` as a
        // Decimal factor of `new Decimal('0.9').multiply(...)`.
        Translate(reversed).ShouldNotContain("new Decimal(");
    }

    [Fact]
    public void Reversed_scalar_times_value_object_is_byte_identical_to_the_canonical_order()
    {
        var reversed = new BinaryExpr(BinaryOp.Mul, Decimal("0.9"), Id("money"));
        var canonical = new BinaryExpr(BinaryOp.Mul, Id("money"), Decimal("0.9"));
        Translate(reversed).ShouldBe(Translate(canonical));
    }

    // A numeric projection `lines.<op>(l => l.qty)` (qty: Int).
    private static CallExpr MinMax(string op) =>
        new(Id("lines"), op, new Expr[] { new LambdaExpr("l", new MemberAccessExpr(Id("l"), "qty")) });

    [Fact]
    public void Numeric_min_guards_empty_collection_and_folds_with_seedless_reduce()
    {
        // Issue #610: `Math.min(...[])` returns Infinity. The numeric branch must instead map once,
        // throw DomainInvariantViolationError on an empty collection, then fold with a seedless
        // `.reduce` — mirroring the value-object branch above it and matching C#/Python.
        var expected =
            "(this.lines.map((l) => l.qty) as readonly number[]).length === 0\n" +
            "        ? (() => { throw new DomainInvariantViolationError('Int', 'cannot take min of an empty collection (no value)'); })()\n" +
            "        : this.lines.map((l) => l.qty).reduce((__mm0a, __mm0b) => Math.min(__mm0a, __mm0b))";
        Translate(MinMax("min")).ShouldBe(expected);
    }

    [Fact]
    public void Numeric_max_guards_empty_collection_and_folds_with_seedless_reduce()
    {
        var expected =
            "(this.lines.map((l) => l.qty) as readonly number[]).length === 0\n" +
            "        ? (() => { throw new DomainInvariantViolationError('Int', 'cannot take max of an empty collection (no value)'); })()\n" +
            "        : this.lines.map((l) => l.qty).reduce((__mm0a, __mm0b) => Math.max(__mm0a, __mm0b))";
        Translate(MinMax("max")).ShouldBe(expected);
    }

    [Fact]
    public void Numeric_min_max_no_longer_emit_a_bare_Math_min_max_spread()
    {
        // The old lowering `Math.min(...arr)` / `Math.max(...arr)` both returns ±Infinity on empty
        // and risks the argument-arity RangeError on very large arrays. Neither should appear now.
        Translate(MinMax("min")).ShouldNotContain("Math.min(...");
        Translate(MinMax("max")).ShouldNotContain("Math.max(...");
    }

    // =========================================================================
    // distinctBy (issue #609) — value-object / Decimal selectors must dedupe
    // STRUCTURALLY. A JS Set dedupes by reference identity, so two structurally
    // equal Skus (distinct instances) would survive as distinct entries and a
    // uniqueness invariant would silently never fire — diverging from C#'s
    // `.Distinct()`, which uses the value object's structural Equals.
    // =========================================================================

    // A distinctBy over `lines` projecting to the given Line member.
    private static CallExpr DistinctBy(string member) =>
        new(Id("lines"), "distinctBy", new Expr[] { new LambdaExpr("l", new MemberAccessExpr(Id("l"), member)) });

    [Fact]
    public void DistinctBy_value_object_selector_dedupes_structurally_not_by_set_identity()
    {
        var ts = Translate(DistinctBy("sku"));

        // Must NOT use a Set (reference identity); must collapse structurally-equal Skus via the
        // runtime's structuralEquals — keeping each value's first structural occurrence.
        ts.ShouldNotContain("new Set(");
        ts.ShouldBe(
            "this.lines.map((l) => l.sku).filter((__x, __i, __xs) => " +
            "__xs.findIndex((__y) => structuralEquals(__x, __y)) === __i).length === this.lines.length");
    }

    [Fact]
    public void DistinctBy_decimal_selector_dedupes_structurally()
    {
        // Decimal is emitted as a class with value `equals`; reference-identity dedupe would be wrong.
        Translate(DistinctBy("amount")).ShouldBe(
            "this.lines.map((l) => l.amount).filter((__x, __i, __xs) => " +
            "__xs.findIndex((__y) => structuralEquals(__x, __y)) === __i).length === this.lines.length");
    }

    [Fact]
    public void DistinctBy_primitive_string_selector_keeps_the_set_fast_path()
    {
        // A primitive selector (string) already dedupes by value under SameValueZero — keep the Set.
        Translate(DistinctBy("tag")).ShouldBe(
            "new Set(this.lines.map((l) => l.tag)).size === this.lines.length");
    }

    [Fact]
    public void DistinctBy_primitive_int_selector_keeps_the_set_fast_path()
    {
        Translate(DistinctBy("qty")).ShouldBe(
            "new Set(this.lines.map((l) => l.qty)).size === this.lines.length");
    }

    [Fact]
    public void DistinctBy_with_entity_selector_dedupes_structurally_not_by_set_identity()
    {
        // Entity projection (CartLine): a JS Set dedupes by reference identity, so two
        // structurally-distinct CartLine instances would survive as distinct entries — diverging
        // from C#'s `.Distinct()` (issue #712, the entity counterpart of the #609 value-object fix).
        // An emitted entity carries a structural `equals` that compares by id (`this.id.equals(...)`),
        // which the runtime `structuralEquals` delegates to, so an entity selector must route through
        // the same fold as a value object — deduping by id, matching C# and PHP (post-#687).
        var t = MakeForEntity("Basket");
        var expr = new CallExpr(Id("items"), "distinctBy", new Expr[] { new LambdaExpr("i", Id("i")) });
        var ts = t.Translate(expr);

        ts.ShouldNotContain("new Set(");
        ts.ShouldBe(
            "this.items.map((i) => i).filter((__x, __i, __xs) => " +
            "__xs.findIndex((__y) => structuralEquals(__x, __y)) === __i).length === this.items.length");
    }

    [Fact]
    public void User_field_named_after_member_op_emits_property_access_not_op_form()
    {
        // #672 (follow-up to #605): a user field named after an UNSAFE built-in member-op
        // (isEmpty/trim/…) must emit a plain property access, mirroring the #605 semantic
        // resolution — not the op form (`this.inner.length === 0` / `this.inner.trim()`), which
        // targets a receiver that has no such op and is therefore wrong TypeScript.
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
        var result = new KoineCompiler().Compile(src, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var source = string.Join("\n", result.Files.Select(f => f.Contents));
        source.ShouldContain("this.inner.isEmpty");
        source.ShouldContain("this.inner.trim");
        source.ShouldNotContain("this.inner.length");
        source.ShouldNotContain("this.inner.trim()");
    }

    // =========================================================================
    // Regex match (#641) — `matches` routes through the runtime `regexMatch`
    // seam rather than an inline `/pat/.test(...)`. JS has no synchronous
    // per-call regex timeout, so centralizing every match in one helper gives a
    // single hardening point (the place to swap in a linear-time engine) while
    // preserving `.test` semantics exactly (no target-divergent behavior).
    // =========================================================================

    [Fact]
    public void Matches_lowers_through_the_runtime_regexMatch_seam()
    {
        // The old lowering was `/pat/.test(target)`; #641 routes it through `regexMatch`
        // so an author-supplied pattern over untrusted input has a single ReDoS chokepoint.
        var expr = new MatchExpr(Id("code"), "[A-Z]{3}");
        Translate(expr).ShouldBe("regexMatch(/[A-Z]{3}/, code)");
    }

    [Fact]
    public void Matches_invariant_imports_regexMatch_from_the_runtime()
    {
        // A value object with a `matches` invariant must emit the `regexMatch` seam call AND
        // auto-import it from the once-emitted runtime module (no inline `.test`).
        const string src =
            """
            context C {
              value Email {
                raw: String
                invariant raw matches /^[^@]+@[^@]+$/  "invalid email address"
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var email = result.Files.Single(f => f.RelativePath.EndsWith("Email.ts")).Contents;
        email.ShouldContain("regexMatch(/^[^@]+@[^@]+$/, raw)");
        email.ShouldMatch(@"import \{[^}]*\bregexMatch\b[^}]*\} from '[^']*runtime'");
        email.ShouldNotContain("/^[^@]+@[^@]+$/.test(");
    }

    [Fact]
    public void String_plus_bool_concatenation_emits_canonical_String_conversion()
    {
        // Issue #806: `String + Bool` (and `Bool + String`) must render the Bool operand via
        // `String(boolExpr)` so the canonical cross-target "true"/"false" strings are produced
        // explicitly — TypeScript's native `+` operator already yields lowercase, but the explicit
        // `String()` call makes the canonical choice visible and aligns with PHP's ternary and
        // C#'s ternary renderings.
        const string src =
            "context Account {\n" +
            "  value Membership {\n" +
            "    isActive: Bool\n" +
            // String-led: String + Bool
            "    label: String = \"active: \" + isActive\n" +
            // Bool-led: Bool + String
            "    caption: String = isActive + \" status\"\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var membership = result.Files.Single(f => f.RelativePath.EndsWith("Membership.ts")).Contents;
        // Bool operand must be wrapped in String() in both operand orders.
        membership.ShouldContain("String(this.isActive)");
        // The raw bool must not appear as a direct + operand.
        membership.ShouldNotContain("+ this.isActive");
        membership.ShouldNotContain("this.isActive +");
    }

    [Fact]
    public void Matches_with_timeout_threads_the_budget_into_the_regexMatch_call()
    {
        // Key set (#812) ⇒ the call site passes the author's ms budget as the seam's advisory third arg.
        var expr = new MatchExpr(Id("code"), "[A-Z]{3}");
        MakeWithTimeout(250).Translate(expr).ShouldBe("regexMatch(/[A-Z]{3}/, code, 250)");
    }

    [Fact]
    public void Runtime_regexMatch_seam_is_byte_identical_when_the_timeout_is_unset()
    {
        // Key unset ⇒ the runtime is the historical two-arg seam, byte-for-byte.
        TsRuntime.SourceFor(null).ShouldBe(TsRuntime.Source);
        TsRuntime.SourceFor(null).ShouldContain("export function regexMatch(pattern: RegExp, input: string): boolean {");
    }

    [Fact]
    public void Runtime_regexMatch_seam_gains_an_advisory_timeout_param_when_the_key_is_set()
    {
        // Key set ⇒ the seam carries `timeoutMs?` and documents that stock RegExp ignores it (advisory),
        // while the two-arg historical signature is gone.
        var runtime = TsRuntime.SourceFor(250);
        runtime.ShouldContain("export function regexMatch(pattern: RegExp, input: string, timeoutMs?: number): boolean {");
        runtime.ShouldContain("ADVISORY");
        runtime.ShouldContain("regexMatchTimeoutMs");
        runtime.ShouldNotContain("export function regexMatch(pattern: RegExp, input: string): boolean {");
    }

    [Fact]
    public void Matches_invariant_with_timeout_emits_the_bounded_call_and_runtime_seam()
    {
        // End-to-end through TsEmitterOptions: the call site passes the budget and the once-emitted
        // runtime exposes the advisory `timeoutMs?` parameter.
        const string src =
            """
            context C {
              value Email {
                raw: String
                invariant raw matches /^[^@]+@[^@]+$/  "invalid email address"
              }
            }
            """;
        var emitter = new TypeScriptEmitter(TsEmitterOptions.Empty with { RegexMatchTimeoutMs = 250 });
        var result = new KoineCompiler().Compile(src, emitter);
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var email = result.Files.Single(f => f.RelativePath.EndsWith("Email.ts")).Contents;
        email.ShouldContain("regexMatch(/^[^@]+@[^@]+$/, raw, 250)");

        var runtime = result.Files.Single(f => f.RelativePath.EndsWith("runtime.ts")).Contents;
        runtime.ShouldContain("timeoutMs?: number");
    }

    // ---------------------------------------------------------------------------------------------
    // #1497 — local-binding shadow tracking (the TS half of the #1370 PopLocal-eviction bug class).
    // ---------------------------------------------------------------------------------------------

    private const string NoTscNotice =
        "no TypeScript toolchain (node + tsc) on PATH — set KOINE_TSC/KOINE_NODE to type-check the emitted TS";

    /// <summary>
    /// A <c>let</c> that shadows a same-named MEMBER, with a second <c>let</c> shadowing it again:
    /// popping the inner binding must restore the OUTER LOCAL, not evict it.
    /// <para>
    /// The old flat <c>_locals</c>/<c>_localTypes</c> pair could only evict, so after the inner
    /// <c>let n = 20</c> popped, <c>n</c> stopped being a local at all — and the trailing <c>+ n</c>
    /// silently re-bound to the MEMBER <c>n</c>, emitting <c>this.n</c>. The member is a
    /// <c>String</c> here, so the mis-binding is not merely wrong at runtime (it would have read the
    /// member instead of <c>10</c>): it makes the getter return a string from a <c>number</c>-typed
    /// accessor, which <c>tsc --strict</c> rejects outright.
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

        var result = new KoineCompiler().Compile(src, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var money = result.Files.Single(f => f.RelativePath.EndsWith("Money.ts")).Contents;

        // The outer `n` must still resolve to the LOCAL const, never to the member.
        money.ShouldContain("return ((() => { const n = 20; return n; })() + n);");
        money.ShouldNotContain("+ this.n)");

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoTscNotice);
        check.Ok.ShouldBeTrue(
            "a let shadowing a same-named member must not leak the member into the outer binding's scope:\n"
            + string.Join("\n", check.Errors));
    }

    /// <summary>
    /// The narrower lambda-parameter variant: a collection-op lambda parameter that shadows a same-named
    /// outer <c>let</c> of a DIFFERENT type. <c>RenderLambda</c>'s old name-only <c>wasPresent</c> guard
    /// kept the outer NAME bound but left the lambda parameter's <c>TypeRef</c> overwriting the outer
    /// one, so the outer binding was re-typed for the rest of its scope.
    /// <para>
    /// Here <c>x</c> is a <c>Decimal</c> (<c>rate</c>) shadowed by an <c>Int</c> element parameter. After
    /// the lambda closes, <c>x + rate</c> must render as <c>Decimal</c> arithmetic
    /// (<c>x.add(this.rate)</c>); with the leaked <c>Int</c> type it rendered as raw
    /// <c>(x + this.rate)</c>, which <c>tsc --strict</c> rejects — <c>+</c> does not apply to the runtime
    /// <c>Decimal</c> class.
    /// </para>
    /// </summary>
    [Fact]
    public void LambdaParameterShadowingAnOuterLet_RestoresTheOuterBindingsType_AfterTheLambdaCloses()
    {
        const string src =
            """
            context Shop {
              value Order {
                qtys:  List<Int>
                rate:  Decimal
                total: Decimal = let x = rate in (if qtys.any(x => x > 0) then x + rate else x)
              }
            }
            """;

        var result = new KoineCompiler().Compile(src, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var order = result.Files.Single(f => f.RelativePath.EndsWith("Order.ts")).Contents;

        // `x` is a Decimal again once the lambda closes — so its arithmetic goes through Decimal.add.
        order.ShouldContain("x.add(this.rate)");

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoTscNotice);
        check.Ok.ShouldBeTrue(
            "a lambda parameter shadowing an outer let must not leak its element type into the outer binding:\n"
            + string.Join("\n", check.Errors));
    }

    // ---------------------------------------------------------------------------------------------
    // #1537 — Decimal arithmetic against a non-Decimal Int operand must widen the Int side to
    // Decimal at the call site: the runtime's `add`/`subtract` are declared `(other: Decimal)`, so a
    // bare `number` argument is a `tsc --strict` TS2345.
    // ---------------------------------------------------------------------------------------------

    /// <summary>
    /// The issue's own minimal repro: an Int LITERAL opposite a Decimal member in `+`. Must widen via
    /// the runtime's literal-to-Decimal construction (<c>Decimal.fromInt(...)</c>), not emit the bare
    /// literal `this.rate.add(1)` `tsc --strict` rejects.
    /// </summary>
    [Fact]
    public void DecimalPlusIntLiteral_WidensTheLiteralToDecimal()
    {
        const string src =
            """
            context Shop {
              value Order {
                rate:  Decimal
                total: Decimal = rate + 1
              }
            }
            """;

        var result = new KoineCompiler().Compile(src, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var order = result.Files.Single(f => f.RelativePath.EndsWith("Order.ts")).Contents;
        order.ShouldContain("this.rate.add(Decimal.fromInt(1))");
        order.ShouldNotContain(".add(1)");

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoTscNotice);
        check.Ok.ShouldBeTrue(
            "a Decimal member plus an Int literal must type-check under tsc --strict:\n"
            + string.Join("\n", check.Errors));
    }

    /// <summary>
    /// The literal on the LEFT (`1 + rate`) must widen identically — the Decimal side is not
    /// necessarily the receiver-in-source-position, but the emitted receiver must still be a Decimal.
    /// </summary>
    [Fact]
    public void IntLiteralPlusDecimal_WidensTheLiteralToDecimal()
    {
        const string src =
            """
            context Shop {
              value Order {
                rate:  Decimal
                total: Decimal = 1 + rate
              }
            }
            """;

        var result = new KoineCompiler().Compile(src, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var order = result.Files.Single(f => f.RelativePath.EndsWith("Order.ts")).Contents;
        order.ShouldContain("Decimal.fromInt(1).add(this.rate)");

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoTscNotice);
        check.Ok.ShouldBeTrue(
            "an Int literal plus a Decimal member must type-check under tsc --strict:\n"
            + string.Join("\n", check.Errors));
    }

    /// <summary>
    /// An Int-typed MEMBER (not a literal) opposite a Decimal — the fix must be driven off the
    /// inferred <c>TypeRef</c>, not <c>expr is LiteralExpr</c>, so a member reference widens too.
    /// </summary>
    [Fact]
    public void DecimalPlusIntMember_WidensTheMemberToDecimal()
    {
        const string src =
            """
            context Shop {
              value Order {
                rate:  Decimal
                qty:   Int
                total: Decimal = rate + qty
              }
            }
            """;

        var result = new KoineCompiler().Compile(src, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var order = result.Files.Single(f => f.RelativePath.EndsWith("Order.ts")).Contents;
        order.ShouldContain("this.rate.add(Decimal.fromInt(this.qty))");

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoTscNotice);
        check.Ok.ShouldBeTrue(
            "a Decimal member plus an Int member must type-check under tsc --strict:\n"
            + string.Join("\n", check.Errors));
    }

    /// <summary>Sibling shapes for `-`, `*`, `/` — the same missing coercion applies to all four ops.</summary>
    [Theory]
    [InlineData("-", "subtract")]
    [InlineData("*", "multiply")]
    [InlineData("/", "divide")]
    public void DecimalArithmeticAgainstIntMember_WidensForEveryOperator(string op, string method)
    {
        string src =
            $$"""
            context Shop {
              value Order {
                rate:  Decimal
                qty:   Int
                total: Decimal = rate {{op}} qty
              }
            }
            """;

        var result = new KoineCompiler().Compile(src, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var order = result.Files.Single(f => f.RelativePath.EndsWith("Order.ts")).Contents;
        order.ShouldContain($"this.rate.{method}(Decimal.fromInt(this.qty))");

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoTscNotice);
        check.Ok.ShouldBeTrue(
            $"Decimal {op} Int member must type-check under tsc --strict:\n"
            + string.Join("\n", check.Errors));
    }

    // ---------------------------------------------------------------------------------------------
    // #1537 Task 2 — an OPTIONAL Int operand opposite a Decimal. The literal `qty: Int?  total:
    // Decimal? = qty + rate` from the issue is not valid Koine on its own (the validator requires a
    // guard/`??` before an optional participates in arithmetic — KOI0402), so these use the nearest
    // guarded shape the validator accepts: `if qty.isPresent then qty + rate else rate`.
    // ---------------------------------------------------------------------------------------------

    /// <summary>
    /// The guarded shape used directly as a member's value. TypeScript's OWN control-flow narrowing
    /// of the emitted <c>this.qty !== undefined ? … : …</c> guard already makes this safe without any
    /// widening help, so this passes even pre-fix — it pins the correct <c>Decimal | undefined</c>
    /// result shape as a regression guard, not a red-bar repro (see the next test for that).
    /// </summary>
    [Fact]
    public void DecimalPlusGuardedOptionalIntMember_TypeChecks()
    {
        const string src =
            """
            context Shop {
              value Order {
                rate:  Decimal
                qty:   Int?
                total: Decimal? = if qty.isPresent then qty + rate else rate
              }
            }
            """;

        var result = new KoineCompiler().Compile(src, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var order = result.Files.Single(f => f.RelativePath.EndsWith("Order.ts")).Contents;
        order.ShouldContain("get total(): Decimal | undefined");

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoTscNotice);
        check.Ok.ShouldBeTrue(
            "a guarded optional Int member plus Decimal must type-check under tsc --strict:\n"
            + string.Join("\n", check.Errors));
    }

    /// <summary>
    /// The real red-bar repro: the guarded optional Int is consumed inside a NESTED closure
    /// (a <c>distinctBy</c> selector lambda). TypeScript's control-flow narrowing of the outer
    /// <c>this.qty !== undefined</c> guard does not cross that closure boundary, so <c>this.qty</c>
    /// still type-checks as <c>number | undefined</c> at the point the arithmetic renders it — a bare
    /// <c>Decimal.fromInt(this.qty)</c> is a real <c>tsc</c> TS2345 here (confirmed pre-fix), unlike
    /// the member-level guard above. The fix must map the WHOLE method call over the optional rather
    /// than widen in place. <c>distinctBy</c> is chosen (over <c>sum</c>/<c>max</c>) because its
    /// <c>structuralEquals</c>-based lowering accepts the selector's value opaquely, so this isolates
    /// the arithmetic-widening defect from the unrelated selector-type-cast gap in <c>sum</c>/<c>max</c>
    /// (filed as a follow-up, not part of this issue's scope).
    /// </summary>
    [Fact]
    public void DecimalPlusGuardedOptionalIntMember_InsideNestedClosure_MapsOverTheOptional()
    {
        const string src =
            """
            context Shop {
              value Order {
                rate:        Decimal
                qty:         Int?
                rates:       List<Decimal>
                allDistinct: Bool = if qty.isPresent then rates.distinctBy(r => qty + r) else true
              }
            }
            """;

        var result = new KoineCompiler().Compile(src, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var order = result.Files.Single(f => f.RelativePath.EndsWith("Order.ts")).Contents;
        order.ShouldNotContain("Decimal.fromInt(this.qty).add(r))");

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoTscNotice);
        check.Ok.ShouldBeTrue(
            "a guarded optional Int member used inside a nested closure must still type-check under tsc --strict:\n"
            + string.Join("\n", check.Errors));
    }

    /// <summary>
    /// #1556 — the follow-up the comment above points to: <c>sum</c>/<c>max</c> selector-type-cast
    /// gap. `ExpressionChecker.CheckAggregateSelector` now rejects any <c>sum</c>/<c>min</c>/<c>max</c>
    /// selector whose inferred type is optional (KOI0404) at semantic validation, so the TS emitter
    /// never has to render the broken <c>readonly Decimal | undefined[]</c> cast this repro used to
    /// produce. Pinned by the exact message so this doesn't regress to a generic/wrong diagnostic.
    /// </summary>
    [Fact]
    public void Sum_over_a_guard_narrowed_optional_selector_is_rejected_before_reaching_the_ts_emitter()
    {
        const string src =
            """
            context Shop {
              value Order {
                rate:   Decimal
                qty:    Int?
                rates:  List<Decimal>
                total:  Decimal? = if qty.isPresent then rates.sum(r => qty + r) else rate
              }
            }
            """;

        var result = new KoineCompiler().Compile(src, new TypeScriptEmitter());
        result.Success.ShouldBeFalse();
        result.Diagnostics.ShouldContain(d =>
            d.Message == "sum requires a non-optional selector; guard with isPresent or use '??' before folding");
    }
}
