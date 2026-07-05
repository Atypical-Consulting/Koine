using System.Globalization;
using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// The value-object slice of <see cref="PhpEmitter"/>. A Koine <c>value</c> emits as a PHP 8.1
/// <c>final class</c> with <c>public readonly</c> typed constructor-promoted properties, an explicit
/// constructor that assigns the fields then evaluates invariants (throwing
/// <c>\Koine\Runtime\DomainInvariantViolationException</c> on failure), derived members as getter
/// methods, and a structural <c>equals(self $other): bool</c>.
/// <para>
/// A <c>quantity</c> additionally gets unit-checked <c>add()</c>/<c>subtract()</c> and scalar
/// <c>multipliedBy()</c>/<c>dividedBy()</c> methods — the PHP equivalent of the Python
/// <c>__add__</c>/<c>__mul__</c> dunders and the C# operator overloads.
/// </para>
/// </summary>
public sealed partial class PhpEmitter
{
    private EmittedFile EmitValueObject(PhpEmitContext emit, ValueObjectDecl vo, string contextName, PhpTypeMapper typeMapper)
    {
        var name = PhpNaming.ClassName(vo.Name);
        var memberNames = new HashSet<string>(vo.Members.Select(m => m.Name), StringComparer.Ordinal);

        // Stored members go into the constructor; derived members become getter methods.
        var fields = vo.Members.Where(m => !MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var derived = vo.Members.Where(m => MemberAnalysis.IsDerived(m, memberNames)).ToList();

        var translator = new PhpExpressionTranslator(
            emit.Index,
            vo.Members,
            emit.EnumMemberToType,
            regexMatchTimeoutMs: _options.RegexMatchTimeoutMs);

        // Classifies a field's type for `equals()`: a value object / id value object compares
        // structurally (via its own `equals()`), a primitive/enum by value (`===`) — see #686.
        var resolver = new TypeResolver(emit.Index);

        // This value object's full operator demand, resolved once from the analyzer's single-pass model
        // (#836): the scalar multiply factors, the `sum`-fold `Summable` flag, the plain binary `+`/`-`
        // ops, and the precomputed `add`-need union. `null` = this VO needs no generated arithmetic.
        var needs = emit.OperatorNeeds.GetValueOrDefault(vo.Name);

        // A value object folded with `sum` implements the runtime `Summable` seam so the generic
        // `Decimal::sum(@template T of Summable)` helper preserves its type under phpstan --level max
        // (issue #692). `add()` is already emitted demand-driven (WriteAdditiveOp / WriteQuantityOps);
        // implementing the interface only adds the `implements` clause and widens `add()`'s parameter
        // to the interface type (PHP forbids narrowing it to the concrete class on an implementer).
        bool isSummable = needs?.IsSummable ?? false;

        var sb = new StringBuilder();

        WriteDoc(sb, vo.Doc, "");

        sb.Append("final class ").Append(name);
        if (isSummable)
        {
            sb.Append(" implements \\Koine\\Runtime\\Summable");
        }

        sb.Append('\n');
        sb.Append("{\n");

        // Constructor with promoted readonly properties.
        WriteConstructor(sb, name, fields, vo.Invariants, translator, typeMapper);

        // Derived (computed) members as public getter methods.
        foreach (Member m in derived)
        {
            sb.Append('\n');
            WriteMethodDoc(sb, Indent, typeMapper, NoDocParams, m.Type, m.Doc);
            var methodName = PhpNaming.MethodName(m.Name);
            var returnType = typeMapper.Map(m.Type);
            sb.Append(Indent).Append("public function ").Append(methodName).Append("(): ").Append(returnType).Append('\n');
            sb.Append(Indent).Append("{\n");
            sb.Append(Indent).Append(Indent).Append("return ")
              .Append(translator.Translate(m.Initializer!)).Append(";\n");
            sb.Append(Indent).Append("}\n");
        }

        // Structural equals method.
        sb.Append('\n');
        WriteEquals(sb, fields, resolver);

        // Quantity-specific arithmetic methods.
        if (vo.IsQuantity)
        {
            WriteQuantityOps(sb, name, fields, isSummable);
        }
        else
        {
            // Demand-driven scalar multiply (only when the model actually multiplies this VO by a scalar).
            if (needs is { MultiplyFactors.Count: > 0 }
                && fields.Any(m => m.Type.Name is "Int" or "Decimal"))
            {
                WriteScalarOp(sb, fields);
            }

            // Demand-driven `add`. The analyzer pre-computes the union of the two demands —
            // `needs.NeedsAdd` = a `sum`-fold (issue #692) OR a plain binary `+` (issue #813) — so the
            // emitter no longer recombines two maps itself (#836). `isSummable` (kept distinct by the
            // analyzer) selects the SHAPE: a summed VO routes its `add` through the `Summable` seam (an
            // interface-typed parameter, WriteAdditiveOp); a binary-only VO gets a concrete `add(self)`.
            // Exactly one `add` is emitted, so the previous duplicate-`add` suppression is now structural.
            if (needs?.NeedsAdd == true)
            {
                if (isSummable)
                {
                    WriteAdditiveOp(sb, fields);
                }
                else
                {
                    WriteValueObjectAdditiveMethod(sb, fields, "add", "add", "+");
                }
            }

            // Demand-driven `subtract` — `base - base` (issue #813). Never part of the `Summable` seam, so
            // it is emitted purely on the binary `-` demand.
            if (needs is not null && needs.BinaryOps.Contains(BinaryOp.Sub))
            {
                WriteValueObjectAdditiveMethod(sb, fields, "subtract", "sub", "-");
            }
        }

        sb.Append("}\n");

        return new EmittedFile(
            PathFor(contextName, KindFolder.ValueObjects, vo.Name),
            Assemble(contextName, KindFolder.ValueObjects, sb.ToString(), name));
    }

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    private static void WriteConstructor(
        StringBuilder sb,
        string className,
        IReadOnlyList<Member> fields,
        IReadOnlyList<Invariant> invariants,
        PhpExpressionTranslator translator,
        PhpTypeMapper typeMapper)
    {
        // Defaulted/optional members move last so PHP never sees a required parameter after an
        // optional one (phpstan `parameter.requiredAfterOptional`); declaration order is preserved
        // within each group (stable sort), matching the C# emitter.
        var ordered = OrderCtorParams(fields).ToList();

        // PHPDoc refines a promoted property whose native hint loses type info: a generic `Range<T>`
        // (e.g. `@param Range<\DateTimeImmutable> $window`) or a bare collection `array`. On a promoted
        // constructor parameter the `@param` types both the parameter and the property for phpstan.
        var docParams = ordered
            .Select(m => (PhpNaming.EscapeIdentifier(PhpNaming.PropertyName(m.Name)), m.Type))
            .ToList();
        WriteMethodDoc(sb, Indent, typeMapper, docParams, null, null);

        sb.Append(Indent).Append("public function __construct(\n");

        // Constructor-promoted readonly properties for all stored fields.
        for (int i = 0; i < ordered.Count; i++)
        {
            Member m = ordered[i];
            var propName = PhpNaming.EscapeIdentifier(PhpNaming.PropertyName(m.Name));
            var typeName = typeMapper.Map(m.Type);
            sb.Append(Indent).Append(Indent).Append("public readonly ").Append(typeName).Append(" $").Append(propName);
            // Default value for constant-initializer fields (not derived, but has an initializer).
            // A Decimal default is folded first (FoldDecimalConstantDefault, issue #971) so a
            // computed value never reaches this PHP constant-required position as a method-call
            // chain; every other type's arithmetic already renders as native PHP operators, which
            // are valid constant expressions as-is.
            if (m.Initializer is not null && !MemberAnalysis.IsDerived(m, fields.Select(f => f.Name).ToHashSet()))
            {
                var initializer = m.Type.Name == "Decimal" ? FoldDecimalConstantDefault(m.Initializer) : m.Initializer;
                var defaultVal = translator.Translate(initializer, PhpExpressionTranslator.NameMode.Parameter);
                sb.Append(" = ").Append(defaultVal);
            }
            else if (m.Type.IsOptional)
            {
                sb.Append(" = null");
            }
            var sep = i < ordered.Count - 1 ? "," : "";
            sb.Append(sep).Append('\n');
        }

        sb.Append(Indent).Append(") {\n");

        // Invariant checks inside the constructor body.
        foreach (Invariant inv in invariants)
        {
            WriteInvariantGuard(sb, className, inv, translator);
        }

        sb.Append(Indent).Append("}\n");
    }

    // -------------------------------------------------------------------------
    // Computed Decimal constant defaults (issue #971)
    // -------------------------------------------------------------------------

    // PHP only permits constant expressions in a constructor-promoted property/parameter default.
    // PhpExpressionTranslator.WriteDecimalBinary always lowers Decimal arithmetic to a runtime
    // method-call chain (`->add(...)`/`->sub(...)`/…) — never a constant expression — so a Decimal
    // member whose default is COMPUTED (e.g. `amount: Decimal = 0.1 + 0.05`) would otherwise land
    // invalid PHP in the default position. A non-derived initializer can never reference another
    // member — that is what makes it non-derived — so the only way it can be non-literal is pure
    // arithmetic over Int/Decimal literals, which is always foldable to a single value at emit time.
    // Folding always re-boxes as a Decimal literal (never Int) so the folded value matches the
    // declared Decimal property/parameter type. A bare DECIMAL-kind literal default is already valid
    // PHP (a `new` expression, legal via PHP 8.1's "new in initializers") and is returned unchanged;
    // a bare Int-kind literal on a Decimal member (e.g. `amount: Decimal = 5`) falls through to
    // TryFoldNumericLiteral below, which re-boxes it as a Decimal literal too (issue #1030).
    private static Expr FoldDecimalConstantDefault(Expr expr)
    {
        if (expr is LiteralExpr { Kind: LiteralKind.Decimal })
        {
            return expr;
        }

        try
        {
            return TryFoldNumericLiteral(expr, out decimal value)
                ? new LiteralExpr(LiteralKind.Decimal, value.ToString(CultureInfo.InvariantCulture))
                : expr;
        }
        catch (OverflowException)
        {
            // An overflowing fold is "not constant" — fall back to the original expression rather
            // than throw, mirroring Semantics.ConstantFolder's never-throw discipline.
            return expr;
        }
    }

    private static bool TryFoldNumericLiteral(Expr expr, out decimal value)
    {
        switch (expr)
        {
            case LiteralExpr { Kind: LiteralKind.Int or LiteralKind.Decimal } lit
                when decimal.TryParse(lit.Text, NumberStyles.Number | NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out value):
                return true;

            case UnaryExpr { Op: UnaryOp.Negate } un when TryFoldNumericLiteral(un.Operand, out decimal v):
                value = -v;
                return true;

            case BinaryExpr { Op: BinaryOp.Add } bin
                when TryFoldNumericLiteral(bin.Left, out decimal l) && TryFoldNumericLiteral(bin.Right, out decimal r):
                value = l + r;
                return true;

            case BinaryExpr { Op: BinaryOp.Sub } bin
                when TryFoldNumericLiteral(bin.Left, out decimal l) && TryFoldNumericLiteral(bin.Right, out decimal r):
                value = l - r;
                return true;

            case BinaryExpr { Op: BinaryOp.Mul } bin
                when TryFoldNumericLiteral(bin.Left, out decimal l) && TryFoldNumericLiteral(bin.Right, out decimal r):
                value = l * r;
                return true;

            // A literal-zero divisor (e.g. `amount: Decimal = 4 / 0`) has no representable quotient,
            // so it is "not constant" here too — matching Semantics.ConstantFolder's own div-by-zero
            // stance. This is a pre-existing, exceedingly narrow degenerate case (no legal PHP
            // constant expression can encode it either way) tracked as a follow-up rather than
            // fixed here: see the PR's Follow-ups section.
            case BinaryExpr { Op: BinaryOp.Div } bin
                when TryFoldNumericLiteral(bin.Left, out decimal l) && TryFoldNumericLiteral(bin.Right, out decimal r) && r != 0m:
                value = l / r;
                return true;

            default:
                value = 0;
                return false;
        }
    }

    // -------------------------------------------------------------------------
    // Invariant guard
    // -------------------------------------------------------------------------

    /// <summary>Emits one invariant guard in the constructor body (parameters → $camelParam).</summary>
    private static void WriteInvariantGuard(
        StringBuilder sb, string typeName, Invariant inv, PhpExpressionTranslator translator)
    {
        const PhpExpressionTranslator.NameMode mode = PhpExpressionTranslator.NameMode.Parameter;

        string test;
        if (inv.Condition is GuardExpr guard)
        {
            // `when guard: body` → check only when guard holds.
            var guardStr = translator.Translate(guard.Condition, mode);
            var bodyNeg = translator.TranslateNegated(guard.Body, mode);
            test = guardStr + " && " + bodyNeg;
        }
        else
        {
            test = translator.TranslateNegated(inv.Condition, mode);
        }

        sb.Append(Indent).Append(Indent).Append("if (").Append(test).Append(") {\n");
        sb.Append(Indent).Append(Indent).Append(Indent)
          .Append("throw new \\Koine\\Runtime\\DomainInvariantViolationException(")
          .Append('"').Append(typeName).Append('"')
          .Append(", ")
          .Append(RuleLiteral(inv.Message ?? "invariant failed"))
          .Append(");\n");
        sb.Append(Indent).Append(Indent).Append("}\n");
    }

    // -------------------------------------------------------------------------
    // Equals
    // -------------------------------------------------------------------------

    private static void WriteEquals(StringBuilder sb, IReadOnlyList<Member> fields, TypeResolver resolver)
    {
        sb.Append(Indent).Append("public function equals(self $other): bool\n");
        sb.Append(Indent).Append("{\n");

        if (fields.Count == 0)
        {
            sb.Append(Indent).Append(Indent).Append("return true;\n");
        }
        else
        {
            sb.Append(Indent).Append(Indent).Append("return ");
            for (int i = 0; i < fields.Count; i++)
            {
                Member field = fields[i];
                var prop = PhpNaming.EscapeIdentifier(PhpNaming.PropertyName(field.Name));

                // A field whose type carries a structural `equals()` — `Decimal` (a runtime class) or a
                // value object / id value object — must be compared via that `equals()`, never PHP
                // `===`, which is reference identity for objects (#686). Primitives/enums keep `===`
                // (value equality). Nested recursion is automatic: each nested VO's own `equals()`
                // applies the same rule, matching C# record equality.
                bool structural = field.Type.Name == "Decimal" || resolver.IsValueLike(field.Type);
                if (structural)
                {
                    var lhs = "$this->" + prop;
                    var rhs = "$other->" + prop;
                    if (field.Type.IsOptional)
                    {
                        // The generated `equals(self $other)` is non-nullable, so guard nulls first:
                        // two nulls are equal, a present-vs-null pair is unequal, two present values
                        // compare structurally.
                        sb.Append('(').Append(lhs).Append(" === null ? ").Append(rhs).Append(" === null : (")
                          .Append(rhs).Append(" !== null && ").Append(lhs).Append("->equals(").Append(rhs).Append(")))");
                    }
                    else
                    {
                        sb.Append(lhs).Append("->equals(").Append(rhs).Append(')');
                    }
                }
                else
                {
                    sb.Append("$this->").Append(prop).Append(" === $other->").Append(prop);
                }
                if (i < fields.Count - 1)
                {
                    sb.Append("\n").Append(Indent).Append(Indent).Append(Indent).Append("&& ");
                }
            }
            sb.Append(";\n");
        }

        sb.Append(Indent).Append("}\n");
    }

    // -------------------------------------------------------------------------
    // Quantity arithmetic methods
    // -------------------------------------------------------------------------

    /// <summary>
    /// Emits unit-checked <c>add()</c>/<c>subtract()</c> and scalar
    /// <c>multipliedBy()</c>/<c>dividedBy()</c> on a quantity value object.
    /// </summary>
    private static void WriteQuantityOps(
        StringBuilder sb, string name,
        IReadOnlyList<Member> fields,
        bool isSummable)
    {
        Member? amount = fields.FirstOrDefault(m => m.Type.Name == "Decimal" && !m.Type.IsOptional);
        Member? unit = fields.FirstOrDefault(m => !ReferenceEquals(m, amount) && !m.Type.IsOptional);
        if (amount is null || unit is null)
        {
            return;
        }

        var amt = PhpNaming.EscapeIdentifier(PhpNaming.PropertyName(amount.Name));
        var u = PhpNaming.EscapeIdentifier(PhpNaming.PropertyName(unit.Name));

        // Build a constructor call placing amount/unit at their positions in the reordered ctor
        // signature (defaulted/optional params last), so the positional args line up.
        string Construct(string amtExpr, string unitExpr) =>
            "new self(" + string.Join(", ", OrderCtorParams(fields).Select(m =>
                ReferenceEquals(m, amount) ? amtExpr
                : ReferenceEquals(m, unit) ? unitExpr
                : "$this->" + PhpNaming.EscapeIdentifier(PhpNaming.PropertyName(m.Name)))) + ")";

        // add() and subtract() — unit-checked.
        foreach (var (methodName, verb, op) in new[] {
            ("add", "add", "+"),
            ("subtract", "subtract", "-") })
        {
            sb.Append('\n');
            // A summed quantity implements `Summable`, so its `add()` takes the interface type (PHP
            // forbids narrowing it to the concrete class) with `@param self` narrowing it back for the
            // body; `subtract()` is not part of the interface and keeps the concrete `self` parameter.
            if (methodName == "add" && isSummable)
            {
                sb.Append(Indent).Append("/** @param self $other */\n");
                sb.Append(Indent).Append("public function add(\\Koine\\Runtime\\Summable $other): self\n");
            }
            else
            {
                sb.Append(Indent).Append("public function ").Append(methodName).Append("(self $other): self\n");
            }

            sb.Append(Indent).Append("{\n");
            sb.Append(Indent).Append(Indent).Append("if ($this->").Append(u).Append(" !== $other->").Append(u).Append(") {\n");
            sb.Append(Indent).Append(Indent).Append(Indent)
              .Append("throw new \\Koine\\Runtime\\DomainInvariantViolationException(\"").Append(name)
              .Append("\", \"cannot ").Append(verb).Append(" quantities of different units\");\n");
            sb.Append(Indent).Append(Indent).Append("}\n");

            // Use Decimal->add() / ->sub() (not PHP + / -) since Decimal is our runtime type.
            string amtExpr = op == "+" ? "$this->" + amt + "->add($other->" + amt + ")" : "$this->" + amt + "->sub($other->" + amt + ")";
            sb.Append(Indent).Append(Indent).Append("return ")
              .Append(Construct(amtExpr, "$this->" + u)).Append(";\n");
            sb.Append(Indent).Append("}\n");
        }

        // multipliedBy() and dividedBy() — scalar scaling.
        foreach (var (methodName, decimalOp) in new[] { ("multipliedBy", "mul"), ("dividedBy", "div") })
        {
            sb.Append('\n');
            sb.Append(Indent).Append("public function ").Append(methodName)
              .Append(@"(\Koine\Runtime\Decimal $factor): self").Append('\n');
            sb.Append(Indent).Append("{\n");
            sb.Append(Indent).Append(Indent).Append("return ")
              .Append(Construct("$this->" + amt + "->" + decimalOp + "($factor)", "$this->" + u)).Append(";\n");
            sb.Append(Indent).Append("}\n");
        }
    }

    // -------------------------------------------------------------------------
    // Demand-driven scalar multiply (non-quantity value objects)
    // -------------------------------------------------------------------------

    private static void WriteScalarOp(
        StringBuilder sb,
        IReadOnlyList<Member> fields)
    {
        var numeric = new HashSet<string>(
            fields.Where(m => m.Type.Name is "Int" or "Decimal").Select(m => m.Name),
            StringComparer.Ordinal);

        // multipliedBy() and dividedBy() — scalar scaling (mirrors the WriteQuantityOps pattern).
        foreach (var (methodName, decimalOp) in new[] { ("multipliedBy", "mul"), ("dividedBy", "div") })
        {
            sb.Append('\n');
            sb.Append(Indent).Append("public function ").Append(methodName)
              .Append(@"(\Koine\Runtime\Decimal $factor): self").Append('\n');
            sb.Append(Indent).Append("{\n");

            WriteFieldwiseSelf(sb, fields, m =>
            {
                var prop = PhpNaming.EscapeIdentifier(PhpNaming.PropertyName(m.Name));
                if (!numeric.Contains(m.Name))
                {
                    return "$this->" + prop;
                }

                // Decimal: use the runtime op directly; Int: cast to Decimal via runtime for consistency.
                return m.Type.Name == "Decimal"
                    ? "$this->" + prop + "->" + decimalOp + "($factor)"
                    : "(new \\Koine\\Runtime\\Decimal($this->" + prop + "))->" + decimalOp + "($factor)";
            });

            sb.Append(Indent).Append("}\n");
        }
    }

    // -------------------------------------------------------------------------
    // Demand-driven additive (non-quantity value objects, used in sum() folds)
    // -------------------------------------------------------------------------

    private static void WriteAdditiveOp(StringBuilder sb, IReadOnlyList<Member> fields)
    {
        var numeric = new HashSet<string>(
            fields.Where(m => m.Type.Name is "Int" or "Decimal").Select(m => m.Name),
            StringComparer.Ordinal);

        sb.Append('\n');
        // The native parameter is the `Summable` interface (the class `implements` it) — PHP forbids an
        // implementer from narrowing it to the concrete class — and `@param self` narrows it back so the
        // body's `$other->prop` access stays phpstan --level max clean (issue #692).
        sb.Append(Indent).Append("/** @param self $other */\n");
        sb.Append(Indent).Append("public function add(\\Koine\\Runtime\\Summable $other): self\n");
        sb.Append(Indent).Append("{\n");

        WriteFieldwiseSelf(sb, fields, m =>
        {
            var prop = PhpNaming.EscapeIdentifier(PhpNaming.PropertyName(m.Name));
            if (!numeric.Contains(m.Name))
            {
                return "$this->" + prop;
            }

            return m.Type.Name == "Decimal"
                ? "$this->" + prop + "->add($other->" + prop + ")"
                : "$this->" + prop + " + $other->" + prop;
        });

        sb.Append(Indent).Append("}\n");
    }

    // -------------------------------------------------------------------------
    // Demand-driven plain binary arithmetic (non-quantity value objects, used in `value + value`)
    // -------------------------------------------------------------------------

    /// <summary>
    /// Writes one concrete <c>methodName(self $other): self</c> that combines this value object with
    /// another field-by-field: a <c>Decimal</c> field delegates to the runtime Decimal's
    /// <paramref name="decimalMethod"/> (<c>add</c>/<c>sub</c>), an <c>Int</c> field uses the native PHP
    /// <paramref name="intOp"/> (<c>+</c>/<c>-</c>), and any other field is carried through from
    /// <c>$this</c> unchanged. Positional constructor args follow the reordered ctor signature
    /// (defaulted/optional last), matching <see cref="WriteScalarOp"/> / <see cref="WriteAdditiveOp"/>.
    /// </summary>
    private static void WriteValueObjectAdditiveMethod(
        StringBuilder sb, IReadOnlyList<Member> fields, string methodName, string decimalMethod, string intOp)
    {
        var numeric = new HashSet<string>(
            fields.Where(m => m.Type.Name is "Int" or "Decimal").Select(m => m.Name),
            StringComparer.Ordinal);

        sb.Append('\n');
        sb.Append(Indent).Append("public function ").Append(methodName).Append("(self $other): self\n");
        sb.Append(Indent).Append("{\n");

        WriteFieldwiseSelf(sb, fields, m =>
        {
            var prop = PhpNaming.EscapeIdentifier(PhpNaming.PropertyName(m.Name));
            if (!numeric.Contains(m.Name))
            {
                return "$this->" + prop;
            }

            return m.Type.Name == "Decimal"
                ? "$this->" + prop + "->" + decimalMethod + "($other->" + prop + ")"
                : "$this->" + prop + " " + intOp + " $other->" + prop;
        });

        sb.Append(Indent).Append("}\n");
    }

    /// <summary>
    /// Writes a <c>return new self(&lt;args&gt;);</c> body whose positional arguments follow the reordered
    /// constructor signature (defaulted/optional last, via <see cref="OrderCtorParams"/>) — one per field,
    /// each produced by <paramref name="argFor"/>. Shared by the demand-driven arithmetic emitters
    /// (<see cref="WriteScalarOp"/>, <see cref="WriteAdditiveOp"/>,
    /// <see cref="WriteValueObjectAdditiveMethod"/>) so the field-wise reconstruction lives in one place;
    /// each caller supplies only the per-field argument expression.
    /// </summary>
    private static void WriteFieldwiseSelf(StringBuilder sb, IReadOnlyList<Member> fields, Func<Member, string> argFor)
    {
        sb.Append(Indent).Append(Indent).Append("return new self(\n");

        var ordered = OrderCtorParams(fields).ToList();
        for (int i = 0; i < ordered.Count; i++)
        {
            var arg = argFor(ordered[i]);
            var sep = i < ordered.Count - 1 ? "," : "";
            sb.Append(Indent).Append(Indent).Append(Indent).Append(arg).Append(sep).Append('\n');
        }

        sb.Append(Indent).Append(Indent).Append(");\n");
    }
}
