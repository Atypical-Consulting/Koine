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
        WriteEquals(sb, fields);

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

            // Demand-driven additive (only when the model sums this VO).
            if (emit.AdditiveNeeds.Contains(vo.Name))
            {
                WriteAdditiveOp(sb, fields);
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

    private static void WriteEquals(StringBuilder sb, IReadOnlyList<Member> fields)
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
                var prop = PhpNaming.EscapeIdentifier(PhpNaming.PropertyName(fields[i].Name));
                // Decimal uses its own equals(); everything else uses ===.
                if (fields[i].Type.Name == "Decimal")
                {
                    sb.Append("$this->").Append(prop).Append("->equals($other->").Append(prop).Append(')');
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
        sb.Append(Indent).Append(Indent).Append("return new self(\n");

        // Positional args must follow the reordered ctor signature (defaulted/optional last).
        var ordered = OrderCtorParams(fields).ToList();
        for (int i = 0; i < ordered.Count; i++)
        {
            Member m = ordered[i];
            var prop = PhpNaming.EscapeIdentifier(PhpNaming.PropertyName(m.Name));
            string arg;
            if (numeric.Contains(m.Name))
            {
                // Decimal: use ->mul(); Int: cast to Decimal via runtime for consistency
                if (m.Type.Name == "Decimal")
                {
                    arg = "$this->" + prop + "->mul($factor)";
                }
                else
                {
                    // Int field — wrap then multiply
                    arg = "(new \\Koine\\Runtime\\Decimal($this->" + prop + "))->mul($factor)";
                }
            }
            else
            {
                arg = "$this->" + prop;
            }
            var sep = i < ordered.Count - 1 ? "," : "";
            sb.Append(Indent).Append(Indent).Append(Indent).Append(arg).Append(sep).Append('\n');
        }

        sb.Append(Indent).Append(Indent).Append(");\n");
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
        sb.Append(Indent).Append(Indent).Append("return new self(\n");

        // Positional args must follow the reordered ctor signature (defaulted/optional last).
        var ordered = OrderCtorParams(fields).ToList();
        for (int i = 0; i < ordered.Count; i++)
        {
            Member m = ordered[i];
            var prop = PhpNaming.EscapeIdentifier(PhpNaming.PropertyName(m.Name));
            string arg;
            if (numeric.Contains(m.Name))
            {
                if (m.Type.Name == "Decimal")
                {
                    arg = "$this->" + prop + "->add($other->" + prop + ")";
                }
                else
                {
                    arg = "$this->" + prop + " + $other->" + prop;
                }
            }
            else
            {
                arg = "$this->" + prop;
            }
            var sep = i < ordered.Count - 1 ? "," : "";
            sb.Append(Indent).Append(Indent).Append(Indent).Append(arg).Append(sep).Append('\n');
        }

        sb.Append(Indent).Append(Indent).Append(");\n");
        sb.Append(Indent).Append("}\n");
    }
}
