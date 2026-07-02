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
}
