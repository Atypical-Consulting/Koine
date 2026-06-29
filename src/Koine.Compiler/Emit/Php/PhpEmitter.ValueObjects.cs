using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Php;

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
            emit.EnumMemberToType);

        // Classifies a field's type for `equals()`: a value object / id value object compares
        // structurally (via its own `equals()`), a primitive/enum by value (`===`) — see #686.
        var resolver = new TypeResolver(emit.Index);

        // A value object folded with `sum` implements the runtime `Summable` seam so the generic
        // `Decimal::sum(@template T of Summable)` helper preserves its type under phpstan --level max
        // (issue #692). `add()` is already emitted demand-driven (WriteAdditiveOp / WriteQuantityOps);
        // implementing the interface only adds the `implements` clause and widens `add()`'s parameter
        // to the interface type (PHP forbids narrowing it to the concrete class on an implementer).
        bool isSummable = emit.AdditiveNeeds.Contains(vo.Name);

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
            // Demand-driven scalar multiply (only when the model actually uses it).
            if (emit.ScalarNeeds.ContainsKey(vo.Name)
                && fields.Any(m => m.Type.Name is "Int" or "Decimal"))
            {
                WriteScalarOp(sb, fields);
            }

            // Demand-driven additive (only when the model sums this VO). A summed VO is exactly a
            // Summable VO (`isSummable`), and gets its `add` via the Summable seam here.
            if (isSummable)
            {
                WriteAdditiveOp(sb, fields);
            }

            // Demand-driven plain binary value-object arithmetic — `base + base` / `base - base`
            // (issue #813). A summed VO already got its `add` from WriteAdditiveOp, so suppress the
            // duplicate; `subtract` is never part of the Summable seam and is emitted on demand.
            if (emit.BinaryArithmeticNeeds.TryGetValue(vo.Name, out IReadOnlySet<BinaryOp>? arithmeticOps))
            {
                WriteBinaryArithmeticOps(sb, fields, arithmeticOps, isSummable);
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
            if (m.Initializer is not null && !MemberAnalysis.IsDerived(m, fields.Select(f => f.Name).ToHashSet()))
            {
                var defaultVal = translator.Translate(m.Initializer, PhpExpressionTranslator.NameMode.Parameter);
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

        sb.Append('\n');
        sb.Append(Indent).Append(@"public function multipliedBy(\Koine\Runtime\Decimal $factor): self").Append('\n');
        sb.Append(Indent).Append("{\n");

        WriteFieldwiseSelf(sb, fields, m =>
        {
            var prop = PhpNaming.EscapeIdentifier(PhpNaming.PropertyName(m.Name));
            if (!numeric.Contains(m.Name))
            {
                return "$this->" + prop;
            }

            // Decimal: use ->mul(); Int: cast to Decimal via runtime for consistency, then multiply.
            return m.Type.Name == "Decimal"
                ? "$this->" + prop + "->mul($factor)"
                : "(new \\Koine\\Runtime\\Decimal($this->" + prop + "))->mul($factor)";
        });

        sb.Append(Indent).Append("}\n");
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
    /// Emits the concrete arithmetic methods a value object needs because the model uses it directly in
    /// a plain <c>value + value</c> / <c>value - value</c> expression (issue #813) — as opposed to a
    /// <c>sum</c> fold (<see cref="WriteAdditiveOp"/>) or a scalar scale (<see cref="WriteScalarOp"/>).
    /// The lowered call site (<c>$vo-&gt;add(...)</c>) is produced by
    /// <see cref="PhpExpressionTranslator"/>; without these methods it targets an undefined method.
    /// <paramref name="hasSummableAdd"/> suppresses a duplicate <c>add</c> when the value object is also
    /// summed (and so already implements <c>Summable</c> with its own <c>add</c>).
    /// </summary>
    private static void WriteBinaryArithmeticOps(
        StringBuilder sb, IReadOnlyList<Member> fields, IReadOnlySet<BinaryOp> ops, bool hasSummableAdd)
    {
        if (ops.Contains(BinaryOp.Add) && !hasSummableAdd)
        {
            WriteValueObjectAdditiveMethod(sb, fields, "add", "add", "+");
        }

        if (ops.Contains(BinaryOp.Sub))
        {
            WriteValueObjectAdditiveMethod(sb, fields, "subtract", "sub", "-");
        }
    }

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
